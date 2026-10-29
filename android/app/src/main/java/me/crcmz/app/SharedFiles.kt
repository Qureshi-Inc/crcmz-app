package me.crcmz.app

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * A file shared to CRCMZ from Photos (or any app): copied into the app's cache and
 * handed to the page at https://app.crcmz.me/__crcmz/shared/<token>. Only this app's web
 * view can read that address.
 *  a video   Clips' own "Send a video" (frontend/src/features/clips/SendVideo.tsx) uploads
 *            it, with its caption, checks and resumable upload
 *  photos    receipts for a trip's Split: /app/trips/receipts?shared=<t1>,<t2> reads and adds them
 */
object SharedFiles {
    private class Entry(val file: File, val mime: String, val ready: CountDownLatch)
    private val entries = ConcurrentHashMap<String, Entry>()
    const val PREFIX = "/__crcmz/shared/"

    /** Start copying [uri]; returns the page to open (Clips, Send a video, this file picked). */
    fun offer(ctx: Context, uri: Uri, mime: String): String {
        val (token, name) = register(ctx, uri, mime.ifBlank { "video/mp4" }, "video.mp4")
        return Uri.parse("${LauncherActivity.ORIGIN}/app/clips").buildUpon()
            .appendQueryParameter("upload", "")
            .appendQueryParameter("shared", token)
            .appendQueryParameter("name", name)
            .build().toString()
    }

    /** Photos shared as receipts (up to 30): each copied like a video, then the page that
     *  picks the trip, reads them and adds them to its Split. */
    fun offerReceipts(ctx: Context, uris: List<Uri>, mime: String): String? {
        val tokens = uris.take(30).map { register(ctx, it, mime.takeIf { m -> m.startsWith("image/") && m != "image/*" } ?: "image/jpeg", "receipt.jpg").first }
        if (tokens.isEmpty()) return null
        return Uri.parse("${LauncherActivity.ORIGIN}/app/trips/receipts").buildUpon()
            .appendQueryParameter("shared", tokens.joinToString(","))
            .build().toString()
    }

    /** Copy [uri] into the cache in the background; (token, display name). */
    private fun register(ctx: Context, uri: Uri, mime: String, fallbackName: String): Pair<String, String> {
        val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
        // Yesterday's shares are done with.
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 3600_000L }?.forEach { it.delete() }
        var name = fallbackName
        runCatching {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() }?.let { name = it }
            }
        }
        // A photo's own type when the sender gave a wildcard (image/*).
        val type = runCatching { ctx.contentResolver.getType(uri) }.getOrNull()?.takeIf { mime.startsWith("image/") && it.startsWith("image/") } ?: mime
        val token = UUID.randomUUID().toString()
        val file = File(dir, token)
        val e = Entry(file, type, CountDownLatch(1))
        entries[token] = e
        thread(name = "share-copy") {
            runCatching { ctx.contentResolver.openInputStream(uri)?.use { i -> file.outputStream().use { o -> i.copyTo(o, 1 shl 16) } } }
            e.ready.countDown()
        }
        return token to name
    }

    /** The web view asking for a shared file (on its own thread, so it can wait for the copy). */
    fun serve(path: String): WebResourceResponse? {
        if (!path.startsWith(PREFIX)) return null
        val e = entries[path.removePrefix(PREFIX)] ?: return WebResourceResponse("text/plain", null, 404, "Not found", emptyMap(), null)
        e.ready.await(5, TimeUnit.MINUTES)
        if (!e.file.exists() || e.file.length() == 0L) return WebResourceResponse("text/plain", null, 404, "Not found", emptyMap(), null)
        return WebResourceResponse(e.mime, null, 200, "OK",
            mapOf("Content-Length" to e.file.length().toString(), "Cache-Control" to "no-store"), FileInputStream(e.file))
    }
}
