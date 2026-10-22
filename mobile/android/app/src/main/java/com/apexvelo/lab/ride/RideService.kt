package com.apexvelo.lab.ride

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.apexvelo.lab.R

/**
 * Keeps the app process running with the screen off from ride start to save/discard (a connectedDevice
 * foreground service: it holds the Bluetooth links to the trainer, power meter and heart-rate strap), with a
 * partial wake lock so the 1 Hz recorder keeps time, and the ride notification: elapsed time, power, heart
 * rate, the current interval and its target, and Pause/Resume.
 */
class RideService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PAUSE -> RideSession.userPause(true)
            ACTION_RESUME -> RideSession.userPause(false)
        }
        if (!RideSession.recorder.active && intent?.action != ACTION_START) { stopSelf(); return START_NOT_STICKY }
        try {
            val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, build(this), type)
        } catch (e: Exception) {
            // Not allowed now (no Bluetooth permission, or started from the background): record without it.
            stopSelf()
            return START_NOT_STICKY
        }
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ApexVelo:ride").apply { setReferenceCounted(false); acquire(12 * 3600 * 1000L) }
        }
        return START_NOT_STICKY // after a crash the journal goes to recovery; nothing to restart here
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.apexvelo.lab.ride.START"
        const val ACTION_PAUSE = "com.apexvelo.lab.ride.PAUSE"
        const val ACTION_RESUME = "com.apexvelo.lab.ride.RESUME"
        private const val CHANNEL = "ride"
        private const val NOTIFICATION_ID = 4101
        @Volatile private var running = false

        fun start(c: Context) {
            if (!RideSession.canUseBluetooth(c)) return // Android 14 allows connectedDevice only with it
            try {
                ContextCompat.startForegroundService(c, RideSession.intentFor(c, ACTION_START))
                running = true
            } catch (e: Exception) { /* background start refused: recording goes on while the app runs */ }
        }

        fun stop(c: Context) {
            running = false
            c.stopService(Intent(c, RideService::class.java))
        }

        /** Updates the notification (called by the ride thread every second). */
        @SuppressLint("MissingPermission") // without the notification permission Android drops it; caught below
        fun refresh(c: Context?) {
            if (c == null || !running) return
            try { NotificationManagerCompat.from(c).notify(NOTIFICATION_ID, build(c)) } catch (e: SecurityException) { /* notifications off */ }
        }

        private fun build(c: Context): android.app.Notification {
            if (Build.VERSION.SDK_INT >= 26) {
                val nm = c.getSystemService(NotificationManager::class.java)
                if (nm.getNotificationChannel(CHANNEL) == null) {
                    nm.createNotificationChannel(NotificationChannel(CHANNEL, "Ride in progress", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shows the ride while the screen is off: time, power, heart rate and the current interval."
                        setShowBadge(false)
                    })
                }
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val open = c.packageManager.getLaunchIntentForPackage(c.packageName)?.let { PendingIntent.getActivity(c, 0, it, flags) }
            val paused = RideSession.recorder.paused
            val action = if (paused) ACTION_RESUME else ACTION_PAUSE
            val toggle = PendingIntent.getService(c, if (paused) 2 else 1, RideSession.intentFor(c, action), flags)
            val (title, text) = RideSession.notificationText()
            val b = NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_ride)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory("workout") // Notification.CATEGORY_WORKOUT
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(open)
            if (!RideSession.recorder.ended) b.addAction(0, if (paused) "Resume" else "Pause", toggle)
            return b.build()
        }
    }
}
