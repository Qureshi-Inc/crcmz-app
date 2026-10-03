package me.crcmz.app

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * The AI chat over a Huddle call: slides up from the bottom, the call keeps going behind
 * it. The page keeps the conversation (so it's all still there when you close this and
 * come back, and the same on the Huddle page) and asks the AI; this shows it and sends
 * your questions (NativeCall.askAI). Asking with the transcript off offers to start it
 * first, since that's how the AI follows the call. Same as AiChat in
 * ios/CRCMZ/CallOverlay.swift.
 */
object AiSheet {
    private var dialog: BottomSheetDialog? = null
    private var list: LinearLayout? = null
    private var scroll: ScrollView? = null
    private var chip: TextView? = null
    private var input: EditText? = null
    private var shown = -1

    fun show(app: LauncherActivity) {
        if (dialog?.isShowing == true) return
        val sheetColor = ContextCompat.getColor(app, R.color.sheet)
        val text = ContextCompat.getColor(app, R.color.text)
        fun dp(v: Int) = (v * app.resources.displayMetrics.density).toInt()

        val header = LinearLayout(app).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(14), dp(8), dp(8))
            addView(TextView(app).apply { this.text = "✨ AI helper"; setTextColor(text); textSize = 18f; paint.isFakeBoldText = true },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(TextView(app).apply {
                this.text = "● Transcribing"; setTextColor(Color.WHITE); textSize = 12f
                setPadding(dp(10), dp(4), dp(10), dp(4))
                background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(Color.argb(70, 255, 70, 70)) }
                chip = this
            })
            addView(TextView(app).apply {
                this.text = "✕"; setTextColor(text); textSize = 18f; gravity = Gravity.CENTER
                contentDescription = "Close the AI chat"; minWidth = dp(48); minHeight = dp(48)
                setOnClickListener { dismiss() }
            })
        }
        val messages = LinearLayout(app).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(4), dp(16), dp(8)) }
        val scroller = ScrollView(app).apply { addView(messages); isFillViewport = true }
        val field = EditText(app).apply {
            hint = "Ask the AI"; setHintTextColor(Color.argb(140, 255, 255, 255)); setTextColor(text); textSize = 16f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_ACTION_SEND; maxLines = 4
            setPadding(dp(14), dp(10), dp(14), dp(10))
            background = GradientDrawable().apply { cornerRadius = dp(20).toFloat(); setColor(Color.argb(28, 255, 255, 255)) }
            setOnEditorActionListener { _, id, ev ->
                if (id == EditorInfo.IME_ACTION_SEND || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { send(app); true } else false
            }
        }
        val sendBtn = TextView(app).apply {
            this.text = "↑"; setTextColor(Color.WHITE); textSize = 20f; gravity = Gravity.CENTER; contentDescription = "Ask"
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(ContextCompat.getColor(app, R.color.accent)) }
            setOnClickListener { send(app) }
        }
        val bar = LinearLayout(app).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(12))
            addView(field, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = dp(8) })
            addView(sendBtn, LinearLayout.LayoutParams(dp(44), dp(44)))
        }
        val root = LinearLayout(app).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(sheetColor)
            addView(header)
            addView(scroller, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(bar)
        }
        val d = BottomSheetDialog(app)
        // Fills the window up to 62% of the screen: with the keyboard up it gets shorter
        // instead of running off the top.
        d.setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        d.behavior.maxHeight = (app.resources.displayMetrics.heightPixels * 0.62).toInt()
        d.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        d.window?.navigationBarColor = sheetColor
        d.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        d.behavior.skipCollapsed = true
        d.setOnDismissListener { if (dialog === d) { dialog = null; list = null; scroll = null; chip = null; input = null; NativeCall.onAi = null } }
        dialog = d; list = messages; scroll = scroller; input = field; shown = -1
        NativeCall.onAi = { render(app) }
        render(app)
        d.show()
    }

    fun dismiss() { dialog?.dismiss() }

    private fun send(app: LauncherActivity) {
        val f = input ?: return
        val q = f.text.toString().trim()
        if (q.isEmpty() || NativeCall.aiBusy) return
        if (NativeCall.transcribing) { NativeCall.askAI(q, false); f.setText(""); return }
        AlertDialog.Builder(app)
            .setTitle("Start the transcript?")
            .setMessage("The AI follows the call through the transcript. It starts for everyone in the call, and the meeting notes are saved when the call ends.")
            .setPositiveButton("Start and ask") { _, _ -> NativeCall.askAI(q, true); f.setText("") }
            .setNeutralButton("Just ask") { _, _ -> NativeCall.askAI(q, false); f.setText("") }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun render(app: LauncherActivity) {
        val box = list ?: return
        fun dp(v: Int) = (v * app.resources.displayMetrics.density).toInt()
        chip?.visibility = if (NativeCall.transcribing) View.VISIBLE else View.GONE
        val log = NativeCall.aiLog
        // The page sends the whole (recent) chat each time; redraw from scratch.
        box.removeAllViews()
        if (log.isEmpty()) box.addView(note(app, if (NativeCall.transcribing) "Ask about the call: what was decided, who's doing what, or anything else."
            else "Ask the AI anything. With the transcript on, it follows the call too."))
        for (m in log) {
            val v: View = when (m.role) {
                "user" -> bubble(app, m.text, ContextCompat.getColor(app, R.color.accent), Gravity.END)
                "assistant" -> bubble(app, m.text, Color.argb(24, 255, 255, 255), Gravity.START)
                "error" -> TextView(app).apply {
                    text = "${m.text} · Try again"; setTextColor(Color.rgb(255, 140, 140)); textSize = 15f
                    minHeight = dp(44); gravity = Gravity.CENTER_VERTICAL
                    setOnClickListener { NativeCall.retryAI() }
                }
                else -> note(app, m.text)
            }
            box.addView(v)
        }
        if (NativeCall.aiBusy) box.addView(LinearLayout(app).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(8), 0, dp(8))
            addView(ProgressBar(app), LinearLayout.LayoutParams(dp(20), dp(20)))
            addView(TextView(app).apply { text = "  Thinking…"; setTextColor(Color.argb(170, 255, 255, 255)) })
        })
        val n = log.size + if (NativeCall.aiBusy) 1 else 0
        if (n != shown) { shown = n; scroll?.post { scroll?.fullScroll(View.FOCUS_DOWN) } }
    }

    private fun bubble(app: LauncherActivity, text: String, color: Int, side: Int): View {
        fun dp(v: Int) = (v * app.resources.displayMetrics.density).toInt()
        return LinearLayout(app).apply {
            gravity = side
            setPadding(0, dp(5), 0, dp(5))
            addView(TextView(app).apply {
                this.text = text; setTextColor(Color.WHITE); textSize = 15f; setTextIsSelectable(true)
                setPadding(dp(12), dp(9), dp(12), dp(9))
                maxWidth = (app.resources.displayMetrics.widthPixels * 0.8).toInt()
                background = GradientDrawable().apply { cornerRadius = dp(16).toFloat(); setColor(color) }
            })
        }
    }

    private fun note(app: LauncherActivity, text: String) = TextView(app).apply {
        this.text = text; setTextColor(Color.argb(160, 255, 255, 255)); textSize = 13f; gravity = Gravity.CENTER
        setPadding(0, (8 * app.resources.displayMetrics.density).toInt(), 0, (8 * app.resources.displayMetrics.density).toInt())
    }
}
