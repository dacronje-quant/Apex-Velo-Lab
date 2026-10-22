package com.apexvelo.lab.plugins

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native side of ride import (src/native-import.js is the JS side):
 *  - streams any ride file the app may read (watched-folder documents, shared files) to the WebView in
 *    chunks (open / read / close), so a multi-GB export is never copied whole into the WebView;
 *  - the watched folder: pick (ACTION_OPEN_DOCUMENT_TREE, persisted read permission), list, remove,
 *    and the daily WatchFolderWorker;
 *  - the share target: files shared to the app (ACTION_SEND / SEND_MULTIPLE) are copied, streamed, into
 *    an inbox in the app's private storage, so an import the system kills half-way can start again.
 *    They stay there until the JS side has imported them and calls removeInbox.
 */
@CapacitorPlugin(name = "ApexImport")
class ApexImportPlugin : Plugin() {
    private val io = Executors.newSingleThreadExecutor()
    private val reads = Executors.newSingleThreadExecutor()
    private val streams = ConcurrentHashMap<Int, InputStream>()
    private val nextHandle = AtomicInteger(1)
    /** Shared files that could not be copied (not enough space): readable while the app runs, from the sender's URI. */
    private val transient = ConcurrentHashMap<String, JSObject>()

    override fun load() {
        instance = WeakReference(this)
        activity?.intent?.let { takeShare(it) }
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        takeShare(intent)
    }

    override fun handleOnDestroy() {
        if (instance?.get() === this) instance = null
        streams.values.forEach { runCatching { it.close() } }
        streams.clear()
        super.handleOnDestroy()
    }

    // ---------------------------------------------------------------- reading --
    @PluginMethod
    fun open(call: PluginCall) {
        val uri = readableUri(call.getString("uri")) ?: return call.reject("This file cannot be read by the app.")
        reads.execute {
            try {
                val input = context.contentResolver.openInputStream(uri) ?: throw IllegalStateException("no data")
                val handle = nextHandle.getAndIncrement()
                streams[handle] = input.buffered(256 * 1024)
                call.resolve(JSObject().put("handle", handle).put("size", sizeOf(uri)))
            } catch (e: Exception) {
                call.reject("Could not open the file (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }

    @PluginMethod
    fun read(call: PluginCall) {
        val handle = call.getInt("handle") ?: return call.reject("handle missing")
        val length = call.getInt("length") ?: (1024 * 1024)
        reads.execute {
            val input = streams[handle] ?: return@execute call.reject("The file is closed.")
            try {
                val chunk = ImportFiles.readChunk(input, length)
                if (chunk.eof) streams.remove(handle)?.close()
                call.resolve(JSObject().put("data", Base64.encodeToString(chunk.bytes, Base64.NO_WRAP)).put("eof", chunk.eof))
            } catch (e: Exception) {
                streams.remove(handle)?.let { runCatching { it.close() } }
                call.reject("Could not read the file (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val handle = call.getInt("handle") ?: return call.resolve()
        reads.execute {
            streams.remove(handle)?.let { runCatching { it.close() } }
            call.resolve()
        }
    }

    /** Closes every file still open (an import that ended without reading a file to its end). */
    @PluginMethod
    fun closeAll(call: PluginCall) {
        reads.execute {
            streams.values.forEach { runCatching { it.close() } }
            streams.clear()
            call.resolve()
        }
    }

    /** content:// documents of the watched folder or a share, and file:// URIs inside the inbox; nothing else. */
    private fun readableUri(text: String?): Uri? {
        val uri = text?.let(Uri::parse) ?: return null
        return when (uri.scheme) {
            "content" -> uri
            "file" -> {
                val f = File(uri.path ?: return null).canonicalFile
                if (f.path.startsWith(inboxDir().canonicalPath + File.separator)) Uri.fromFile(f) else null
            }
            else -> null
        }
    }

    private fun sizeOf(uri: Uri): Long {
        if (uri.scheme == "file") return File(uri.path!!).length()
        return try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else -1L
            } ?: -1L
        } catch (e: Exception) { -1L }
    }

    // ---------------------------------------------------------- watched folder --
    @PluginMethod
    fun pickFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        startActivityForResult(call, intent, "folderPicked")
    }

    @ActivityCallback
    fun folderPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val tree = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || tree == null) return call.resolve(JSObject().put("cancelled", true))
        try {
            context.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: SecurityException) {
            return call.reject("Android did not let the app keep access to that folder. Pick another one.")
        }
        val old = WatchFolder.folderUri(context)
        if (old != null && old != tree) releaseFolder(old)
        val name = runCatching { WatchFolder.displayName(context, tree) }.getOrDefault("Folder")
        WatchFolder.save(context, tree, name)
        WatchFolderWorker.schedule(context)
        askNotifications()
        call.resolve(folderInfo())
    }

    @PluginMethod
    fun getFolder(call: PluginCall) = call.resolve(folderInfo())

    @PluginMethod
    fun removeFolder(call: PluginCall) {
        WatchFolder.folderUri(context)?.let { releaseFolder(it) }
        WatchFolder.clear(context)
        WatchFolderWorker.cancel(context)
        call.resolve()
    }

    @PluginMethod
    fun listFolder(call: PluginCall) {
        val tree = WatchFolder.folderUri(context) ?: return call.reject("No folder is watched.")
        if (!WatchFolder.hasPermission(context, tree)) return call.reject("The app no longer has access to the folder. Pick it again in Settings.")
        io.execute {
            try {
                val files = JSArray()
                for (e in WatchFolder.list(context, tree)) {
                    files.put(JSObject().put("uri", e.uri.toString()).put("path", e.path).put("name", e.name).put("size", e.size).put("mtime", e.mtime))
                }
                call.resolve(JSObject().put("files", files))
            } catch (e: WatchFolder.FolderMissing) {
                call.reject(e.message)
            } catch (e: Exception) {
                call.reject("Could not read the folder (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }

    /** The stamps of the folder's files that are recorded in import_files, for the daily worker. */
    @PluginMethod
    fun setSeen(call: PluginCall) {
        val stamps = call.getArray("stamps")?.toList<String>() ?: emptyList()
        io.execute {
            try {
                WatchFolder.writeSeen(context, stamps)
                WatchFolderWorker.clearNotice(context)
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "Could not save the folder state.")
            }
        }
    }

    private fun releaseFolder(uri: Uri) {
        runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    private fun folderInfo(): JSObject {
        val tree = WatchFolder.folderUri(context) ?: return JSObject().put("uri", JSONObject.NULL)
        val prefs = WatchFolder.prefs(context)
        return JSObject().put("uri", tree.toString()).put("name", WatchFolder.folderName(context))
            .put("permission", WatchFolder.hasPermission(context, tree))
            .put("pendingNew", prefs.getInt(WatchFolder.KEY_PENDING, 0))
            .put("workerCheckedAt", prefs.getLong(WatchFolder.KEY_CHECKED, 0L))
    }

    /** Android 13+: the daily check may say "new rides waiting" only with the notification permission. */
    private fun askNotifications() {
        val act = activity ?: return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(act, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4102)
        }
    }

    // ------------------------------------------------------------ share target --
    private fun inboxDir(): File = File(context.noBackupFilesDir, "import-inbox")

    /** Files waiting to be imported: shared files copied into the inbox (also after a restart) and transient ones. */
    @PluginMethod
    fun listInbox(call: PluginCall) {
        io.execute {
            val files = JSArray()
            inboxDir().listFiles()?.sortedBy { it.name }?.forEach { dir ->
                val f = dir.listFiles()?.firstOrNull { it.isFile && !it.name.endsWith(".part") }
                // Copies run on this same thread, so a folder without a finished file is a copy the app was killed in.
                if (f == null) { dir.deleteRecursively(); return@forEach }
                files.put(JSObject().put("uri", Uri.fromFile(f).toString()).put("name", f.name).put("size", f.length()).put("mtime", f.lastModified()))
            }
            transient.values.forEach { files.put(it) }
            call.resolve(JSObject().put("files", files))
        }
    }

    @PluginMethod
    fun removeInbox(call: PluginCall) {
        val text = call.getString("uri") ?: return call.resolve()
        io.execute {
            if (transient.remove(text) == null) {
                val uri = readableUri(text)
                if (uri != null && uri.scheme == "file") {
                    val f = File(uri.path!!)
                    f.delete()
                    f.parentFile?.let { dir -> if (dir.parentFile?.canonicalPath == inboxDir().canonicalPath) dir.deleteRecursively() }
                }
            }
            call.resolve()
        }
    }

    /** A share intent: copies its files into the inbox in the background, then tells the page. Runs once per intent. */
    private fun takeShare(intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        val uris = sharedUris(intent)
        intent.action = SHARE_HANDLED // a recreated activity must not copy the same files again
        if (uris.isEmpty()) return
        io.execute {
            var accepted = 0
            val rejected = JSArray()
            val stamp = System.currentTimeMillis()
            uris.forEachIndexed { i, uri ->
                val (display, size) = describe(uri)
                val name = ImportFiles.sharedName(display, runCatching { context.contentResolver.getType(uri) }.getOrNull())
                if (name == null) { rejected.put(display ?: uri.lastPathSegment ?: "file"); return@forEachIndexed }
                if (copyToInbox(uri, name, size, "$stamp-$i")) accepted++
                else if (sizeOf(uri) != 0L) {
                    transient[uri.toString()] = JSObject().put("uri", uri.toString()).put("name", name).put("size", size).put("mtime", stamp).put("transient", true)
                    accepted++
                } else rejected.put(name)
            }
            notifyListeners("sharedFiles", JSObject().put("accepted", accepted).put("rejected", rejected), true)
        }
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent): List<Uri> {
        val out = LinkedHashSet<Uri>()
        if (intent.action == Intent.ACTION_SEND) intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { out.add(it) }
        else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { out.addAll(it) }
        intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { out.add(it) } }
        return out.toList()
    }

    private fun describe(uri: Uri): Pair<String?, Long> = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (!c.moveToFirst()) null to -1L
            else (if (c.isNull(0)) null else c.getString(0)) to (if (c.isNull(1)) -1L else c.getLong(1))
        } ?: (uri.lastPathSegment to -1L)
    } catch (e: Exception) { uri.lastPathSegment to -1L }

    /** Streams one shared file into inbox/<id>/<name>. False when there is no room for it or it cannot be read. */
    private fun copyToInbox(uri: Uri, name: String, size: Long, id: String): Boolean {
        val dir = File(inboxDir(), ImportFiles.safeSegment(id))
        val free = runCatching { StatFs(context.noBackupFilesDir.path).availableBytes }.getOrDefault(0L)
        if (size > 0 && size + MIN_FREE > free) return false
        if (!dir.mkdirs() && !dir.isDirectory) return false
        val part = File(dir, ImportFiles.safeSegment(name) + ".part")
        return try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(256 * 1024)
                    var copied = 0L
                    var nextCheck = SPACE_CHECK_BYTES
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        copied += n
                        // The sender did not say how big the file is: stop before the phone runs out of space.
                        if (size <= 0 && copied >= nextCheck) {
                            nextCheck += SPACE_CHECK_BYTES
                            if (StatFs(context.noBackupFilesDir.path).availableBytes < MIN_FREE) throw IllegalStateException("not enough space")
                        }
                    }
                }
            } ?: throw IllegalStateException("no data")
            part.renameTo(File(dir, ImportFiles.safeSegment(name)))
        } catch (e: Exception) {
            dir.deleteRecursively()
            false
        }
    }

    /** Called by the worker: true when the page is running and was told to import the new files now. */
    fun folderChanged(count: Int) {
        notifyListeners("folderChanged", JSObject().put("newFiles", count))
    }

    companion object {
        private const val SHARE_HANDLED = "com.apexvelo.lab.SHARE_HANDLED"
        /** Space left on the phone after copying a shared file. */
        private const val MIN_FREE = 200L * 1024 * 1024
        /** How often free space is checked while copying a shared file of unknown size. */
        private const val SPACE_CHECK_BYTES = 64L * 1024 * 1024
        @Volatile private var instance: WeakReference<ApexImportPlugin>? = null

        fun notifyFolderChanged(count: Int): Boolean {
            val plugin = instance?.get() ?: return false
            if (plugin.activity == null || plugin.bridge == null) return false
            plugin.folderChanged(count)
            return true
        }
    }
}
