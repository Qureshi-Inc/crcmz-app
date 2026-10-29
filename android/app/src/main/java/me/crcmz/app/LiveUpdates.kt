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
 * A Watch Party has its own layout (watch()). Its extra fields (live.py _state): session,
 * status (playing | paused | stale | ended), elapsed / duration / rate as of at (ms), rev,
 * people, joined, private, poster, stale and keep (seconds). Older messages without them
 * still work: they're read as before.
 */
object LiveUpdates {
    private const val CHANNEL = "live_v1"
    private const val HIDDEN = "live_hidden"
    private const val REV = "live_rev:"

    fun handle(ctx: Context, d: Map<String, String>) {
        val key = d["key"] ?: return
        val nm = NotificationManagerCompat.from(ctx)
        // Newer wins: FCM doesn't promise order, so a message older than one already shown is dropped.
        val rev = d["rev"]?.toLongOrNull() ?: 0L
        if (rev > 0) {
            val p = Push.prefs(ctx)
            if (rev < p.getLong(REV + key, 0L)) return
            p.edit().putLong(REV + key, rev).apply()
        }
        // Hide is per session (one party), so the next party in the same room still shows.
        val session = d["session"]?.takeIf { it.isNotBlank() } ?: key
        if (d["event"] == "end") {
            val keep = d["keep"]?.toLongOrNull() ?: 0L
            if (d["kind"] == "watch" && keep > 0 && session !in hidden(ctx) && showing(ctx, key)) {
                channel(ctx)
                post(ctx, key, watch(ctx, d + ("status" to "ended")))   // "ended" for a few minutes, then it goes
            } else {
                nm.cancel(key, 0)
            }
            hidden(ctx).remove(session)
            save(ctx)
            return
        }
        if (session in hidden(ctx)) return
        channel(ctx)
        val n = when {
            d["kind"] == "watch" -> watch(ctx, d)
            Build.VERSION.SDK_INT >= 36 -> modern(ctx, d)
            else -> compat(ctx, d)
        }
        post(ctx, key, n)
    }

    /** One notification per session key: an update replaces it, never adds another. */
    private fun post(ctx: Context, key: String, n: Notification) {
        try {
            NotificationManagerCompat.from(ctx).notify(key, 0, n)
        } catch (_: SecurityException) { /* notifications are off for the app */ }
    }

    private fun showing(ctx: Context, key: String): Boolean = runCatching {
        ctx.getSystemService(NotificationManager::class.java).activeNotifications.any { it.tag == key }
    }.getOrDefault(false)

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

    private fun hide(ctx: Context, key: String, session: String? = null): PendingIntent = PendingIntent.getBroadcast(
        ctx, key.hashCode() + 1, Intent(ctx, HideReceiver::class.java).putExtra("key", key).putExtra("session", session ?: key),
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
            .addAction(Notification.Action.Builder(null, ctx.getString(R.string.live_hide), hide(ctx, d["key"]!!, d["session"])).build())
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
            .addAction(0, ctx.getString(R.string.live_hide), hide(ctx, d["key"]!!, d["session"]))
        if (progress >= 0) b.setProgress(1000, (progress.coerceIn(0.0, 1.0) * 1000).toInt(), false)
        else b.setUsesChronometer(true).setShowWhen(true)
        return b.build()
    }

    // MARK: Watch Party

    /** 1:53:00, or 23:00 under an hour. */
    private fun clock(sec: Long): String {
        val s0 = maxOf(0L, sec)
        val h = s0 / 3600; val m = (s0 % 3600) / 60; val s = s0 % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
    }

    /** 1h 30m left, 45m left, Under a minute left. */
    private fun left(ctx: Context, sec: Long): String {
        val h = sec / 3600; val m = (sec % 3600 + 59) / 60
        return when {
            sec < 60 -> ctx.getString(R.string.live_left_under)
            h > 0 && m in 1..59 -> ctx.getString(R.string.live_left_hm, h, m)
            h > 0 -> ctx.getString(R.string.live_left_h, h)
            else -> ctx.getString(R.string.live_left_m, m)
        }
    }

    /** "3 watching", "1.2K watching", or nobody yet. */
    private fun watching(ctx: Context, count: Int): String =
        if (count <= 0) ctx.getString(R.string.live_no_one) else ctx.getString(R.string.live_watching, compact(count))

    /** 1238 -> 1.2K: a count that fits a notification line. */
    private fun compact(n: Int): String = if (n < 1000) n.toString() else android.icu.text.CompactDecimalFormat.getInstance(
        java.util.Locale.getDefault(), android.icu.text.CompactDecimalFormat.CompactStyle.SHORT).format(n)

    /** "Moiz, Noor +1": the server's summary, or (older servers) up to two names, then how many more. */
    private fun people(d: Map<String, String>): String {
        d["people"]?.let { return it }
        val count = d["count"]?.toIntOrNull() ?: 0
        val shown = d["names"].orEmpty().split(", ").filter { it.isNotBlank() }.take(2)
        val more = maxOf(0, count - shown.size)
        return if (shown.isEmpty()) "" else shown.joinToString(", ") + if (more > 0) " +" + compact(more) else ""
    }

    private val posterCache = android.util.LruCache<String, android.graphics.Bitmap>(4)

    /** The film's poster for the artwork, small; null when there's none or it won't load.
     *  This runs on FCM's background thread. */
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

    private var fallbackArt: android.graphics.Bitmap? = null

    /** No poster (none yet, or it wouldn't load): the party's TV glyph on a faint accent tile. */
    private fun fallback(ctx: Context): android.graphics.Bitmap = fallbackArt ?: run {
        val px = (64 * ctx.resources.displayMetrics.density).toInt()
        val bmp = android.graphics.Bitmap.createBitmap(px, px, android.graphics.Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val r = px * 0.2f
        c.drawRoundRect(0f, 0f, px.toFloat(), px.toFloat(), r, r,
            android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = ctx.getColor(R.color.accent_track) })
        ctx.getDrawable(R.drawable.ic_watch)?.mutate()?.let {
            it.setTint(ctx.getColor(R.color.accent))
            val pad = (px * 0.25f).toInt()
            it.setBounds(pad, pad, px - pad, px - pad)
            it.draw(c)
        }
        bmp.also { fallbackArt = it }
    }

    @SuppressLint("NewApi")
    private fun promotable(ctx: Context): Boolean = Build.VERSION.SDK_INT >= 36 &&
        runCatching { ctx.getSystemService(NotificationManager::class.java).canPostPromotedNotifications() }.getOrDefault(false)

    /** This phone is in that party's call right now. */
    private fun inParty(key: String): Boolean = runCatching {
        NativeCall.room?.name == "watch-" + key.removePrefix("watch:")
    }.getOrDefault(false)

    /** The server's shared state, read the same way as the iPhone (ios/Shared/WidgetViews.swift FilmClock). */
    private class Party(ctx: Context, d: Map<String, String>) {
        val status = d["status"]?.takeIf { it in setOf("playing", "paused", "stale", "ended") }
            ?: if (d["paused"] == "1") "paused" else "playing"
        val ended = status == "ended"
        val duration = d["duration"]?.toLongOrNull() ?: 0L
        val timed = duration > 60 && !ended
        /** Where the film is now: as of `at`, run on at `rate` while it plays (frozen when
         *  paused, reconnecting or over). Older servers: elapsed as sent. */
        val position: Long = run {
            val elapsed = d["elapsed"]?.toLongOrNull() ?: 0L
            val at = d["at"]?.toLongOrNull() ?: 0L
            val rate = d["rate"]?.toDoubleOrNull() ?: 1.0
            val run = if (status == "playing" && at > 0) ((System.currentTimeMillis() - at) / 1000.0 * rate).toLong() else 0L
            (elapsed + maxOf(0L, run)).coerceIn(0L, if (duration > 0) duration else Long.MAX_VALUE)
        }
        val label = ctx.getString(when (status) {
            "paused" -> R.string.live_paused
            "stale" -> R.string.live_reconnecting
            "ended" -> R.string.live_ended
            else -> R.string.live_live
        })
        // "RECONNECTING" doesn't fit the header beside the app name: it leads the line instead.
        val header = ctx.getString(R.string.live_watch_party) + if (status == "stale") "" else " · " + label
        val film = d["title"]?.takeIf { it.isNotBlank() } ?: ctx.getString(R.string.live_watch_party)
        val count = d["count"]?.toIntOrNull() ?: 0
        val joined = d["joined"] == "1" || inParty(d["key"].orEmpty())
        val permil = if (timed) (position * 1000 / duration).toInt().coerceIn(0, 1000) else 0
    }

    /**
     * The Watch Party: the system's own templates, so it keeps the system's header, sizes,
     * dark and light, large text and screen readers (and One UI's look on Samsung). The one
     * custom piece is the expanded body with the bar (notif_watch_big.xml says why).
     *  Collapsed  header "Watch party · LIVE", the film, "3 watching · 1h 30m left", the poster
     *  Expanded   + "Moiz, Noor +1 · 23:00 / 1:53:00", the bar, Join party (Open party when
     *             you're in it) and Hide
     *  Lock screen (when the phone hides sensitive content): "Watch party · LIVE", "3 watching"
     * A Live Update (Android 16, ProgressStyle, status-bar chip) only for someone in the
     * party: it's then their own ongoing activity, which is what Live Updates are for.
     * Everyone else gets the ordinary notification. Nothing comes for a while (the server
     * sends at least every 10 minutes): it times out rather than claim to be live.
     */
    @SuppressLint("NewApi")
    private fun watch(ctx: Context, d: Map<String, String>): Notification {
        val p = Party(ctx, d)
        val key = d["key"]!!
        val short = if (p.ended) ctx.getString(R.string.live_party_ended)
            else listOf(if (p.status == "stale") ctx.getString(R.string.live_reconnecting_line) else "", watching(ctx, p.count),
                        if (p.timed && p.status != "stale") left(ctx, p.duration - p.position) else "").filter { it.isNotBlank() }.joinToString(" · ")
        val second = if (p.ended) "" else listOf(people(d), if (p.timed) clock(p.position) + " / " + clock(p.duration) else "")
            .filter { it.isNotBlank() }.joinToString(" · ")
        val long = listOf(short, second).filter { it.isNotBlank() }.joinToString("\n")
        val art = poster(d["poster"]) ?: fallback(ctx)
        val open = open(ctx, d)
        val accent = ctx.getColor(R.color.accent)
        val primary = ctx.getString(if (p.joined) R.string.live_open_party else R.string.live_join_party)
        val staleMs = (d["stale"]?.toLongOrNull() ?: 900L) * 1000 + 60_000
        val keepMs = (d["keep"]?.toLongOrNull() ?: 300L).coerceAtLeast(5L) * 1000
        val public = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_watch).setColor(accent)
            .setContentTitle(p.header)
            .setContentText(if (p.ended) ctx.getString(R.string.live_party_ended) else watching(ctx, p.count))
            .setOngoing(!p.ended).setSilent(true).setShowWhen(false)
            .build()

        if (!p.ended && p.joined && promotable(ctx)) {
            val b = Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_watch)
                .setColor(accent)
                .setSubText(p.header)
                .setContentTitle(p.film)
                .setContentText(long)
                .setLargeIcon(Icon.createWithBitmap(art))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(open)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(public)
                .setTimeoutAfter(staleMs)
                .addExtras(android.os.Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
                .setShortCriticalText(p.label)
                .addAction(Notification.Action.Builder(null, primary, open).build())
                .addAction(Notification.Action.Builder(null, ctx.getString(R.string.live_hide), hide(ctx, key, d["session"])).build())
            if (p.timed) {
                // A plain bar: no tracker icon riding along it.
                b.setStyle(Notification.ProgressStyle()
                    .setProgressSegments(listOf(Notification.ProgressStyle.Segment(1000).setColor(accent)))
                    .setProgress(p.permil)
                    .setStyledByProgress(true))
            }
            return b.build()
        }
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_watch)
            .setColor(accent)
            .setSubText(p.header)
            .setContentTitle(p.film)
            .setContentText(short)
            .setLargeIcon(art)
            .setOngoing(!p.ended)
            .setAutoCancel(p.ended)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setTimeoutAfter(if (p.ended) keepMs else staleMs)
        if (p.timed) {
            // Collapsed: the standard template (its own bar would take the place of
            // "3 watching · 1h 30m left"). Expanded: the same lines with the bar under them.
            val big = android.widget.RemoteViews(ctx.packageName, R.layout.notif_watch_big).apply {
                setTextViewText(R.id.nw_title, p.film)
                setTextViewText(R.id.nw_line1, short)
                // Beside the poster there's room for the names, not names and times: the
                // times go under the bar.
                val names = people(d)
                setTextViewText(R.id.nw_line2, names)
                setViewVisibility(R.id.nw_line2, if (names.isBlank()) android.view.View.GONE else android.view.View.VISIBLE)
                setProgressBar(R.id.nw_bar, 1000, p.permil, false)
                setTextViewText(R.id.nw_time, clock(p.position) + " / " + clock(p.duration))
            }
            b.setStyle(NotificationCompat.DecoratedCustomViewStyle()).setCustomBigContentView(big)
        } else {
            b.setStyle(NotificationCompat.BigTextStyle().bigText(long))
        }
        if (!p.ended) {
            b.addAction(0, primary, open)
            b.addAction(0, ctx.getString(R.string.live_hide), hide(ctx, key, d["session"]))
        }
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

    // Sessions the person hid (key@start; just the key from servers before sessions), until
    // each ends. Kept short: an end that never arrived doesn't pile them up.
    private var hiddenCache: MutableSet<String>? = null
    private fun hidden(ctx: Context): MutableSet<String> =
        hiddenCache ?: (Push.prefs(ctx).getStringSet(HIDDEN, emptySet())?.toMutableSet() ?: mutableSetOf()).also { hiddenCache = it }
    private fun save(ctx: Context) {
        val h = hidden(ctx)
        while (h.size > 40) h.remove(h.first())
        Push.prefs(ctx).edit().putStringSet(HIDDEN, h.toSet()).apply()
    }

    /** Hide: this session's notification off this phone. The party, the playback and
     *  everyone else are untouched; the next party shows again. */
    class HideReceiver : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val key = intent.getStringExtra("key") ?: return
            hidden(ctx).add(intent.getStringExtra("session") ?: key)
            save(ctx)
            NotificationManagerCompat.from(ctx).cancel(key, 0)
        }
    }
}
