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
        val isLocal: Boolean, val micOn: Boolean, val isScreen: Boolean = false, val hand: Boolean = false,
    )
    data class Reaction(val id: Int, val name: String, val emoji: String)

    const val TOPIC = "crcmz-huddle"
    val REACTIONS = listOf("👍", "😂", "🔥", "👏", "❤️", "😮")

    var kind: Kind? = null; private set
    var title = ""; private set
    var tiles: List<Tile> = emptyList(); private set
    var micOn = false; private set
    var camOn = false; private set
    var connecting = false; private set
    var mode = Mode.HIDDEN
        set(v) { if (field != v) { field = v; changed() } }
    var myHand = false; private set
    var sharing = false; private set
    var transcribing = false; private set
    var reactions: List<Reaction> = emptyList(); private set
    /** The AI chat: the page keeps it and asks the AI; the call screen's sheet shows it. */
    data class AiMsg(val role: String, val text: String)
    var aiLog: List<AiMsg> = emptyList(); private set
    var aiBusy = false; private set
    /** Told when the AI chat changes (the open sheet redraws). */
    var onAi: (() -> Unit)? = null
    private val hands = mutableMapOf<String, String>()   // identity -> name
    private var rxSeq = 0
    private var transcriber: Transcriber? = null
    /** To the page: (kind, message, from name, from id). Own transcript lines come as id "me". */
    var onData: ((String, JSONObject, String, String) -> Unit)? = null

    var room: Room? = null; private set
    private var events: Job? = null
    private val scope = MainScope()
    private val listeners = mutableSetOf<() -> Unit>()
    var onEnded: ((String) -> Unit)? = null

    fun listen(fn: () -> Unit) { listeners += fn }
    private var lastPip = false
    private var lastService = ""

    fun changed() {
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
            "data" -> if (kind == k) {
                val payload = m.optJSONObject("payload") ?: return
                publish(payload)
                when (payload.optString("t")) {
                    "hand" -> { myHand = payload.optBoolean("up"); refresh() }
                    "rx" -> showReaction("You", payload.optString("e"))
                }
            }
            "transcript" -> if (kind == k) setTranscript(app, m.optBoolean("on"))
            "ai" -> {
                val log = m.optJSONArray("log")
                aiLog = (0 until (log?.length() ?: 0)).mapNotNull { i ->
                    log?.optJSONObject(i)?.let { AiMsg(it.optString("role", "note"), it.optString("text")) }
                }
                aiBusy = m.optBoolean("busy")
                onAi?.invoke()
            }
            "volume" -> if (kind == k) {
                val level = m.optDouble("level", 1.0).coerceIn(0.0, 1.0)
                room?.remoteParticipants?.values?.forEach { p ->
                    (p.getTrackPublication(Track.Source.MICROPHONE)?.track as? io.livekit.android.room.track.RemoteAudioTrack)
                        ?.setVolume(level * 10.0)
                }
            }
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
                    is RoomEvent.DataReceived -> receive(e.data, e.participant?.identity?.value ?: "", e.participant?.name ?: "Someone", e.topic)
                    is RoomEvent.ParticipantConnected -> {
                        // Newcomers learn who has a hand up and who's recording.
                        if (myHand) publish(JSONObject().put("t", "hand").put("up", true))
                        if (transcribing) publish(JSONObject().put("t", "rec").put("on", true))
                        refresh()
                    }
                    is RoomEvent.ParticipantDisconnected -> { hands.remove(e.participant.identity?.value); refresh() }
                    else -> refresh()
                }
            }
        }
        scope.launch {
            try {
                r.connect(url, token)
                if (room !== r) return@launch
                // Ask the room to repeat hands / recording we'd otherwise have missed.
                publish(JSONObject().put("t", "sync"))
                if (publish) {
                    val want = buildList {
                        if (camera) add(Manifest.permission.CAMERA)
                        if (mic) add(Manifest.permission.RECORD_AUDIO)
                    }
                    app.withPermissions(want) { granted ->
                        // The call may have ended or restarted while Android asked: only this one.
                        safely(r) {
                            if (camera && Manifest.permission.CAMERA in granted) r.localParticipant.setCameraEnabled(true)
                            if (mic && Manifest.permission.RECORD_AUDIO in granted) r.localParticipant.setMicrophoneEnabled(true)
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
        val go = { safely(r) { r.localParticipant.setMicrophoneEnabled(on) } }
        if (on && !granted(app, Manifest.permission.RECORD_AUDIO)) {
            app.withPermissions(listOf(Manifest.permission.RECORD_AUDIO)) { if (it.isNotEmpty()) go() }
        } else go()
    }

    fun toggleCamera(app: LauncherActivity) {
        val r = room ?: return
        val on = !camOn
        val go = { safely(r) { r.localParticipant.setCameraEnabled(on) } }
        if (on && !granted(app, Manifest.permission.CAMERA)) {
            app.withPermissions(listOf(Manifest.permission.CAMERA)) { if (it.isNotEmpty()) go() }
        } else go()
    }

    /** Run a call action on room [r] only while it's still the call, and never crash the app
     *  over it (a closed room throws). */
    private fun safely(r: Room, block: suspend () -> Unit) = scope.launch {
        if (room !== r) return@launch
        try { block() } catch (t: Throwable) { android.util.Log.w("crcmz", "call action failed", t) }
        if (room === r) refresh()
    }

    fun flipCamera() {
        val t = room?.localParticipant?.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack ?: return
        runCatching { t.switchCamera() }
    }

    fun leave() = hangUp(tellPage = true)

    fun toggleHand() {
        myHand = !myHand
        publish(JSONObject().put("t", "hand").put("up", myHand))
        onData?.invoke("huddle", JSONObject().put("t", "hand_self").put("up", myHand), "You", "me")
        refresh()
    }

    fun react(e: String) {
        if (e !in REACTIONS) return
        publish(JSONObject().put("t", "rx").put("e", e))
        showReaction("You", e)
    }

    /** Set when the panel should move to the top (the AI helper's input is at the bottom). */
    var panelTop = false

    /** The AI chat, over the call (AiSheet). The page has the history; ask it to send it. */
    fun openAI(app: LauncherActivity) {
        AiSheet.show(app)
        onData?.invoke("huddle", JSONObject().put("t", "ai_open"), "You", "me")
    }

    /** Ask the AI. [transcribe]: start the transcript first, so it can follow the call. */
    fun askAI(text: String, transcribe: Boolean) {
        val q = text.trim()
        if (q.isEmpty() || aiBusy) return
        onData?.invoke("huddle", JSONObject().put("t", "ai_ask").put("text", q.take(1000)).put("transcribe", transcribe), "You", "me")
    }

    fun retryAI() { onData?.invoke("huddle", JSONObject().put("t", "ai_retry"), "You", "me") }

    /** Share this phone's screen (Android asks first), or stop. */
    fun toggleShare(app: LauncherActivity) {
        val r = room ?: return
        if (sharing) {
            safely(r) { r.localParticipant.setScreenShareEnabled(false); sharing = false }
            return
        }
        app.askScreenCapture { data ->
            if (data == null || room !== r) return@askScreenCapture
            scope.launch {
                try {
                    sharing = r.localParticipant.setScreenShareEnabled(true,
                        io.livekit.android.room.track.screencapture.ScreenCaptureParams(data, onStop = {
                            scope.launch { sharing = false; refresh() }
                        }))
                } catch (t: Throwable) {
                    android.util.Log.w("crcmz", "screen share failed", t)
                    sharing = false
                }
                refresh()
            }
        }
    }

    private fun showReaction(name: String, e: String) {
        if (e !in REACTIONS) return
        val id = ++rxSeq
        reactions = (reactions + Reaction(id, name, e)).takeLast(12)
        changed()
        scope.launch {
            kotlinx.coroutines.delay(3200)
            reactions = reactions.filter { it.id != id }
            changed()
        }
    }

    // MARK: The data channel and the transcript

    private fun publish(payload: JSONObject) {
        val r = room ?: return
        scope.launch {
            runCatching { r.localParticipant.publishData(payload.toString().toByteArray(), io.livekit.android.room.track.DataPublishReliability.RELIABLE, TOPIC) }
        }
    }

    private fun receive(data: ByteArray, id: String, name: String, topic: String?) {
        if (topic != TOPIC || id.isEmpty()) return
        val k = kind ?: return
        val m = runCatching { JSONObject(String(data)) }.getOrNull() ?: return
        when (m.optString("t")) {
            "sync" -> {
                if (myHand) publish(JSONObject().put("t", "hand").put("up", true))
                if (transcribing) publish(JSONObject().put("t", "rec").put("on", true))
                return
            }
            "hand" -> { if (m.optBoolean("up")) hands[id] = name else hands.remove(id); refresh() }
            "rx" -> showReaction(name, m.optString("e"))
            // Someone turned the transcript on (or off) for the whole call: this phone too.
            "rec" -> if (m.optBoolean("all")) LauncherActivity.current?.let { setTranscript(it, m.optBoolean("on")) }
        }
        onData?.invoke(k.key, m, name, id)
    }

    /** The call screen's Notes button: the transcript on or off for everyone in the call. */
    fun toggleTranscript(app: LauncherActivity) = setTranscript(app, !transcribing, all = true)

    /** [all]: tell everyone's phone to do the same (the whole call goes into the notes). */
    private fun setTranscript(app: LauncherActivity, on: Boolean, all: Boolean = false) {
        if (kind != Kind.HUDDLE || on == transcribing) return
        val r = room ?: return
        if (on && !micOn) {
            onData?.invoke("huddle", JSONObject().put("t", "transcribing").put("on", false)
                .put("note", "Unmute your mic to start the transcript."), "You", "me")
            return
        }
        transcribing = on
        if (on) {
            val track = r.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track as? io.livekit.android.room.track.LocalAudioTrack
            transcriber = Transcriber(scope) { text -> ownLine(text) }.also { it.start(track) }
        } else {
            transcriber?.stop(); transcriber = null
        }
        publish(JSONObject().put("t", "rec").put("on", on).apply { if (all) put("all", true) })
        onData?.invoke("huddle", JSONObject().put("t", "transcribing").put("on", on)
            .put("note", if (on) "Transcript on for everyone in the call. The meeting notes are saved when the call ends." else "Transcript off."), "You", "me")
        changed()
    }

    private fun ownLine(text: String) {
        publish(JSONObject().put("t", "line").put("text", text))
        onData?.invoke("huddle", JSONObject().put("t", "line").put("text", text), "You", "me")
    }

    private fun hangUp(tellPage: Boolean) {
        val k = kind
        val r = room
        room = null
        events?.cancel()
        events = null
        kind = null
        tiles = emptyList()
        hands.clear()
        myHand = false
        sharing = false
        reactions = emptyList()
        AiSheet.dismiss()
        transcriber?.stop(); transcriber = null
        transcribing = false
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
            out += Tile("me", "You", if (camOn) cameraOf(me) else null, me.isSpeaking, true, micOn, hand = myHand)
        }
        // One person can be on from two tabs; each connection is its own tile.
        for (p in r.remoteParticipants.values.sortedBy { it.joinedAt ?: 0L }) {
            val track = if (p.isCameraEnabled) cameraOf(p) else null
            if (kind == Kind.WATCH && track == null && !p.isMicrophoneEnabled) continue   // just watching
            val pid = p.identity?.value ?: p.sid.value
            out += Tile(pid, p.name ?: "Someone", track, p.isSpeaking, false, p.isMicrophoneEnabled, hand = hands.containsKey(pid))
            // A shared screen is its own tile, and the one the floating window shows.
            (p.getTrackPublication(Track.Source.SCREEN_SHARE)?.takeIf { !it.muted }?.track as? VideoTrack)?.let {
                out += Tile("$pid:screen", "${p.name ?: "Someone"}'s screen", it, false, false, true, isScreen = true)
            }
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
        return others.firstOrNull { it.isScreen } ?: others.firstOrNull { it.speaking && it.track != null } ?: others.firstOrNull { it.track != null }
            ?: tiles.firstOrNull { it.track != null } ?: tiles.firstOrNull()
    }

    /** Leaving the app with a call on screen floats it. */
    fun wantsPip() = kind != null && mode != Mode.HIDDEN

    /** Mic or camera on: the call needs a foreground service to keep them in the background. */
    fun live() = kind != null && (micOn || camOn || kind == Kind.HUDDLE)

    private fun granted(ctx: Context, p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
}
