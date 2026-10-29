package me.crcmz.app

import android.content.ComponentName
import android.content.Context
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import androidx.annotation.OptIn
import androidx.lifecycle.Lifecycle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Slap's music, played by the app (frontend/src/lib/nativeAudio.ts). The page keeps the
 * queue, shuffle, Listen Together and the play counts; the app plays the track, keeps
 * going with the phone locked (it's told the next track and moves on by itself when one
 * ends), and runs the lock screen, the media notification, headphones and Android Auto
 * (PlaybackService). Events go back to the page through window.__crcmzAudio. Same as
 * ios/CRCMZ/NativeAudio.swift.
 */
@OptIn(UnstableApi::class)
object NativeAudio {
    private var exo: ExoPlayer? = null
    private var controller: com.google.common.util.concurrent.ListenableFuture<MediaController>? = null
    private val main = Handler(Looper.getMainLooper())
    private var url: String? = null
    private var nextUrl: String? = null
    private var together = false
    private var meta = MediaMetadata.EMPTY
    private var artFor: String? = null
    private var art: ByteArray? = null
    private var announcedReady = false
    private var app: Context? = null
    private var audioManager: AudioManager? = null
    private var preCallVolume = 1f  // restored after duck

    /** The player, shared with PlaybackService's media session. */
    fun player(ctx: Context): ExoPlayer = exo ?: run {
        app = ctx.applicationContext
        audioManager = ctx.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        // The stream and the art need the signed-in page's session cookie.
        val http = DefaultHttpDataSource.Factory().setUserAgent("CRCMZ-Android/${BuildConfig.VERSION_NAME}")
        val withCookies = ResolvingDataSource.Factory(http) { spec ->
            val c = CookieManager.getInstance().getCookie(spec.uri.toString())
            if (c.isNullOrEmpty()) spec else spec.withAdditionalHeaders(mapOf("Cookie" to c))
        }
        ExoPlayer.Builder(ctx.applicationContext)
            .setMediaSourceFactory(DefaultMediaSourceFactory(withCookies))
            // handleAudioFocus=false: we manage focus manually so we can play through
            // WhatsApp calls while still yielding to other media apps (YouTube etc.).
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false)
            .setHandleAudioBecomingNoisy(true)   // headphones out: pause
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build().also { p ->
                exo = p
                p.addListener(events)
                tick()
            }
    }

    /** What the lock screen, the notification and Android Auto drive: their next / previous
     *  and play / pause go through the page too (Listen Together decides for the room). */
    fun sessionPlayer(ctx: Context): Player = object : ForwardingPlayer(player(ctx)) {
        override fun play() { super.play(); remote("play") }
        override fun pause() { super.pause(); remote("pause") }
        override fun seekTo(positionMs: Long) { super.seekTo(positionMs); remote("seekto", positionMs / 1000.0) }
        override fun seekToNext() = goNext()
        override fun seekToNextMediaItem() = goNext()
        override fun seekToPrevious() = goPrevious()
        override fun seekToPreviousMediaItem() = goPrevious()
        override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon()
            .add(Player.COMMAND_SEEK_TO_NEXT).add(Player.COMMAND_SEEK_TO_PREVIOUS).build()
        override fun isCommandAvailable(command: Int) =
            command == Player.COMMAND_SEEK_TO_NEXT || command == Player.COMMAND_SEEK_TO_PREVIOUS || super.isCommandAvailable(command)

    }

    private fun goNext() {
        // Solo: go now, even with the page asleep. Together: the room decides.
        val p = exo ?: return
        if (!together && p.mediaItemCount > 1) p.seekToNextMediaItem()
        remote("nexttrack")
    }

    private fun goPrevious() {
        val p = exo ?: return
        if (p.currentPosition > 3000) p.seekTo(0)
        remote("previoustrack")
    }

    // MARK: The Slap widget (Widgets.kt)

    class Now(val title: String, val artist: String, val art: ByteArray?, val playing: Boolean)

    /** What's loaded right now, or null (nothing, or the app was started fresh). A copy taken
     *  on the main thread: the widget draws on any thread, and the player is main-only. */
    @Volatile internal var snapshot: Now? = null   // internal: the debug build's widget screenshots set it
    fun now(): Now? = snapshot

    private fun snap() {
        val p = exo
        snapshot = if (p == null || p.mediaItemCount == 0 || url == null) null
        else Now(meta.title?.toString() ?: "Slap", meta.artist?.toString() ?: "", art, p.playWhenReady)
    }

    /** The widget's buttons. false: nothing to control here (the widget opens the app instead). */
    fun control(action: String): Boolean {
        val p = exo ?: return false
        if (p.mediaItemCount == 0 || url == null) return false
        when (action) {
            "toggle" -> if (p.playWhenReady) { p.pause(); remote("pause") } else { p.play(); remote("play") }
            "next" -> goNext()
            "prev" -> goPrevious()
        }
        return true
    }

    private fun widget() { snap(); app?.let { SlapWidget.update(it) } }

    // --- Audio focus (manual) ---
    // ExoPlayer's built-in focus handling blocks playback whenever a call holds
    // AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE (WhatsApp, phone calls). By managing
    // focus ourselves we can detect that case and play anyway, while still
    // yielding to other media apps (YouTube etc.) through normal AUDIOFOCUS_LOSS.
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        val p = exo ?: return@OnAudioFocusChangeListener
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                p.volume = preCallVolume
                if (p.playWhenReady) p.play()
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                p.pause(); remote("pause")
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                if (p.isPlaying) { p.pause(); remote("pause") }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                preCallVolume = p.volume; p.volume = 0.3f
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun requestFocus(): Boolean {
        val am = audioManager ?: return true
        val result = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return true
        // Focus denied — if a call is active, play anyway (user intentionally opened Slap during a call).
        val mode = am.mode
        return mode == AudioManager.MODE_IN_COMMUNICATION || mode == AudioManager.MODE_IN_CALL
    }

    @Suppress("DEPRECATION")
    private fun abandonFocus() { audioManager?.abandonAudioFocus(focusListener) }

    fun start(app: LauncherActivity) {
        player(app)
        // Binding a controller starts PlaybackService, which owns the media notification.
        if (controller == null) {
            controller = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
        }
    }

    // MARK: From the page

    fun handle(m: JSONObject) {
        val p = exo ?: return
        when (m.optString("type")) {
            "src" -> m.optString("url").takeIf { ours(it) }?.let { if (requestFocus()) load(it) }
            "stop" -> { p.stop(); p.clearMediaItems(); url = null; nextUrl = null; meta = MediaMetadata.EMPTY; abandonFocus(); widget() }
            "play" -> { if (requestFocus()) p.play() }
            "pause" -> p.pause()
            "seek" -> { p.seekTo((m.optDouble("time", 0.0) * 1000).toLong()); send("seeked") }
            "meta" -> meta(m)
            "volume" -> p.volume = m.optDouble("level", 1.0).toFloat().coerceIn(0f, 1f)
        }
    }

    private fun load(u: String) {
        val p = exo ?: return
        // Already playing it: the app moved on to this track by itself before the page caught up.
        if (u == url && p.mediaItemCount > 0) { resend(); return }
        url = u
        announcedReady = false
        p.setMediaItems(listOfNotNull(item(u), nextUrl?.takeIf { it != u }?.let { item(it, MediaMetadata.EMPTY) }))
        p.prepare()
    }

    private fun item(u: String, m: MediaMetadata = meta) =
        MediaItem.Builder().setUri(Uri.parse(u)).setMediaId(u).setMediaMetadata(m).build()

    private fun meta(m: JSONObject) {
        val p = exo ?: return
        together = m.optBoolean("together", false)
        val next = m.optString("next").takeIf { !m.isNull("next") && ours(it) }
        val now = m.optJSONObject("now")
        if (now != null) {
            val a = now.optString("art").takeIf { !now.isNull("art") && ours(it) }
            if (a != artFor) { artFor = a; art = null; a?.let { fetchArt(it) } }
            meta = MediaMetadata.Builder()
                .setTitle(now.optString("title", "Slap"))
                .setArtist(now.optString("artist"))
                .setAlbumTitle(now.optString("album"))
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .apply { art?.let { setArtworkData(it, MediaMetadata.PICTURE_TYPE_FRONT_COVER) } }
                .build()
            if (p.mediaItemCount > 0 && p.currentMediaItem?.mediaId == url) {
                p.replaceMediaItem(p.currentMediaItemIndex, item(url!!))
            }
            app?.let { SlapWidget.remember(it, meta.title?.toString() ?: "", meta.artist?.toString() ?: "", art) }
            widget()
        }
        if (next != nextUrl) {
            nextUrl = next
            // Keep exactly [current, next] in the player, so it moves on by itself.
            while (p.mediaItemCount > p.currentMediaItemIndex + 1) p.removeMediaItem(p.mediaItemCount - 1)
            if (next != null && p.mediaItemCount > 0) p.addMediaItem(item(next, MediaMetadata.EMPTY))
        }
    }

    private fun fetchArt(u: String) = thread {
        val bytes = runCatching {
            val c = URL(u).openConnection() as HttpURLConnection
            CookieManager.getInstance().getCookie(u)?.let { c.setRequestProperty("Cookie", it) }
            c.connectTimeout = 8000; c.readTimeout = 8000
            c.inputStream.use { it.readBytes() }.takeIf { BitmapFactory.decodeByteArray(it, 0, it.size) != null }
        }.getOrNull() ?: return@thread
        main.post {
            if (artFor != u) return@post
            art = bytes
            meta = meta.buildUpon().setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER).build()
            val p = exo ?: return@post
            if (p.mediaItemCount > 0 && p.currentMediaItem?.mediaId == url) p.replaceMediaItem(p.currentMediaItemIndex, item(url!!))
            app?.let { SlapWidget.remember(it, meta.title?.toString() ?: "", meta.artist?.toString() ?: "", bytes) }
            widget()
        }
    }

    // MARK: Player state → page

    private val events = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            val p = exo ?: return
            when (state) {
                Player.STATE_READY -> if (!announcedReady) { announcedReady = true; send("loadedmetadata") }
                Player.STATE_BUFFERING -> send("waiting")
                Player.STATE_ENDED -> send("ended")
                Player.STATE_IDLE -> Unit
            }
            if (state == Player.STATE_READY && p.isPlaying) send("playing")
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            val p = exo ?: return
            if (isPlaying) send("playing") else if (!p.playWhenReady) send("pause")
            widget()
        }

        override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
            val p = exo ?: return
            val id = item?.mediaId ?: return
            if (id == url) return
            // Moved on to the next track by itself (the end of a song, or next from the lock screen).
            url = id
            announcedReady = true
            nextUrl = null
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) send("ended")
            send("advanced", paused = !p.playWhenReady)
            // Drop the finished track: the player holds [current] until the page says what's next.
            while (p.currentMediaItemIndex > 0) p.removeMediaItem(0)
        }

        override fun onPlayerError(error: PlaybackException) = send("error")
    }

    private fun tick() {
        main.postDelayed({
            val p = exo
            // The page sleeps in the background; it gets the time again when it's back.
            val visible = LauncherActivity.current?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
            if (p != null && p.isPlaying && visible) send("timeupdate")
            tick()
        }, 500)
    }

    private fun resend() {
        val p = exo ?: return
        if (p.playbackState == Player.STATE_READY) send("loadedmetadata")
        send(if (p.isPlaying) "playing" else "pause")
    }

    private fun remote(action: String, time: Double? = null) {
        val m = JSONObject().put("event", "remote").put("action", action)
        time?.let { m.put("time", it) }
        post(m)
    }

    private fun send(event: String, paused: Boolean? = null) {
        val p = exo ?: return
        val m = JSONObject().put("event", event).put("time", p.currentPosition / 1000.0)
        if (p.duration != C.TIME_UNSET && p.duration > 0) m.put("duration", p.duration / 1000.0)
        paused?.let { m.put("paused", it) }
        post(m)
    }

    private fun post(m: JSONObject) {
        LauncherActivity.current?.js("window.__crcmzAudio && window.__crcmzAudio($m)")
    }

    private fun ours(u: String?) = u != null && Uri.parse(u).let { it.scheme == "https" && it.host == "app.crcmz.me" }
}
