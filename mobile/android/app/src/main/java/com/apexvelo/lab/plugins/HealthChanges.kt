package com.apexvelo.lab.plugins

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.request.ChangesTokenRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Changes noticed in Health Connect but not yet taken in by the app, as one JSON file: the app appends to it
 * and removes entries once it has stored what they point to. Each entry gets a rising `seq`. Every instance
 * (one per plugin call) locks the same process-wide LOCK, so two calls never interleave a read and a write.
 * Plain JSON and java.io only, so it runs in JVM unit tests.
 */
class PendingChanges(private val file: File, private val max: Int = MAX) {
    companion object {
        const val MAX = 20000
        private val LOCK = Any()
    }

    fun read(): JSONObject { synchronized(LOCK) { return readLocked() } }

    private fun readLocked(): JSONObject {
        if (!file.exists()) return JSONObject().put("next", 1).put("changes", JSONArray()).put("overflow", false)
        return try { JSONObject(file.readText()) } catch (e: Exception) {
            // Unreadable: start over and say so, so the app reads its history again rather than miss changes.
            JSONObject().put("next", 1).put("changes", JSONArray()).put("overflow", true)
        }
    }

    private fun write(state: JSONObject) {
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeText(state.toString())
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    /** Adds entries. Past `max` they are dropped and `overflow` is set: the app then backfills instead. */
    fun append(entries: List<JSONObject>) {
        if (entries.isEmpty()) return
        synchronized(LOCK) { appendLocked(entries) }
    }

    private fun appendLocked(entries: List<JSONObject>) {
        val state = readLocked()
        val list = state.getJSONArray("changes")
        var next = state.getLong("next")
        for (e in entries) {
            if (list.length() >= max) { state.put("overflow", true); break }
            list.put(JSONObject(e.toString()).put("seq", next++))
        }
        write(state.put("next", next))
    }

    /** Removes the entries up to and including `seq`. */
    fun ack(seq: Long) { synchronized(LOCK) { ackLocked(seq) } }

    private fun ackLocked(seq: Long) {
        val state = readLocked()
        val kept = JSONArray()
        val list = state.getJSONArray("changes")
        for (i in 0 until list.length()) list.getJSONObject(i).let { if (it.getLong("seq") > seq) kept.put(it) }
        write(state.put("changes", kept))
    }

    /** Empties the buffer (a new changes token: the app reads history from scratch). */
    fun clear() { synchronized(LOCK) { val next = readLocked().getLong("next"); write(JSONObject().put("next", next).put("changes", JSONArray()).put("overflow", false)) } }
}

/** The changes token and the pull into PendingChanges. */
class HealthChanges(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("apex_healthconnect", Context.MODE_PRIVATE)
    val pending = PendingChanges(File(app.filesDir, "healthconnect/pending.json"))

    fun hasToken() = prefs.getString("token", null) != null
    fun tokenExpired() = prefs.getBoolean("expired", false)

    /** A fresh token from now on for the tracked types; earlier pending entries no longer apply. */
    suspend fun start(client: HealthConnectClient, types: List<String>) {
        val classes = types.mapNotNull { HealthRecords.READ[it] }.toSet()
        pending.clear()
        if (classes.isEmpty()) { prefs.edit().remove("token").putBoolean("expired", false).apply(); return }
        val token = client.getChangesToken(ChangesTokenRequest(classes))
        prefs.edit().putString("token", token).putBoolean("expired", false).apply()
    }

    /**
     * Reads every change since the token into the pending file, a page at a time; the token moves on only
     * after the page is saved, so a crash re-reads a page instead of losing it. An expired token (unused for
     * about 30 days) is dropped and reported: the app reads its history again.
     */
    suspend fun pull(client: HealthConnectClient) {
        var token = prefs.getString("token", null) ?: return
        while (true) {
            val r = client.getChanges(token)
            if (r.changesTokenExpired) { prefs.edit().remove("token").putBoolean("expired", true).apply(); return }
            pending.append(r.changes.mapNotNull { c ->
                when (c) {
                    is UpsertionChange -> HealthRecords.toJson(c.record, withSamples = false).put("op", "upsert")
                    is DeletionChange -> JSONObject().put("op", "delete").put("id", c.recordId)
                    else -> null
                }
            })
            token = r.nextChangesToken
            prefs.edit().putString("token", token).apply()
            if (!r.hasMore) return
        }
    }

    fun forget() { prefs.edit().clear().apply(); pending.clear() }
}
