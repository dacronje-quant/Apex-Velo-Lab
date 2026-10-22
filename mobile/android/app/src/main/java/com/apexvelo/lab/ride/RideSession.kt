package com.apexvelo.lab.ride

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.io.File

/**
 * The ride in progress, for the life of the app process: the [RideRecorder], its [RideJournal], the
 * [BleTap] and the 1 Hz ticker, all on one "apex-ride" thread (callers post to [handler]). RideService keeps
 * the process in the foreground and shows [notificationText]; ApexRidePlugin is the page's way in.
 */
object RideSession {
    private val thread = HandlerThread("apex-ride").apply { start() }
    val handler = Handler(thread.looper)
    val recorder = RideRecorder()
    private val readings = Readings()
    private var journal: RideJournal? = null
    private var tap: BleTap? = null
    private var ctx: Context? = null
    private var tickAt = 0L
    /** Events for the page ("control": Pause/Resume pressed in the notification). Set by ApexRidePlugin. */
    @Volatile var listener: ((String, Map<String, Any>) -> Unit)? = null

    fun journalFile(c: Context) = File(c.filesDir, "ride/active.jsonl")

    private val ticker = object : Runnable {
        override fun run() {
            if (!recorder.active) return
            val res = recorder.tick(SystemClock.elapsedRealtime(), System.currentTimeMillis(), readings)
            if (res.sample != null) journal?.append(res.sample, recorder.stateJson(), SystemClock.elapsedRealtime())
            execute(res.commands)
            RideService.refresh(ctx)
            tickAt += 1000
            handler.postAtTime(this, tickAt)
        }
    }

    /** On the ride thread. */
    fun start(c: Context, header: String, plan: RidePlan, samples: List<String>, now: Long) {
        ctx = c.applicationContext
        val j = RideJournal(journalFile(c))
        j.begin(header, samples, recorder.stateJson(), now)
        journal = j
        tap?.close()
        tap = if (canUseBluetooth(c)) BleTap(c.applicationContext, handler, readings).also { it.update(devices(plan)) } else null
        handler.removeCallbacks(ticker)
        tickAt = SystemClock.uptimeMillis() + 1000
        handler.postAtTime(ticker, tickAt)
        RideService.start(c)
    }

    fun planChanged(plan: RidePlan) { tap?.update(devices(plan)) }

    fun journalAppend(sample: String) { journal?.append(sample, recorder.stateJson(), SystemClock.elapsedRealtime()) }

    /** Pause/Resume from the notification (any thread). */
    fun userPause(paused: Boolean) = handler.post {
        execute(recorder.setPaused(paused, false, SystemClock.elapsedRealtime()))
        listener?.invoke("control", mapOf("paused" to paused))
        RideService.refresh(ctx)
    }

    /** Ride saved or discarded, or (keepJournal) the page that started it is gone and it goes to recovery. */
    fun stop(keepJournal: Boolean) {
        recorder.stop()
        handler.removeCallbacks(ticker)
        tap?.close(); tap = null
        if (keepJournal) journal?.close() else ctx?.let { RideJournal(journalFile(it)).also { journal?.close() }.delete() }
        journal = null
        ctx?.let { RideService.stop(it) }
    }

    private fun execute(cmds: List<Command>) {
        val t = tap ?: return
        for (c in cmds) when (c) {
            Command.RequestControl -> { t.refresh(); t.writeControl(BleParse.REQUEST_CONTROL) }
            is Command.Target -> t.writeControl(BleParse.setTargetPower(c.watts))
            Command.Pause -> t.writeControl(BleParse.PAUSE)
            Command.Resume -> { t.writeControl(BleParse.REQUEST_CONTROL); t.writeControl(BleParse.START_RESUME) }
            Command.Stop -> t.writeControl(BleParse.STOP)
        }
    }

    private fun devices(p: RidePlan) = mapOf("trainer" to p.trainer, "pedals" to p.pedals, "hr" to p.hr)

    fun canUseBluetooth(c: Context) = Build.VERSION.SDK_INT < 31 ||
        ContextCompat.checkSelfPermission(c, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    /** "12:34 · 210 W · 142 bpm" and "Steady: 150 W" (or the pause / finish state). */
    fun notificationText(): Pair<String, String> {
        val r = recorder
        val t = r.elapsed
        val time = if (t >= 3600) String.format("%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) else String.format("%02d:%02d", t / 60, t % 60)
        val title = "$time · ${r.lastPower} W" + (if (r.lastHr > 0) " · ${r.lastHr} bpm" else "")
        val st = r.currentStep()
        val text = when {
            r.ended -> "Workout complete. Open Apex Velo to save the ride."
            r.paused -> "Paused"
            st != null -> "${st.name}: ${r.target()} W target"
            else -> "Recording"
        }
        return title to text
    }

    fun intentFor(c: Context, action: String) = Intent(c, RideService::class.java).setAction(action)
}
