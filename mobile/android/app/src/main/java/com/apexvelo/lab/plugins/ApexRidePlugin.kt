package com.apexvelo.lab.plugins

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.apexvelo.lab.ride.PlanStep
import com.apexvelo.lab.ride.RidePlan
import com.apexvelo.lab.ride.RideJournal
import com.apexvelo.lab.ride.RideSession
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * The page's way to the native ride recorder (src/native-ride.js is the JS side, com.apexvelo.lab.ride the
 * recorder): start, one call per page second (sample), pause, handBack when the page runs again, stop on save
 * or discard, visibility (the lease), and at app start the live ride or the journal of a killed one (recovery). Every call runs on the ride thread.
 */
@CapacitorPlugin(name = "ApexRide")
class ApexRidePlugin : Plugin() {
    private val session = RideSession
    private val rec get() = session.recorder

    override fun load() {
        session.listener = { name, data -> notifyListeners(name, JSObject().apply { for ((k, v) in data) put(k, v) }) }
    }

    override fun handleOnDestroy() {
        session.listener = null
        super.handleOnDestroy()
    }

    private fun onRide(call: PluginCall, block: () -> Unit) = session.handler.post {
        try { block() } catch (e: Exception) { call.reject(e.message ?: e.toString()) }
    }

    private fun plan(o: JSONObject): RidePlan {
        val arr = o.getJSONArray("steps")
        val steps = (0 until arr.length()).map { i ->
            val s = arr.getJSONObject(i)
            PlanStep(s.optString("name"), s.optInt("duration", 1), s.optDouble("pctFtp", 0.0), s.optInt("watts", 0), s.optBoolean("test", false))
        }
        return RidePlan(
            steps = steps, ftp = o.optInt("ftp", 200), bias = o.optDouble("bias", 1.0), ergOn = o.optBoolean("ergOn", true),
            rampStepPct = o.optDouble("rampStepPct", 0.0), rampStepSec = o.optInt("rampStepSec", 60), weightKg = o.optDouble("weightKg", 75.0),
            powerMin = o.optInt("powerMin", 0), powerMax = o.optInt("powerMax", 2000), powerSource = o.optString("powerSource", "auto"),
            trainer = o.optString("trainer", ""), pedals = o.optString("pedals", ""), hr = o.optString("hr", ""),
        )
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val p = call.getObject("plan") ?: return call.reject("plan missing")
        val st = call.getObject("state") ?: return call.reject("state missing")
        val header = call.getString("header") ?: return call.reject("header missing")
        val samples = call.getArray("samples")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
        onRide(call) {
            val now = SystemClock.elapsedRealtime()
            rec.start(plan(p), st.optInt("time"), st.optInt("step"), st.optInt("remaining"), st.optDouble("distanceM", 0.0),
                st.optDouble("maxSpeed", 0.0), st.optDouble("trim", 0.0), now)
            session.start(context, header, rec.plan, samples, now)
            call.resolve()
        }
    }

    @PluginMethod
    fun sample(call: PluginCall) {
        val sample = call.getString("sample") ?: return call.reject("sample missing")
        val st = call.getObject("state") ?: return call.reject("state missing")
        val p = call.getObject("plan")
        onRide(call) {
            if (p != null) { rec.setPlan(plan(p)); session.planChanged(rec.plan) }
            val ok = rec.jsSample(st.optInt("time"), st.optInt("step"), st.optInt("remaining"), st.optDouble("distanceM", 0.0),
                st.optDouble("maxSpeed", 0.0), st.optInt("power"), st.optInt("hr"), st.optDouble("trim", 0.0), SystemClock.elapsedRealtime())
            if (ok) session.journalAppend(sample)
            call.resolve(JSObject().put("accepted", ok))
        }
    }

    @PluginMethod
    fun setPaused(call: PluginCall) {
        val paused = call.getBoolean("paused", false) ?: false
        onRide(call) { rec.setPaused(paused, true, SystemClock.elapsedRealtime()); call.resolve() }
    }

    @PluginMethod
    fun handBack(call: PluginCall) {
        onRide(call) {
            val s = rec.handBack(SystemClock.elapsedRealtime()) ?: return@onRide call.resolve()
            val extra = JSArray()
            for (step in s.extraSteps) extra.put(JSONObject(com.apexvelo.lab.ride.RideRecorder.stepJson(step)))
            call.resolve(JSObject()
                .put("samples", JSArray(s.samples))
                .put("elapsed", s.elapsed).put("step", s.step).put("remaining", s.remaining)
                .put("distanceM", s.distanceM).put("maxSpeed", s.maxSpeed)
                .put("extraSteps", extra).put("paused", s.paused)
                .put("event", s.event?.let { JSONObject(it) } ?: JSONObject.NULL))
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        onRide(call) { session.stop(keepJournal = false); call.resolve() }
    }

    /**
     * At app start: the ride the native side is still recording (the page was reloaded or the activity
     * recreated while the process lived; live = true, the page takes it back), or the journal of a ride the
     * app was killed in.
     */
    @PluginMethod
    fun recovery(call: PluginCall) {
        onRide(call) {
            val c = RideJournal(session.journalFile(context)).read() ?: return@onRide call.resolve(JSObject())
            call.resolve(JSObject().put("header", c.header).put("samples", JSArray(c.samples)).put("state", c.state)
                .put("live", rec.active).put("paused", rec.paused))
        }
    }

    /** The page went to the background or came back: the lease the native side gives it changes (3 s / 10 s). */
    @PluginMethod
    fun visibility(call: PluginCall) {
        val visible = call.getBoolean("visible", true) ?: true
        onRide(call) { rec.setVisible(visible, SystemClock.elapsedRealtime()); call.resolve() }
    }

    @PluginMethod
    fun discardRecovery(call: PluginCall) {
        onRide(call) { if (!rec.active) RideJournal(session.journalFile(context)).delete(); call.resolve() }
    }

    /** Android 13+: the ride notification needs the notification permission (the ride records without it). */
    @PluginMethod
    fun askNotifications(call: PluginCall) {
        val act = activity
        if (act != null && Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(act, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4103)
        }
        call.resolve()
    }

    @PluginMethod
    fun batteryStatus(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        call.resolve(JSObject().put("ignoring", pm.isIgnoringBatteryOptimizations(context.packageName)))
    }

    /**
     * Opens the system list of battery optimisation settings, where the rider can choose "Unrestricted" for the
     * app. Play policy: no REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission and no direct exemption prompt.
     */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        try {
            activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            call.resolve()
        } catch (e: Exception) {
            call.reject("Battery settings are not available on this phone.")
        }
    }
}
