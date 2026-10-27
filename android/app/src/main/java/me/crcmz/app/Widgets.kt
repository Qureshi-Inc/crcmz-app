package me.crcmz.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.view.View
import android.webkit.CookieManager
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Home-screen widgets, fed by /api/widgets/summary (server.py) with the web view's own
 * sign-in cookie:
 *   Live now   what's on (Watch Party, Huddle, Listen Together, a tournament)
 *   Movies     Continue watching (resumes for the party), then the newest films
 *   Slap       what's playing, with play / pause, previous and next (SlapWidget)
 * Refreshed when a widget asks (every 30 min), when a live update arrives, and when the
 * app comes to the front; Slap whenever the player changes. Signed out: they say so and
 * open the app.
 */
object WidgetData {
    private val pool = Executors.newSingleThreadExecutor()
    private const val CACHE = "widget_summary"

    fun refresh(ctx: Context, done: (() -> Unit)? = null) {
        val app = ctx.applicationContext
        pool.execute {
            try {
                fetch(app)?.let { Push.prefs(app).edit().putString(CACHE, it.toString()).apply() }
            } catch (_: Exception) { /* offline: keep showing the last one */ }
            redraw(app)
            done?.invoke()
        }
    }

    fun cached(ctx: Context): JSONObject? = Push.prefs(ctx).getString(CACHE, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    /** null when signed out (401) or unreachable. */
    private fun fetch(ctx: Context): JSONObject? {
        val cookie = CookieManager.getInstance().getCookie(LauncherActivity.ORIGIN) ?: return null.also { signedOut(ctx, true) }
        val c = URL("${LauncherActivity.ORIGIN}/api/widgets/summary").openConnection() as HttpURLConnection
        c.connectTimeout = 10_000; c.readTimeout = 15_000
        c.setRequestProperty("Cookie", cookie)
        c.setRequestProperty("Accept", "application/json")
        return try {
            when (c.responseCode) {
                200 -> JSONObject(c.inputStream.bufferedReader().readText()).also { signedOut(ctx, false) }
                401 -> null.also { signedOut(ctx, true) }
                else -> null
            }
        } finally { c.disconnect() }
    }

    private fun signedOut(ctx: Context, v: Boolean) = Push.prefs(ctx).edit().putBoolean("widget_signed_out", v).apply()
    fun isSignedOut(ctx: Context) = Push.prefs(ctx).getBoolean("widget_signed_out", false)

    fun redraw(ctx: Context) {
        val m = AppWidgetManager.getInstance(ctx)
        for ((cls, draw) in listOf<Pair<Class<*>, (Context) -> RemoteViews>>(
            LiveNowWidget::class.java to ::liveViews,
            MoviesWidget::class.java to ::movieViews,
            SlapWidget::class.java to { c: Context -> SlapWidget.views(c) },
        )) {
            val ids = m.getAppWidgetIds(ComponentName(ctx, cls))
            if (ids.isNotEmpty()) {
                val v = draw(ctx)
                ids.forEach { m.updateAppWidget(it, v) }
            }
        }
    }

    fun open(ctx: Context, path: String, code: Int): PendingIntent = PendingIntent.getActivity(
        ctx, code,
        Intent(ctx, LauncherActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Ringer.appUri(path))
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private val rows = listOf(
        arrayOf(R.id.live_row1, R.id.live_icon1, R.id.live_title1, R.id.live_sub1, R.id.live_bar1),
        arrayOf(R.id.live_row2, R.id.live_icon2, R.id.live_title2, R.id.live_sub2, R.id.live_bar2),
        arrayOf(R.id.live_row3, R.id.live_icon3, R.id.live_title3, R.id.live_sub3, R.id.live_bar3),
    )

    private fun kindIcon(kind: String) = when (kind) {
        "watch" -> R.drawable.ic_watch; "huddle" -> R.drawable.ic_huddle; "slap" -> R.drawable.ic_slap; else -> R.drawable.ic_trophy
    }

    fun liveViews(ctx: Context): RemoteViews {
        val v = RemoteViews(ctx.packageName, R.layout.widget_live)
        v.setOnClickPendingIntent(R.id.live_head, open(ctx, "/app", 9100))
        val live = cached(ctx)?.optJSONArray("live") ?: JSONArray()
        val n = minOf(live.length(), rows.size)
        rows.forEachIndexed { i, r ->
            if (i >= n) { v.setViewVisibility(r[0], View.GONE); return@forEachIndexed }
            val it = live.getJSONObject(i)
            v.setViewVisibility(r[0], View.VISIBLE)
            v.setImageViewResource(r[1], kindIcon(it.optString("kind")))
            v.setTextViewText(r[2], it.optString("title"))
            v.setTextViewText(r[3], listOf(it.optString("subtitle"), it.optString("progressLabel")).filter { s -> s.isNotBlank() }.joinToString(" · "))
            val p = it.optDouble("progress", -1.0)
            if (p >= 0) { v.setViewVisibility(r[4], View.VISIBLE); v.setProgressBar(r[4], 1000, (p * 1000).toInt(), false) }
            else v.setViewVisibility(r[4], View.GONE)
            v.setOnClickPendingIntent(r[0], open(ctx, it.optString("url", "/app"), 9101 + i))
        }
        val empty = when {
            isSignedOut(ctx) -> ctx.getString(R.string.widget_signed_out)
            n == 0 -> ctx.getString(R.string.widget_nothing_live)
            else -> null
        }
        v.setViewVisibility(R.id.live_empty, if (empty != null) View.VISIBLE else View.GONE)
        if (empty != null) {
            v.setTextViewText(R.id.live_empty, empty)
            v.setOnClickPendingIntent(R.id.live_empty, open(ctx, if (isSignedOut(ctx)) "/app" else "/app/watch/party", 9105))
        }
        return v
    }

    private val posters = listOf(
        arrayOf(R.id.mv_cell1, R.id.mv_img1, R.id.mv_title1, R.id.mv_bar1), arrayOf(R.id.mv_cell2, R.id.mv_img2, R.id.mv_title2, R.id.mv_bar2),
        arrayOf(R.id.mv_cell3, R.id.mv_img3, R.id.mv_title3, R.id.mv_bar3), arrayOf(R.id.mv_cell4, R.id.mv_img4, R.id.mv_title4, R.id.mv_bar4),
    )

    /** Films you're partway through first (with how far), then the newest in the library. */
    private fun movieList(ctx: Context): List<JSONObject> {
        val c = cached(ctx) ?: return emptyList()
        val out = mutableListOf<JSONObject>()
        val seen = mutableSetOf<String>()
        for (key in listOf("continue", "movies")) {
            val a = c.optJSONArray(key) ?: continue
            for (i in 0 until a.length()) {
                val m = a.getJSONObject(i)
                if (seen.add(m.optString("title"))) out.add(m)
            }
        }
        return out
    }

    fun movieViews(ctx: Context): RemoteViews {
        val v = RemoteViews(ctx.packageName, R.layout.widget_movies)
        val resuming = (cached(ctx)?.optJSONArray("continue")?.length() ?: 0) > 0
        v.setTextViewText(R.id.mv_head, ctx.getString(if (resuming) R.string.widget_continue_head else R.string.widget_movies_head))
        v.setOnClickPendingIntent(R.id.mv_head, open(ctx, "/app/watch", 9200))
        v.setOnClickPendingIntent(R.id.mv_add, open(ctx, "/app/watch?add=1", 9201))
        val movies = movieList(ctx)
        posters.forEachIndexed { i, cell ->
            if (i >= movies.size) { v.setViewVisibility(cell[0], View.INVISIBLE); return@forEachIndexed }
            val m = movies[i]
            v.setViewVisibility(cell[0], View.VISIBLE)
            v.setTextViewText(cell[2], m.optString("left").ifBlank { m.optString("title") })
            poster(ctx, m.optString("poster"))?.let { b -> v.setImageViewBitmap(cell[1], b) } ?: v.setImageViewResource(cell[1], R.drawable.widget_poster_blank)
            val p = m.optDouble("progress", -1.0)
            if (p > 0) { v.setViewVisibility(cell[3], View.VISIBLE); v.setProgressBar(cell[3], 1000, (p * 1000).toInt(), false) }
            else v.setViewVisibility(cell[3], View.GONE)
            v.setOnClickPendingIntent(cell[0], open(ctx, m.optString("url", "/app/watch"), 9210 + i))
        }
        v.setViewVisibility(R.id.mv_empty, if (movies.isEmpty()) View.VISIBLE else View.GONE)
        v.setTextViewText(R.id.mv_empty, ctx.getString(if (isSignedOut(ctx)) R.string.widget_signed_out else R.string.widget_no_movies))
        return v
    }

    // Posters: small, decoded once, kept in memory (a widget update can't hold much).
    private val posterCache = object : android.util.LruCache<String, Bitmap>(12) {}
    private fun poster(ctx: Context, path: String): Bitmap? {
        if (path.isBlank()) return null
        // Signed links from the server load by themselves; an older relative one needs the cookie.
        val url = if (path.startsWith("/")) LauncherActivity.ORIGIN + path else path
        posterCache.get(url)?.let { return it }
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return null   // drawn again off the main thread
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 8000; c.readTimeout = 10_000
            if (path.startsWith("/")) CookieManager.getInstance().getCookie(LauncherActivity.ORIGIN)?.let { c.setRequestProperty("Cookie", it) }
            val bytes = c.inputStream.use { it.readBytes() }
            c.disconnect()
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            var s = 1
            while (o.outWidth / (s * 2) >= 200) s *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s })
                ?.let { Bitmap.createScaledBitmap(it, 200, (200f * it.height / it.width).toInt(), true) }
                ?.also { posterCache.put(url, it) }
        } catch (_: Exception) { null }
    }
}

/** Every widget refreshes the same way: fetch, then redraw all of them. */
abstract class CrcmzWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, m: AppWidgetManager, ids: IntArray) {
        WidgetData.redraw(ctx)          // the last data at once
        val pending = goAsync()
        WidgetData.refresh(ctx) { pending.finish() }
    }
}

class LiveNowWidget : CrcmzWidget()
class MoviesWidget : CrcmzWidget()

/**
 * Slap's player on the home screen. Playing (or paused) in the app: the song, its art and
 * the buttons drive NativeAudio, same as the lock screen. Nothing loaded (or the app was
 * closed): the last song, and play opens Slap to carry on (/app/slap?play=1).
 */
class SlapWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, m: AppWidgetManager, ids: IntArray) = update(ctx)

    /** The buttons, while something's loaded. */
    class Control : android.content.BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            NativeAudio.control(intent.getStringExtra("action") ?: return)
            update(ctx)   // nothing loaded any more (the app was closed): show Resume
        }
    }

    companion object {
        private const val LAST = "slap_widget_last"

        fun update(ctx: Context) {
            val m = AppWidgetManager.getInstance(ctx)
            val ids = m.getAppWidgetIds(ComponentName(ctx, SlapWidget::class.java))
            if (ids.isNotEmpty()) { val v = views(ctx); ids.forEach { m.updateAppWidget(it, v) } }
        }

        /** The song now, so the widget can show it after the app's gone. */
        fun remember(ctx: Context, title: String, artist: String, art: ByteArray?) {
            if (title.isBlank()) return
            Push.prefs(ctx).edit().putString(LAST, JSONObject().put("title", title).put("artist", artist).toString()).apply()
            art?.let { runCatching { java.io.File(ctx.filesDir, "slap_widget_art").writeBytes(it) } }
        }

        private fun control(ctx: Context, action: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
            ctx, code, Intent(ctx, Control::class.java).putExtra("action", action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        private fun artBitmap(bytes: ByteArray?): Bitmap? = bytes?.let {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(it, 0, it.size, o)
            var s = 1
            while (o.outWidth / (s * 2) >= 160) s *= 2
            BitmapFactory.decodeByteArray(it, 0, it.size, BitmapFactory.Options().apply { inSampleSize = s })
        }

        fun views(ctx: Context): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_slap)
            val now = NativeAudio.now()
            v.setOnClickPendingIntent(R.id.slap_root, WidgetData.open(ctx, "/app/slap", 9400))
            if (now != null) {
                v.setTextViewText(R.id.slap_head, ctx.getString(if (now.playing) R.string.widget_slap_playing else R.string.widget_slap_paused))
                v.setTextViewText(R.id.slap_title, now.title)
                v.setTextViewText(R.id.slap_artist, now.artist)
                artBitmap(now.art)?.let { v.setImageViewBitmap(R.id.slap_art, it) } ?: v.setImageViewResource(R.id.slap_art, R.drawable.widget_poster_blank)
                v.setImageViewResource(R.id.slap_play, if (now.playing) R.drawable.ic_pause else R.drawable.ic_play)
                v.setOnClickPendingIntent(R.id.slap_play, control(ctx, "toggle", 9401))
                v.setOnClickPendingIntent(R.id.slap_next, control(ctx, "next", 9402))
                v.setOnClickPendingIntent(R.id.slap_prev, control(ctx, "prev", 9403))
                v.setViewVisibility(R.id.slap_prev, View.VISIBLE)
                v.setViewVisibility(R.id.slap_next, View.VISIBLE)
            } else {
                val last = Push.prefs(ctx).getString(LAST, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
                v.setTextViewText(R.id.slap_head, ctx.getString(if (last != null) R.string.widget_slap_last else R.string.widget_slap_head))
                v.setTextViewText(R.id.slap_title, last?.optString("title") ?: ctx.getString(R.string.widget_slap_idle))
                v.setTextViewText(R.id.slap_artist, last?.optString("artist") ?: ctx.getString(R.string.widget_slap_idle_sub))
                val art = if (last != null) runCatching { java.io.File(ctx.filesDir, "slap_widget_art").readBytes() }.getOrNull() else null
                artBitmap(art)?.let { v.setImageViewBitmap(R.id.slap_art, it) } ?: v.setImageViewResource(R.id.slap_art, R.drawable.widget_poster_blank)
                v.setImageViewResource(R.id.slap_play, R.drawable.ic_play)
                // Starting music needs the page (it keeps the queue): open Slap and carry on.
                v.setOnClickPendingIntent(R.id.slap_play, WidgetData.open(ctx, "/app/slap?play=1", 9404))
                v.setViewVisibility(R.id.slap_prev, View.GONE)
                v.setViewVisibility(R.id.slap_next, View.GONE)
            }
            return v
        }
    }
}
