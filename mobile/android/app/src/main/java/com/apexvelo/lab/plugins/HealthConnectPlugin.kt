package com.apexvelo.lab.plugins

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Instant
import kotlin.reflect.KClass

/**
 * Health Connect for the JS layer (src/native-healthconnect.js wraps it). Record types are named as in
 * HealthRecords; times are epoch milliseconds. The changes token lives here (HealthChanges) so the daily
 * background job can keep it fresh while the app is closed.
 */
@CapacitorPlugin(name = "HealthConnect")
class HealthConnectPlugin : Plugin() {
    companion object {
        const val PROVIDER = "com.google.android.apps.healthdata"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val contract = PermissionController.createRequestPermissionResultContract()

    private fun client() = HealthConnectClient.getOrCreate(context)

    /** Health Connect needs Android 9 (API 28); on 9-13 it is an app from Play, on 14+ part of Android. */
    private fun sdkStatus(): Int = if (Build.VERSION.SDK_INT < 28) HealthConnectClient.SDK_UNAVAILABLE else HealthConnectClient.getSdkStatus(context, PROVIDER)

    private fun withHc(call: PluginCall, block: suspend () -> Unit) {
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect is not available on this phone.", "UNAVAILABLE"); return }
        scope.launch {
            try { block() } catch (e: SecurityException) { call.reject(e.message ?: "Permission missing", "PERMISSION", e) } catch (e: Exception) { call.reject(e.message ?: e.toString(), e) }
        }
    }

    private fun feature(f: Int) = client().features.getFeatureStatus(f) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE

    @PluginMethod
    fun availability(call: PluginCall) {
        val status = sdkStatus()
        val out = JSObject()
        out.put("status", when {
            status == HealthConnectClient.SDK_AVAILABLE -> "available"
            status == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
            Build.VERSION.SDK_INT in 28..33 -> "not_installed"
            else -> "unsupported"
        })
        if (status == HealthConnectClient.SDK_AVAILABLE) {
            out.put("history", feature(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY))
            out.put("background", feature(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND))
        }
        call.resolve(out)
    }

    /** Opens Health Connect in Play (install or update, Android 13 and older). */
    @PluginMethod
    fun openInstall(call: PluginCall) {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PROVIDER&url=healthconnect%3A%2F%2Fonboarding")).setPackage("com.android.vending").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { context.startActivity(market) } catch (e: ActivityNotFoundException) {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$PROVIDER")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        call.resolve()
    }

    /** Health Connect's own screen for this app's data and permissions. */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect is not available on this phone.", "UNAVAILABLE"); return }
        context.startActivity(HealthConnectClient.getHealthConnectManageDataIntent(context, PROVIDER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    private fun wanted(call: PluginCall): Set<String> {
        val out = mutableSetOf<String>()
        call.getArray("read", JSArray())?.toList<String>()?.forEach { t -> HealthRecords.readPermission(t)?.let { out.add(it) } }
        call.getArray("write", JSArray())?.toList<String>()?.forEach { t -> HealthRecords.writePermission(t)?.let { out.add(it) } }
        if (call.getBoolean("history", false) == true && feature(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)) out.add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
        if (call.getBoolean("background", false) == true && feature(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)) out.add(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
        return out
    }

    private suspend fun granted(): JSObject {
        val g = client().permissionController.getGrantedPermissions()
        return JSObject()
            .put("read", JSArray(HealthRecords.READ.keys.filter { HealthRecords.readPermission(it) in g }))
            .put("write", JSArray(HealthRecords.WRITE.keys.filter { HealthRecords.writePermission(it) in g }))
            .put("history", HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in g)
            .put("background", HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in g)
    }

    @PluginMethod
    fun grantedHealthPermissions(call: PluginCall) = withHc(call) { call.resolve(granted()) }

    /** Health Connect's permission screen for the types asked for ({ read, write, history, background }). */
    @PluginMethod
    fun requestHealthPermissions(call: PluginCall) {
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect is not available on this phone.", "UNAVAILABLE"); return }
        val perms = wanted(call)
        if (perms.isEmpty()) { withHc(call) { call.resolve(granted()) }; return }
        startActivityForResult(call, contract.createIntent(context, perms), "permissionResult")
    }

    @ActivityCallback
    private fun permissionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        contract.parseResult(result.resultCode, result.data)
        withHc(call) { call.resolve(granted()) }
    }

    /** Revokes every Health Connect permission and forgets the changes token. */
    @PluginMethod
    fun disconnect(call: PluginCall) = withHc(call) {
        client().permissionController.revokeAllPermissions()
        HealthChanges(context).forget()
        HealthSyncWorker.schedule(context, false)
        call.resolve()
    }

    /** { type, start, end, origin?, pageToken?, pageSize? } -> { records, pageToken }, oldest first. */
    @PluginMethod
    fun readRecords(call: PluginCall) = withHc(call) {
        @Suppress("UNCHECKED_CAST")
        val cls = (HealthRecords.READ[call.getString("type")] ?: throw IllegalArgumentException("Unknown record type ${call.getString("type")}")) as KClass<Record>
        val start = Instant.ofEpochMilli(call.getLong("start") ?: throw IllegalArgumentException("start is required"))
        val end = Instant.ofEpochMilli(call.getLong("end") ?: throw IllegalArgumentException("end is required"))
        val origin = call.getString("origin")
        val r = client().readRecords(ReadRecordsRequest(cls, TimeRangeFilter.between(start, end),
            dataOriginFilter = if (origin != null) setOf(DataOrigin(origin)) else emptySet(), ascendingOrder = true,
            pageSize = (call.getInt("pageSize") ?: 1000).coerceIn(1, 5000), pageToken = call.getString("pageToken")))
        val list = JSArray()
        for (rec in r.records) list.put(HealthRecords.toJson(rec))
        call.resolve(JSObject().put("records", list).put("pageToken", r.pageToken))
    }

    /**
     * Starts following changes from now (before a backfill, so nothing written during it is missed) for
     * { types }: the tracked types the rider allowed (a token cannot cover types without permission).
     */
    @PluginMethod
    fun startChanges(call: PluginCall) = withHc(call) {
        val asked = call.getArray("types", JSArray())?.toList<String>() ?: emptyList()
        HealthChanges(context).start(client(), HealthRecords.TRACKED.filter { it in asked })
        call.resolve()
    }

    /** Reads new changes into the pending list and returns it: { changes, hasToken, tokenExpired }. */
    @PluginMethod
    fun pendingChanges(call: PluginCall) = withHc(call) {
        val hc = HealthChanges(context)
        if (hc.hasToken()) hc.pull(client())
        val state = hc.pending.read()
        call.resolve(JSObject().put("changes", state.getJSONArray("changes")).put("hasToken", hc.hasToken())
            .put("tokenExpired", hc.tokenExpired() || state.optBoolean("overflow", false)))
    }

    /** Drops the pending changes up to `upTo` (their seq) once the app has stored them. */
    @PluginMethod
    fun ackChanges(call: PluginCall) {
        HealthChanges(context).pending.ack(call.getLong("upTo") ?: 0L)
        call.resolve()
    }

    /** A ride recorded in the app (see HealthRecords.rideRecords) -> { id } of the exercise session. */
    @PluginMethod
    fun writeRide(call: PluginCall) = withHc(call) {
        val r = client().insertRecords(HealthRecords.rideRecords(call.data))
        call.resolve(JSObject().put("id", r.recordIdsList.firstOrNull()))
    }

    /** Turns the daily background job on or off. */
    @PluginMethod
    fun setBackgroundSync(call: PluginCall) {
        HealthSyncWorker.schedule(context, call.getBoolean("on", false) == true)
        call.resolve()
    }
}
