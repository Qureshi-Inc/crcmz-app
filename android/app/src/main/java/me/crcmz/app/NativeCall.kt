package me.crcmz.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Huddle and the Watch Party's camera call, natively (LiveKit), so they keep going with
 * the app in the background and float in picture in picture. Same as
 * ios/CRCMZ/NativeCall.swift.
 *
 * The page still decides who you are and which room: it fetches the LiveKit token and
 * posts it here (frontend/src/lib/nativeCall.ts):
 *
 *     start  connect. Huddle: publish camera + mic, full screen. Watch: listen only,
 *            the cameras of whoever is on float over the party in a small panel.
 *     join   Watch: put your camera on (mic stays muted until you unmute).
 *     show   bring the call back up.
 *     end    the page left: hang up.
 *
 * Leave here hangs up and tells the page (window.__crcmzCallEnded).
 */
object NativeCall {
    enum class Kind(val key: String) { HUDDLE("huddle"), WATCH("watch") }
    enum class Mode { HIDDEN, PANEL, FULL }

    data class Tile(
        val id: String, val name: String, val track: VideoTrack?, val speaking: Boolean,
        val isLocal: Boolean, val micOn: Boolean,
    )

    var kind: Kind? = null; private set
    var title = ""; private set
    var tiles: List<Tile> = emptyList(); private set
    var micOn = false; private set
    var camOn = false; private set
    var connecting = false; private set
    var mode = Mode.HIDDEN
        set(v) { if (field != v) { field = v; changed() } }

    var room: Room? = null; private set
    private var events: Job? = null
    private val scope = MainScope()
    private val listeners = mutableSetOf<() -> Unit>()
    var onEnded: ((String) -> Unit)? = null

    fun listen(fn: () -> Unit) { listeners += fn }
    private var lastPip = false
    private var lastService = ""

    private fun changed() {
        listeners.forEach { it() }
        // Only on a real change: these restart system things (PiP params, the call service).
        if (wantsPip() != lastPip) { lastPip = wantsPip(); LauncherActivity.current?.updatePip() }
        val svc = "${live()}|$camOn|$micOn|$title"
        if (svc != lastService) { lastService = svc; CallService.sync() }
    }

    // MARK: From the page

    fun handle(app: LauncherActivity, m: JSONObject) {
        val k = Kind.entries.firstOrNull { it.key == m.optString("kind") } ?: return
        when (m.optString("type")) {
            "start" -> {
                val url = m.optString("url").takeIf { it.isNotEmpty() } ?: return
                val token = m.optString("token").takeIf { it.isNotEmpty() } ?: return
                start(app, k, url, token, m.optString("title", "CRCMZ"), m.optBoolean("publish"),
                    m.optBoolean("camera"), m.optBoolean("mic"))
            }
            "join" -> if (kind == k) {
                mode = if (k == Kind.HUDDLE) Mode.FULL else Mode.PANEL
                if (!camOn) toggleCamera(app)
            }
            "show" -> if (kind == k) mode = if (k == Kind.HUDDLE) Mode.FULL else Mode.PANEL
            "end" -> if (kind == k) hangUp(tellPage = false)
        }
    }

    private fun start(app: LauncherActivity, k: Kind, url: String, token: String, title: String,
                      publish: Boolean, camera: Boolean, mic: Boolean) {
        kind?.let { hangUp(tellPage = it != k) }
        kind = k
        this.title = title
        connecting = true
        mode = if (k == Kind.HUDDLE) Mode.FULL else Mode.HIDDEN
        val r = LiveKit.create(app.applicationContext)
        room = r
        events = scope.launch {
            r.events.collect { e ->
                when (e) {
                    is RoomEvent.Disconnected -> if (room === r) hangUp(tellPage = true)
                    else -> refresh()
                }
            }
        }
        scope.launch {
            try {
                r.connect(url, token)
                if (room !== r) return@launch
                if (publish) {
                    val want = buildList {
                        if (camera) add(Manifest.permission.CAMERA)
                        if (mic) add(Manifest.permission.RECORD_AUDIO)
                    }
                    app.withPermissions(want) { granted ->
                        scope.launch {
                            if (camera && Manifest.permission.CAMERA in granted) r.localParticipant.setCameraEnabled(true)
                            if (mic && Manifest.permission.RECORD_AUDIO in granted) r.localParticipant.setMicrophoneEnabled(true)
                            refresh()
                        }
                    }
                }
                connecting = false
                refresh()
            } catch (t: Throwable) {
                android.util.Log.w("crcmz", "call connect failed", t)
                if (room === r) hangUp(tellPage = true)
            }
        }
        changed()
    }

    // MARK: Controls

    fun toggleMic(app: LauncherActivity) {
        val r = room ?: return
        val on = !micOn
        val go = { scope.launch { r.localParticipant.setMicrophoneEnabled(on); refresh() } }
        if (on && !granted(app, Manifest.permission.RECORD_AUDIO)) {
            app.withPermissions(listOf(Manifest.permission.RECORD_AUDIO)) { if (it.isNotEmpty()) go() }
        } else go()
    }

    fun toggleCamera(app: LauncherActivity) {
        val r = room ?: return
        val on = !camOn
        val go = { scope.launch { r.localParticipant.setCameraEnabled(on); refresh() } }
        if (on && !granted(app, Manifest.permission.CAMERA)) {
            app.withPermissions(listOf(Manifest.permission.CAMERA)) { if (it.isNotEmpty()) go() }
        } else go()
    }

    fun flipCamera() {
        val t = room?.localParticipant?.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack ?: return
        t.switchCamera()
    }

    fun leave() = hangUp(tellPage = true)

    private fun hangUp(tellPage: Boolean) {
        val k = kind
        val r = room
        room = null
        events?.cancel()
        events = null
        kind = null
        tiles = emptyList()
        micOn = false
        camOn = false
        connecting = false
        mode = Mode.HIDDEN
        r?.disconnect()
        r?.release()
        changed()
        if (tellPage && k != null) onEnded?.invoke(k.key)
    }

    // MARK: Who's on

    private fun refresh() {
        val r = room ?: return
        val me = r.localParticipant
        micOn = me.isMicrophoneEnabled
        camOn = me.isCameraEnabled
        val out = mutableListOf<Tile>()
        // The Huddle shows you too; the party's panel is for the others (you see the movie).
        if (kind == Kind.HUDDLE || camOn) {
            out += Tile("me", "You", if (camOn) cameraOf(me) else null, me.isSpeaking, true, micOn)
        }
        // One person can be on from two tabs; each connection is its own tile.
        for (p in r.remoteParticipants.values.sortedBy { it.joinedAt ?: 0L }) {
            val track = if (p.isCameraEnabled) cameraOf(p) else null
            if (kind == Kind.WATCH && track == null && !p.isMicrophoneEnabled) continue   // just watching
            out += Tile(p.identity?.value ?: p.sid.value, p.name ?: "Someone", track, p.isSpeaking, false, p.isMicrophoneEnabled)
        }
        tiles = out
        if (kind == Kind.WATCH && mode == Mode.HIDDEN && out.any { it.track != null }) mode = Mode.PANEL
        if (kind == Kind.WATCH && mode == Mode.PANEL && out.isEmpty()) mode = Mode.HIDDEN
        changed()
    }

    private fun cameraOf(p: Participant): VideoTrack? =
        p.getTrackPublication(Track.Source.CAMERA)?.takeIf { !it.muted }?.track as? VideoTrack

    /** Who the floating window shows: whoever's talking, else the first other camera. */
    fun featured(): Tile? {
        val others = tiles.filter { !it.isLocal }
        return others.firstOrNull { it.speaking && it.track != null } ?: others.firstOrNull { it.track != null }
            ?: tiles.firstOrNull { it.track != null } ?: tiles.firstOrNull()
    }

    /** Leaving the app with a call on screen floats it. */
    fun wantsPip() = kind != null && mode != Mode.HIDDEN

    /** Mic or camera on: the call needs a foreground service to keep them in the background. */
    fun live() = kind != null && (micOn || camOn || kind == Kind.HUDDLE)

    private fun granted(ctx: Context, p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
}
