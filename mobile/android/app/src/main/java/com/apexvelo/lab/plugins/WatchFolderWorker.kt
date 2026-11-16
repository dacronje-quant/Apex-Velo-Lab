package com.apexvelo.lab.plugins

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.apexvelo.lab.NotificationIds
import java.util.concurrent.TimeUnit

/**
 * The daily look at the watched folder. Parsing and saving rides happen in the app (the importer is
 * the web layer), so the worker only finds new files: when the app is running it starts the import
 * there right away; otherwise it keeps the count for the next start and, where notifications are
 * allowed, says how many rides are waiting. Opening the app imports them.
 */
class WatchFolderWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        val tree = WatchFolder.folderUri(ctx) ?: return Result.success()
        if (!WatchFolder.hasPermission(ctx, tree)) return Result.success() // the rider revoked it; Settings says so
        val fresh = try {
            ImportFiles.newFiles(WatchFolder.list(ctx, tree), WatchFolder.readSeen(ctx)) { it.stamp }
        } catch (e: WatchFolder.FolderMissing) {
            return Result.success() // the app says so in Settings at its next scan; nothing to retry
        } catch (e: Exception) {
            return Result.retry() // provider not ready (cloud folder offline): WorkManager backs off and tries again
        }
        WatchFolder.prefs(ctx).edit().putInt(WatchFolder.KEY_PENDING, fresh.size)
            .putLong(WatchFolder.KEY_CHECKED, System.currentTimeMillis()).apply()
        if (fresh.isEmpty()) return Result.success()
        if (!ApexImportPlugin.notifyFolderChanged(fresh.size)) notify(ctx, fresh.size, WatchFolder.folderName(ctx))
        return Result.success()
    }

    private fun notify(ctx: Context, count: Int, folder: String?) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "Ride imports", NotificationManager.IMPORTANCE_LOW)
            channel.description = "New ride files in your watched folder"
            ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP) ?: return
        val tap = PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = "$count new ride file${if (count == 1) "" else "s"} in ${folder ?: "your watched folder"}. Open Apex Velo to import."
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("New rides to import")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        try { nm.notify(NOTIFICATION_ID, n) } catch (e: SecurityException) { /* notification permission withdrawn */ }
    }

    companion object {
        private const val WORK = "apex-watch-folder"
        private const val CHANNEL = "ride_imports"
        private const val NOTIFICATION_ID = NotificationIds.WATCH_FOLDER

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequest.Builder(WatchFolderWorker::class.java, 1, TimeUnit.DAYS)
                .setConstraints(Constraints.Builder().setRequiresBatteryNotLow(true).build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
            NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID)
        }

        /** Imported in the app: the "rides waiting" notification is out of date. */
        fun clearNotice(ctx: Context) {
            NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID)
            WatchFolder.prefs(ctx).edit().putInt(WatchFolder.KEY_PENDING, 0).apply()
        }
    }
}
