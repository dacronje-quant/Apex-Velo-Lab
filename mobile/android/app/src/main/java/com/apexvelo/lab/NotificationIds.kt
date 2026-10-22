package com.apexvelo.lab

/** Every notification the app posts, one id each, so one feature never replaces or cancels another's notice. */
object NotificationIds {
    /** "New rides to import" from the watched-folder check (plugins/WatchFolderWorker.kt). */
    const val WATCH_FOLDER = 4101
    /** The ride in progress, while the foreground service runs (ride/RideService.kt). */
    const val RIDE = 4102
}
