package com.apexvelo.lab.plugins

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File

/**
 * The rider's watched folder (picked with ACTION_OPEN_DOCUMENT_TREE, read through its persisted
 * permission): where it is, what is in it, and which files the app has already imported.
 *
 * The authoritative record of imported files is the import_files table (src/native-import.js); the
 * stamps of those files are mirrored to `seenFile` so the daily worker can tell new files apart
 * without the WebView.
 */
object WatchFolder {
    const val PREFS = "apex_import"
    private const val KEY_URI = "watchFolderUri"
    private const val KEY_NAME = "watchFolderName"
    const val KEY_PENDING = "watchPendingNew"
    const val KEY_CHECKED = "watchWorkerCheckedAt"

    /** Folders below the picked one that are listed (Garmin exports nest DI_CONNECT/DI-Connect-Fitness/...). */
    const val MAX_DEPTH = 6
    /** Entries looked at in one listing, so a folder of photos cannot keep a scan busy forever. */
    const val MAX_ENTRIES = 50_000

    class Entry(val uri: Uri, val path: String, val name: String, val size: Long, val mtime: Long) {
        val stamp: String get() = ImportFiles.stamp(path, size, mtime)
    }

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun folderUri(ctx: Context): Uri? = prefs(ctx).getString(KEY_URI, null)?.let(Uri::parse)
    fun folderName(ctx: Context): String? = prefs(ctx).getString(KEY_NAME, null)

    fun save(ctx: Context, uri: Uri, name: String) {
        prefs(ctx).edit().putString(KEY_URI, uri.toString()).putString(KEY_NAME, name)
            .remove(KEY_PENDING).remove(KEY_CHECKED).apply()
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY_URI).remove(KEY_NAME).remove(KEY_PENDING).remove(KEY_CHECKED).apply()
        seenFile(ctx).delete()
    }

    /** True while the app still holds the read permission the rider granted for the folder. */
    fun hasPermission(ctx: Context, uri: Uri): Boolean =
        ctx.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }

    /** A readable name for a picked tree ("Download/Garmin"), from its root document. */
    fun displayName(ctx: Context, tree: Uri): String {
        val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        ctx.contentResolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
        }
        return DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':').ifEmpty { "Folder" }
    }

    /** Every ride file (and Strava activities.csv) in the folder and its subfolders, paths relative to it. */
    fun list(ctx: Context, tree: Uri): List<Entry> {
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
        )
        val out = ArrayList<Entry>()
        val queue = ArrayDeque<Triple<String, String, Int>>() // document id, relative path, depth
        queue.add(Triple(DocumentsContract.getTreeDocumentId(tree), "", 0))
        var seen = 0
        while (queue.isNotEmpty() && seen < MAX_ENTRIES) {
            val (parentId, prefix, depth) = queue.removeFirst()
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
            ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext() && seen < MAX_ENTRIES) {
                    seen++
                    val id = c.getString(0) ?: continue
                    val name = c.getString(1) ?: continue
                    val path = if (prefix.isEmpty()) name else "$prefix/$name"
                    if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (depth < MAX_DEPTH) queue.add(Triple(id, path, depth + 1))
                    } else if (ImportFiles.isWatched(name)) {
                        val size = if (c.isNull(3)) -1L else c.getLong(3)
                        val mtime = if (c.isNull(4)) 0L else c.getLong(4)
                        out.add(Entry(DocumentsContract.buildDocumentUriUsingTree(tree, id), path, name, size, mtime))
                    }
                }
            }
        }
        out.sortBy { it.path }
        return out
    }

    /** Stamps of the files the app has imported, mirrored from import_files by setSeen. */
    fun seenFile(ctx: Context): File = File(ctx.noBackupFilesDir, "watch-folder-seen.txt")

    fun readSeen(ctx: Context): Set<String> {
        val f = seenFile(ctx)
        return if (f.exists()) f.readLines().filter { it.isNotEmpty() }.toHashSet() else emptySet()
    }

    fun writeSeen(ctx: Context, stamps: Collection<String>) {
        val f = seenFile(ctx)
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(stamps.joinToString("\n"))
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }
}
