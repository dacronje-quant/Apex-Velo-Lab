package com.apexvelo.lab.plugins

import java.io.InputStream

/**
 * The parts of native import that need no Android classes, so they run in JVM unit tests:
 * which files are ride files, the name+size+mtime stamp a watched-folder file is tracked by,
 * which files of a folder listing are new, and reading a stream in bounded chunks.
 */
object ImportFiles {
    /** Ride files and archives the bulk importer (js/velo-bulk-import.js) reads. */
    private val RIDE_EXT = setOf("fit", "tcx", "gpx", "zip")

    /** Most bytes one read() hands to the WebView (base64 makes it a third larger on the bridge). */
    const val MAX_CHUNK = 4 * 1024 * 1024

    /** A Strava "Download your data" folder names its rides in activities.csv; it is read with them. */
    fun isStravaIndex(name: String): Boolean = name.lowercase() == "activities.csv"

    /** .fit/.tcx/.gpx/.zip, or one of the first three gzipped (.fit.gz). Case does not matter. */
    fun isRideFile(name: String): Boolean {
        val n = name.lowercase().substringAfterLast('/')
        if (n.endsWith(".gz")) {
            val inner = n.removeSuffix(".gz").substringAfterLast('.', "")
            return inner == "fit" || inner == "tcx" || inner == "gpx"
        }
        return n.substringAfterLast('.', "") in RIDE_EXT
    }

    /** A file the watched folder imports: a ride file or a Strava activities.csv. */
    fun isWatched(name: String): Boolean = isRideFile(name) || isStravaIndex(name.substringAfterLast('/'))

    /**
     * The name a shared file is imported under. Apps that share without a file name, or with one that
     * has no extension, still say what it is through the MIME type; octet-stream needs the extension.
     * Null when the file is not something the importer reads.
     */
    fun sharedName(displayName: String?, mimeType: String?): String? {
        val base = (displayName ?: "").substringAfterLast('/').trim()
        if (base.isNotEmpty() && isRideFile(base)) return base
        val ext = when (mimeType?.lowercase()) {
            "application/vnd.ant.fit", "application/fit", "application/x-fit" -> "fit"
            "application/gpx+xml", "application/gpx" -> "gpx"
            "application/vnd.garmin.tcx+xml", "application/tcx+xml" -> "tcx"
            "application/zip", "application/x-zip-compressed" -> "zip"
            else -> return null
        }
        return (if (base.isEmpty()) "shared" else base) + "." + ext
    }

    /** The key a watched-folder file is tracked by in import_files; the same formula as src/native-import.js. */
    fun stamp(path: String, size: Long, mtime: Long): String = "$path|$size|$mtime"

    /** Files of a listing whose stamp is not among the ones already imported (a changed file counts as new). */
    fun <T> newFiles(listing: List<T>, seen: Set<String>, stampOf: (T) -> String): List<T> =
        listing.filter { stampOf(it) !in seen }

    /** Reads up to `length` bytes (at most MAX_CHUNK); fewer only at the end of the stream. eof once nothing is left. */
    fun readChunk(input: InputStream, length: Int): Chunk {
        val want = length.coerceIn(1, MAX_CHUNK)
        val buf = ByteArray(want)
        var n = 0
        while (n < want) {
            val r = input.read(buf, n, want - n)
            if (r < 0) return Chunk(if (n == want) buf else buf.copyOf(n), true)
            n += r
        }
        return Chunk(buf, false)
    }

    class Chunk(val bytes: ByteArray, val eof: Boolean)

    /** A folder or file name that is safe as one path segment in the app's inbox. */
    fun safeSegment(name: String): String {
        val s = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().trimStart('.')
        return (if (s.isEmpty()) "file" else s).take(120)
    }
}
