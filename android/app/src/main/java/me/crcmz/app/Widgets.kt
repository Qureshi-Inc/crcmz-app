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
 *   Live now             what's on (Watch Party, Huddle, Listen Together, a tournament)
 *   New in the library   the newest films, each opens its page
 *   Add a movie          straight into the movie search
 * Refreshed when a widget asks (every 30 min), when a live update arrives, and when the
 * app comes to the front. Signed out: they say so and open the app.
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
            AddMovieWidget::class.java to ::addViews,
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
        arrayOf(R.id.mv_cell1, R.id.mv_img1, R.id.mv_title1), arrayOf(R.id.mv_cell2, R.id.mv_img2, R.id.mv_title2),
        arrayOf(R.id.mv_cell3, R.id.mv_img3, R.id.mv_title3), arrayOf(R.id.mv_cell4, R.id.mv_img4, R.id.mv_title4),
    )

    fun movieViews(ctx: Context): RemoteViews {
        val v = RemoteViews(ctx.packageName, R.layout.widget_movies)
        v.setOnClickPendingIntent(R.id.mv_head, open(ctx, "/app/watch", 9200))
        v.setOnClickPendingIntent(R.id.mv_add, open(ctx, "/app/watch?add=1", 9201))
        val movies = cached(ctx)?.optJSONArray("movies") ?: JSONArray()
        posters.forEachIndexed { i, cell ->
            if (i >= movies.length()) { v.setViewVisibility(cell[0], View.INVISIBLE); return@forEachIndexed }
            val m = movies.getJSONObject(i)
            v.setViewVisibility(cell[0], View.VISIBLE)
            v.setTextViewText(cell[2], m.optString("title"))
            poster(ctx, m.optString("poster"))?.let { b -> v.setImageViewBitmap(cell[1], b) } ?: v.setImageViewResource(cell[1], R.drawable.widget_poster_blank)
            v.setOnClickPendingIntent(cell[0], open(ctx, m.optString("url", "/app/watch"), 9210 + i))
        }
        v.setViewVisibility(R.id.mv_empty, if (movies.length() == 0) View.VISIBLE else View.GONE)
        v.setTextViewText(R.id.mv_empty, ctx.getString(if (isSignedOut(ctx)) R.string.widget_signed_out else R.string.widget_no_movies))
        return v
    }

    fun addViews(ctx: Context): RemoteViews =
        RemoteViews(ctx.packageName, R.layout.widget_add).apply { setOnClickPendingIntent(R.id.add_root, open(ctx, "/app/watch?add=1", 9300)) }

    // Posters: small, decoded once, kept in memory (a widget update can't hold much).
    private val posterCache = object : android.util.LruCache<String, Bitmap>(12) {}
    private fun poster(ctx: Context, url: String): Bitmap? {
        if (url.isBlank()) return null
        posterCache.get(url)?.let { return it }
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return null   // drawn again off the main thread
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 8000; c.readTimeout = 10_000
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
class AddMovieWidget : CrcmzWidget()
