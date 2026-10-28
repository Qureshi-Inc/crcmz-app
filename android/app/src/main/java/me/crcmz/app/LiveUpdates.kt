package me.crcmz.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray

/**
 * Live updates (live.py on the server): a Watch Party, Huddle, Slap's Listen Together or a
 * tournament going on, as an ongoing notification for whoever turned it on in Settings.
 * FCM data {type: live, event: start|update|end, key, kind, title, body, count, started,
 * progress (-1 none, else 0..1), progressLabel, paused, url, segments}.
 *
 * Android 16+: a Live Update. ProgressStyle (a bar through the film or song, or one segment
 * per tournament match), promoted to the lock screen and a status-bar chip. Older phones:
 * an ongoing notification with a bar, or a "live for" clock. "Hide" keeps it away until
 * that session ends.
 *
 * A Watch Party has its own layout (watch()): "CRCMZ · Watch party · LIVE", the film, "3
 * watching · 1h 30m left", the poster, a thin bar, "Moiz, Noor +1 · 23:00 / 1:53:00", Join
 * party and Hide. As a Live Update it's the system's ProgressStyle card (a custom layout
 * would stop it being one). Where it can't be (older Android, or Live Updates off), the
 * standard collapsed template and a decorated expanded body (notif_watch_big.xml).
 * Extra fields for it: elapsed, duration (seconds) and poster (a signed link).
 */
object LiveUpdates {
    private const val CHANNEL = "live_v1"
    private const val HIDDEN = "live_hidden"

    fun handle(ctx: Context, d: Map<String, String>) {
        val key = d["key"] ?: return
        val nm = NotificationManagerCompat.from(ctx)
        if (d["event"] == "end") {
            nm.cancel(key, 0)
            hidden(ctx).remove(key).also { save(ctx) }
            return
        }
        if (key in hidden(ctx)) return
        channel(ctx)
        val n = when {
            d["kind"] == "watch" -> watch(ctx, d)
            Build.VERSION.SDK_INT >= 36 -> modern(ctx, d)
            else -> compat(ctx, d)
        }
        try {
            nm.notify(key, 0, n)
        } catch (_: SecurityException) { /* notifications are off for the app */ }
    }

    private fun icon(kind: String?) = when (kind) {
        "watch" -> R.drawable.ic_watch
        "huddle" -> R.drawable.ic_huddle
        "slap" -> R.drawable.ic_slap
        else -> R.drawable.ic_trophy
    }

    private fun emoji(kind: String?) = when (kind) {
        "watch" -> "📺"; "huddle" -> "🎧"; "slap" -> "🎵"; else -> "🏆"
    }

    /** The status-bar chip: short. "3 👀", "2 in the call", "Match 4/12". */
    private fun chip(d: Map<String, String>): String {
        val count = d["count"]?.toIntOrNull() ?: 0
        return when (d["kind"]) {
            "tourney" -> d["progressLabel"]?.replace("Match ", "")?.replace(" of ", "/")?.let { "🏆 $it" } ?: "🏆 Live"
            else -> "${emoji(d["kind"])} $count"
        }
    }

    private fun open(ctx: Context, d: Map<String, String>): PendingIntent = PendingIntent.getActivity(
        ctx, (d["key"] ?: "live").hashCode(),
        Intent(ctx, LauncherActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Ringer.appUri(d["url"]))
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun hide(ctx: Context, key: String): PendingIntent = PendingIntent.getBroadcast(
        ctx, key.hashCode() + 1, Intent(ctx, HideReceiver::class.java).putExtra("key", key),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun body(d: Map<String, String>): String =
        listOfNotNull(d["body"]?.takeIf { it.isNotBlank() }, d["progressLabel"]?.takeIf { it.isNotBlank() }).joinToString(" · ")

    @SuppressLint("NewApi")
    private fun modern(ctx: Context, d: Map<String, String>): Notification {
        val progress = d["progress"]?.toDoubleOrNull() ?: -1.0
        val started = d["started"]?.toLongOrNull() ?: System.currentTimeMillis()
        val accent = ctx.getColor(R.color.accent)
        val b = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(icon(d["kind"]))
            .setContentTitle(d["title"] ?: "CRCMZ")
            .setContentText(body(d))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open(ctx, d))
            // "Promote me" (a Live Update): the extra AndroidX's setRequestPromotedOngoing sets;
            // the platform has no public setter for it in API 36.
            .addExtras(android.os.Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
            .setShortCriticalText(chip(d))
            .setWhen(started)
            .addAction(Notification.Action.Builder(null, ctx.getString(R.string.live_hide), hide(ctx, d["key"]!!)).build())
        val segs = runCatching { JSONArray(d["segments"] ?: "[]") }.getOrNull()
        if (segs != null && segs.length() > 0) {
            // A tournament: one segment per match, filled as they're played.
            val style = Notification.ProgressStyle()
                .setProgressSegments((0 until segs.length()).map { Notification.ProgressStyle.Segment(1).setColor(accent) })
                .setProgress(((progress.coerceIn(0.0, 1.0)) * segs.length()).toInt())
                .setStyledByProgress(true)
                .setProgressTrackerIcon(Icon.createWithResource(ctx, icon(d["kind"])))
            b.setStyle(style)
        } else if (progress >= 0) {
            val style = Notification.ProgressStyle()
                .setProgressSegments(listOf(Notification.ProgressStyle.Segment(1000).setColor(accent)))
                .setProgress((progress.coerceIn(0.0, 1.0) * 1000).toInt())
                .setStyledByProgress(true)
                .setProgressTrackerIcon(Icon.createWithResource(ctx, icon(d["kind"])))
            b.setStyle(style)
        } else {
            b.setUsesChronometer(true).setShowWhen(true)   // a Huddle: "live for 12:34"
        }
        return b.build()
    }

    private fun compat(ctx: Context, d: Map<String, String>): Notification {
        val progress = d["progress"]?.toDoubleOrNull() ?: -1.0
        val started = d["started"]?.toLongOrNull() ?: System.currentTimeMillis()
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(icon(d["kind"]))
            .setColor(ctx.getColor(R.color.accent))
            .setContentTitle(d["title"] ?: "CRCMZ")
            .setContentText(body(d))
            .setSubText(chip(d))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(open(ctx, d))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setWhen(started)
            .addAction(0, ctx.getString(R.string.live_hide), hide(ctx, d["key"]!!))
        if (progress >= 0) b.setProgress(1000, (progress.coerceIn(0.0, 1.0) * 1000).toInt(), false)
        else b.setUsesChronometer(true).setShowWhen(true)
        return b.build()
    }

    // MARK: Watch Party

    /** 1:53:00, or 23:00 under an hour. */
    private fun clock(sec: Long): String {
        val h = sec / 3600; val m = (sec % 3600) / 60; val s = sec % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
    }

    /** 1h 30m left, 45m left, under a minute left. */
    private fun left(sec: Long): String {
        val h = sec / 3600; val m = (sec % 3600 + 59) / 60
        return when {
            sec < 60 -> "Under a minute left"
            h > 0 && m in 1..59 -> "${h}h ${m}m left"
            h > 0 -> "${h}h left"
            else -> "${m}m left"
        }
    }

    /** "3 watching · Moiz, Noor +1": the count, up to two names, then how many more. */
    private fun viewers(d: Map<String, String>): String {
        val count = d["count"]?.toIntOrNull() ?: 0
        val names = d["names"].orEmpty().split(", ").filter { it.isNotBlank() }
        val shown = names.take(2)
        val more = maxOf(0, count - shown.size)
        val who = if (shown.isEmpty()) "" else " · " + shown.joinToString(", ") + if (more > 0) " +$more" else ""
        return "$count watching$who"
    }

    private val posterCache = android.util.LruCache<String, android.graphics.Bitmap>(4)

    /** The film's poster for the artwork, small; null when there's none or it won't load
     *  (the notification just goes without). This runs on FCM's background thread. */
    private fun poster(url: String?): android.graphics.Bitmap? {
        if (url.isNullOrBlank() || !url.startsWith("https://")) return null
        posterCache.get(url)?.let { return it }
        return runCatching {
            val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            c.connectTimeout = 4000; c.readTimeout = 6000
            val bytes = c.inputStream.use { it.readBytes() }.also { c.disconnect() }
            val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            var sample = 1
            while (o.outHeight / (sample * 2) >= 256) sample *= 2
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
                android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
        }.getOrNull()?.also { posterCache.put(url, it) }
    }

    @SuppressLint("NewApi")
    private fun promotable(ctx: Context): Boolean = Build.VERSION.SDK_INT >= 36 &&
        runCatching { ctx.getSystemService(NotificationManager::class.java).canPostPromotedNotifications() }.getOrDefault(false)

    @SuppressLint("NewApi")
    private fun watch(ctx: Context, d: Map<String, String>): Notification {
        val paused = d["paused"] == "1"
        val elapsed = d["elapsed"]?.toLongOrNull() ?: 0
        val total = d["duration"]?.toLongOrNull() ?: 0
        val timed = total > 60
        val status = if (paused) ctx.getString(R.string.live_paused) else ctx.getString(R.string.live_live)
        val header = ctx.getString(R.string.live_watch_party) + " · " + status
        val film = d["title"]?.takeIf { it.isNotBlank() } ?: ctx.getString(R.string.live_watch_party)
        val count = d["count"]?.toIntOrNull() ?: 0
        // Collapsed: "3 watching · 1h 30m left". Expanded, a second line: "Moiz, Noor +1 · 23:00 / 1:53:00".
        val short = "$count watching" + if (timed) " · " + left(total - elapsed) else ""
        val names = viewers(d).substringAfter(" · ", "")
        val second = listOf(names, if (timed) clock(elapsed) + " / " + clock(total) else "").filter { it.isNotBlank() }.joinToString(" · ")
        val long = listOf(short, second).filter { it.isNotBlank() }.joinToString("\n")
        val art = poster(d["poster"])
        val join = open(ctx, d)
        val hideIt = hide(ctx, d["key"]!!)
        val accent = ctx.getColor(R.color.accent)

        // A Live Update (Android 16.1+, allowed for the app) is always shown expanded: the
        // ProgressStyle card. Anywhere it can collapse, the classic template, which keeps a
        // one-line collapsed text apart from the expanded one.
        if (promotable(ctx)) {
            val b = Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_watch)
                .setColor(accent)
                .setSubText(header)
                .setContentTitle(film)
                .setContentText(long)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(join)
                .addExtras(android.os.Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
                .setShortCriticalText(status)
                .addAction(Notification.Action.Builder(null, ctx.getString(R.string.live_join_party), join).build())
                .addAction(Notification.Action.Builder(null, ctx.getString(R.string.live_hide), hideIt).build())
            art?.let { b.setLargeIcon(Icon.createWithBitmap(it)) }
            if (timed) {
                b.setStyle(Notification.ProgressStyle()
                    .setProgressSegments(listOf(Notification.ProgressStyle.Segment(1000).setColor(accent)))
                    .setProgress((elapsed * 1000 / total).toInt().coerceIn(0, 1000))
                    .setStyledByProgress(true))
            }
            return b.build()
        }
        val pct = if (timed) (elapsed * 1000 / total).toInt().coerceIn(0, 1000) else 0
        val big = android.widget.RemoteViews(ctx.packageName, R.layout.notif_watch_big).apply {
            setTextViewText(R.id.nw_title, film)
            setTextViewText(R.id.nw_line1, short)
            setTextViewText(R.id.nw_line2, second)
            setViewVisibility(R.id.nw_line2, if (second.isBlank()) android.view.View.GONE else android.view.View.VISIBLE)
            if (timed) setProgressBar(R.id.nw_bar, 1000, pct, false) else setViewVisibility(R.id.nw_bar, android.view.View.GONE)
        }
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_watch)
            .setColor(accent)
            .setSubText(header)
            .setContentTitle(film)
            .setContentText(short)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomBigContentView(big)
            .setLargeIcon(art)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(join)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, ctx.getString(R.string.live_join_party), join)
            .addAction(0, ctx.getString(R.string.live_hide), hideIt)
        return b.build()
    }

    private fun channel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        // Default importance, no sound: it sits there and updates, it doesn't ping.
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, ctx.getString(R.string.live_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            })
    }

    // Keys the person hid, until those sessions end.
    private var hiddenCache: MutableSet<String>? = null
    private fun hidden(ctx: Context): MutableSet<String> =
        hiddenCache ?: (Push.prefs(ctx).getStringSet(HIDDEN, emptySet())?.toMutableSet() ?: mutableSetOf()).also { hiddenCache = it }
    private fun save(ctx: Context) = Push.prefs(ctx).edit().putStringSet(HIDDEN, hidden(ctx).toSet()).apply()

    class HideReceiver : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val key = intent.getStringExtra("key") ?: return
            hidden(ctx).add(key)
            save(ctx)
            NotificationManagerCompat.from(ctx).cancel(key, 0)
        }
    }
}
