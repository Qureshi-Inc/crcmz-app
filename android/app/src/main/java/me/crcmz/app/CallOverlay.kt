package me.crcmz.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon

/**
 * The native call on top of the web page (NativeCall): full screen for a Huddle, or a
 * small panel you can drag around (the party's cameras over the movie, or a minimised
 * Huddle), or just the person talking in picture in picture. Same as
 * ios/CRCMZ/CallOverlay.swift.
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class CallOverlay(private val app: LauncherActivity, private val root: FrameLayout) {
    private val ink = ContextCompat.getColor(app, R.color.bg)
    private val accent = ContextCompat.getColor(app, R.color.accent_soft)
    private var top = 0
    private var bottom = 0
    private var inPip = false

    // Full screen
    private val full = FrameLayout(app).apply { setBackgroundColor(ink); visibility = View.GONE; isClickable = true }
    private val titleView = TextView(app).apply { setTextColor(Color.WHITE); textSize = 17f; gravity = Gravity.CENTER }
    private val subView = TextView(app).apply { setTextColor(ContextCompat.getColor(app, R.color.muted)); textSize = 13f; gravity = Gravity.CENTER }
    private val grid = GridLayout(app)
    private val fullControls = LinearLayout(app).apply { gravity = Gravity.CENTER }
    private val fullColumn = LinearLayout(app).apply { orientation = LinearLayout.VERTICAL }

    // Panel
    private val panel = LinearLayout(app).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        background = GradientDrawable().apply { cornerRadius = dp(18f); setColor(Color.argb(220, 5, 3, 15)) }
        elevation = dp(8f)
        setPadding(dp(6), dp(6), dp(6), dp(6))
    }
    private val panelTiles = LinearLayout(app)
    private val panelControls = LinearLayout(app).apply { gravity = Gravity.CENTER }

    // Picture in picture
    private val pipBox = FrameLayout(app).apply { setBackgroundColor(Color.BLACK); visibility = View.GONE }

    private var holders = mutableMapOf<String, TileHolder>()
    private var holderRoom: Room? = null

    init {
        val head = LinearLayout(app).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            addView(round(R.drawable.ic_down, "Minimise the call", 44) { NativeCall.mode = NativeCall.Mode.PANEL })
            addView(LinearLayout(app).apply {
                orientation = LinearLayout.VERTICAL
                addView(titleView); addView(subView)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(round(R.drawable.ic_expand, "Picture in picture", 44) { app.enterPip() })
        }
        fullColumn.addView(head)
        fullColumn.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply { setMargins(dp(8), 0, dp(8), dp(8)) })
        fullColumn.addView(fullControls, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })
        full.addView(fullColumn)
        root.addView(full, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        panel.addView(panelTiles)
        panel.addView(panelControls, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
        root.addView(panel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END))
        drag(panel)

        root.addView(pipBox, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        NativeCall.listen { render() }
    }

    fun insets(top: Int, bottom: Int) {
        this.top = top
        this.bottom = bottom
        fullColumn.setPadding(0, top, 0, bottom)
        placePanel()
    }

    /** Back: a full-screen call shrinks to the panel first. */
    fun back(): Boolean {
        if (NativeCall.mode != NativeCall.Mode.FULL) return false
        NativeCall.mode = NativeCall.Mode.PANEL
        return true
    }

    fun pip(on: Boolean) {
        inPip = on
        render()
    }

    private var layoutKey = ""
    private var controlsKey = ""

    private fun render() {
        val r = NativeCall.room
        if (r !== holderRoom) { holders.values.forEach { it.release() }; holders = mutableMapOf(); holderRoom = r; layoutKey = "" }
        val mode = NativeCall.mode
        full.visibility = if (mode == NativeCall.Mode.FULL && !inPip) View.VISIBLE else View.GONE
        panel.visibility = if (mode == NativeCall.Mode.PANEL && !inPip) View.VISIBLE else View.GONE
        pipBox.visibility = if (inPip && NativeCall.kind != null) View.VISIBLE else View.GONE
        if (r == null || NativeCall.kind == null) {
            listOf(grid, panelTiles, pipBox).forEach { it.removeAllViews() }
            layoutKey = ""; controlsKey = ""
            return
        }
        val tiles = NativeCall.tiles
        val live = tiles.associateBy { it.id }
        holders.entries.removeAll { (id, h) -> (id !in live).also { gone -> if (gone) h.release() } }

        val shown: List<NativeCall.Tile> = when {
            inPip -> listOfNotNull(NativeCall.featured())
            mode == NativeCall.Mode.FULL -> tiles
            mode == NativeCall.Mode.PANEL ->
                if (NativeCall.kind == NativeCall.Kind.HUDDLE) listOfNotNull(NativeCall.featured()) else tiles.take(4)
            else -> emptyList()
        }
        // Re-lay the views only when who's where changes. Talking, mute and quality events
        // arrive many times a second: those just update the tiles in place (moving a video
        // surface between parents is what made the call flicker).
        val key = "$mode|$inPip|" + shown.joinToString(",") { it.id }
        if (key != layoutKey) {
            layoutKey = key
            listOf(grid, panelTiles, pipBox).forEach { it.removeAllViews() }
            when {
                inPip -> shown.forEach { pipBox.addView(holder(r, it).view, match()) }
                mode == NativeCall.Mode.FULL -> {
                    val cols = if (shown.size <= 2) 1 else 2
                    grid.columnCount = cols
                    grid.rowCount = maxOf(1, (shown.size + cols - 1) / cols)
                    shown.forEachIndexed { i, t ->
                        val lp = GridLayout.LayoutParams(GridLayout.spec(i / cols, 1f), GridLayout.spec(i % cols, 1f))
                            .apply { width = 0; height = 0; setMargins(dp(4), dp(4), dp(4), dp(4)) }
                        grid.addView(holder(r, t).view, lp)
                    }
                }
                mode == NativeCall.Mode.PANEL -> {
                    val w = if (NativeCall.kind == NativeCall.Kind.HUDDLE) 120 else 84
                    shown.forEach { t ->
                        panelTiles.addView(holder(r, t).view,
                            LinearLayout.LayoutParams(dp(w), dp(w * 4 / 3)).apply { setMargins(dp(3), 0, dp(3), 0) })
                    }
                    placePanel()
                }
            }
        }
        val compact = inPip || mode == NativeCall.Mode.PANEL
        shown.forEach { holder(r, it).bind(it, compact) }

        if (mode == NativeCall.Mode.FULL && !inPip) {
            titleView.text = NativeCall.title
            val others = tiles.count { !it.isLocal }
            subView.text = when {
                NativeCall.connecting -> "Connecting…"
                others == 0 -> "Waiting for the squad"
                others == 1 -> "1 other person"
                else -> "$others others"
            }
        }
        val withControls = NativeCall.kind == NativeCall.Kind.HUDDLE || NativeCall.camOn || NativeCall.micOn
        panelControls.visibility = if (withControls) View.VISIBLE else View.GONE
        val ck = "$mode|${NativeCall.micOn}|${NativeCall.camOn}|$withControls"
        if (ck != controlsKey) {
            controlsKey = ck
            controls(fullControls, 56)
            if (withControls) controls(panelControls, 36) else panelControls.removeAllViews()
        }
    }

    private fun controls(row: LinearLayout, size: Int) {
        row.removeAllViews()
        val gap = size / 4
        fun add(v: View) = row.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(dp(gap), 0, dp(gap), 0) })
        add(round(if (NativeCall.micOn) R.drawable.ic_mic else R.drawable.ic_mic_off,
            if (NativeCall.micOn) "Mute mic" else "Unmute mic", size, on = NativeCall.micOn) { NativeCall.toggleMic(app) })
        add(round(if (NativeCall.camOn) R.drawable.ic_cam else R.drawable.ic_cam_off,
            if (NativeCall.camOn) "Camera off" else "Camera on", size, on = NativeCall.camOn) { NativeCall.toggleCamera(app) })
        if (NativeCall.camOn && size > 40) add(round(R.drawable.ic_flip, "Flip camera", size) { NativeCall.flipCamera() })
        add(round(R.drawable.ic_leave, "Leave call", size, tint = ContextCompat.getColor(app, R.color.decline)) { NativeCall.leave() })
    }

    private fun round(icon: Int, label: String, size: Int, on: Boolean = false, tint: Int? = null, click: () -> Unit) =
        ImageButton(app).apply {
            setImageResource(icon)
            setColorFilter(Color.WHITE)
            contentDescription = label
            tooltipText = label
            scaleType = android.widget.ImageView.ScaleType.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(tint ?: if (on) Color.argb(72, 255, 255, 255) else Color.argb(36, 255, 255, 255))
            }
            minimumWidth = dp(maxOf(size, 44)); minimumHeight = dp(maxOf(size, 44))
            layoutParams = ViewGroup.LayoutParams(dp(size), dp(size))
            setOnClickListener { click() }
        }

    private fun placePanel() {
        val lp = panel.layoutParams as? FrameLayout.LayoutParams ?: return
        if (lp.gravity == (Gravity.BOTTOM or Gravity.END)) {
            lp.setMargins(dp(12), top + dp(12), dp(12), bottom + dp(96))
            panel.layoutParams = lp
        }
    }

    private fun drag(v: View) {
        var dx = 0f; var dy = 0f; var moved = false
        v.setOnTouchListener { view, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { dx = view.x - e.rawX; dy = view.y - e.rawY; moved = false }
                MotionEvent.ACTION_MOVE -> {
                    val nx = (e.rawX + dx).coerceIn(dp(8f), root.width - view.width - dp(8f))
                    val ny = (e.rawY + dy).coerceIn(top + dp(8f), root.height - view.height - bottom - dp(8f))
                    if (kotlin.math.abs(nx - view.x) + kotlin.math.abs(ny - view.y) > 2) moved = true
                    view.x = nx; view.y = ny
                }
                MotionEvent.ACTION_UP -> if (!moved) NativeCall.mode = NativeCall.Mode.FULL
            }
            true
        }
    }

    private fun holder(r: Room, t: NativeCall.Tile) = holders.getOrPut(t.id) { TileHolder(r) }

    private fun match() = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    private fun dp(v: Int) = (v * app.resources.displayMetrics.density).toInt()
    private fun dp(v: Float) = v * app.resources.displayMetrics.density

    /** One person's square: their camera, or their initials; a ring when they talk. */
    private inner class TileHolder(room: Room) {
        val renderer = TextureViewRenderer(app).also {
            room.initVideoRenderer(it)
            it.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        }
        private val initials = TextView(app).apply { setTextColor(Color.WHITE); gravity = Gravity.CENTER }
        private val name = TextView(app).apply {
            setTextColor(Color.WHITE); textSize = 12f
            setPadding(dp(8), dp(2), dp(8), dp(2))
            background = GradientDrawable().apply { cornerRadius = dp(10f); setColor(Color.argb(128, 0, 0, 0)) }
        }
        private val ring = GradientDrawable().apply { cornerRadius = dp(16f) }
        val view = FrameLayout(app).apply {
            background = GradientDrawable().apply { cornerRadius = dp(16f); setColor(ContextCompat.getColor(app, R.color.tile)) }
            clipToOutline = true
            outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
            addView(initials, match())
            addView(renderer, match())
            addView(name, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply { setMargins(dp(6), 0, 0, dp(6)) })
            foreground = ring
        }
        private var track: VideoTrack? = null

        fun bind(t: NativeCall.Tile, compact: Boolean): View {
            if (track !== t.track) {
                track?.removeRenderer(renderer)
                track = t.track
                t.track?.addRenderer(renderer)
            }
            renderer.visibility = if (t.track != null) View.VISIBLE else View.INVISIBLE
            renderer.setMirror(t.isLocal)
            initials.text = t.name.split(" ").take(2).joinToString("") { it.take(1).uppercase() }
            initials.textSize = if (compact) 20f else 40f
            name.text = (if (!t.micOn) "🔇 " else "") + t.name
            name.visibility = if (compact) View.GONE else View.VISIBLE
            ring.setStroke(dp(3), if (t.speaking) accent else Color.TRANSPARENT)
            view.contentDescription = t.name + if (t.speaking) ", talking" else ""
            return view
        }

        fun release() {
            track?.removeRenderer(renderer)
            track = null
            (view.parent as? ViewGroup)?.removeView(view)
            renderer.release()
        }
    }
}
