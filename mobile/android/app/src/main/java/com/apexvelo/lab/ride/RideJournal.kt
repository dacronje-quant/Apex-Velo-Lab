package com.apexvelo.lab.ride

import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter

/**
 * The crash-safe copy of the ride in progress: one JSON line per entry in the app's private storage.
 *   H<header json>   the page's ride header (recovery key, store id, profile, workout)
 *   S<sample json>   a recorded second (from the page or the native recorder)
 *   T<state json>    the position after the latest second (step, remaining, distance, ramp steps)
 * Each line is flushed to the OS at once (survives the app being killed) and synced to disk every
 * [syncEveryMs] (survives power loss). A line cut short by a crash is skipped when read.
 */
class RideJournal(private val file: File, private val syncEveryMs: Long = 5000) {
    private var out: FileOutputStream? = null
    private var writer: OutputStreamWriter? = null
    private var syncedAt = 0L

    data class Contents(val header: String, val samples: List<String>, val state: String?)

    @Synchronized
    fun begin(header: String, samples: List<String>, state: String, now: Long) {
        close()
        file.parentFile?.mkdirs()
        val o = FileOutputStream(file, false)
        out = o
        writer = OutputStreamWriter(o, Charsets.UTF_8)
        line('H', header)
        for (s in samples) line('S', s)
        line('T', state)
        sync(now)
    }

    @Synchronized
    fun append(sample: String, state: String, now: Long) {
        if (writer == null) return
        line('S', sample)
        line('T', state)
        if (now - syncedAt >= syncEveryMs) sync(now)
    }

    private fun line(kind: Char, json: String) {
        val w = writer ?: return
        w.write(kind.code)
        w.write(json.replace('\n', ' '))
        w.write('\n'.code)
        w.flush()
    }

    private fun sync(now: Long) {
        try { out?.fd?.sync() } catch (e: Exception) { /* flushed to the OS already */ }
        syncedAt = now
    }

    @Synchronized
    fun close() {
        try { writer?.flush(); out?.fd?.sync() } catch (e: Exception) { /* closing anyway */ }
        try { writer?.close() } catch (e: Exception) { /* closed */ }
        writer = null; out = null
    }

    @Synchronized
    fun delete() { close(); file.delete() }

    @Synchronized
    fun read(): Contents? {
        if (!file.exists()) return null
        var header: String? = null
        var state: String? = null
        val samples = ArrayList<String>()
        file.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (l in lines) {
                if (l.length < 3 || !l.endsWith("}")) continue // cut short by a crash
                val json = l.substring(1)
                when (l[0]) {
                    'H' -> header = json
                    'S' -> samples += json
                    'T' -> state = json
                }
            }
        }
        val h = header ?: return null
        return Contents(h, samples, state)
    }
}
