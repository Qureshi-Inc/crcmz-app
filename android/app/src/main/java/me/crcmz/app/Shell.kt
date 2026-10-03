package me.crcmz.app

import android.content.res.ColorStateList
import android.net.Uri
import android.view.HapticFeedbackConstants
import android.view.Menu
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.setPadding
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.navigation.NavigationBarView
import org.json.JSONObject

/**
 * The app's own tab bar under the page: your three tabs, Ask AI and More. The page says
 * what's in it and which one is current (frontend/src/lib/nativeShell.ts); a tap routes
 * the page in place (window.__crcmzGo), so calls and music keep going. Sign-in pages and
 * a fullscreen party get the whole screen. Same as ios/CRCMZ/Shell.swift.
 */
class Shell(private val app: LauncherActivity, private val go: (String) -> Unit) {
    data class Item(val id: String, val label: String, val path: String, val group: String)

    val bar = BottomNavigationView(app).apply {
        val bg = ContextCompat.getColor(app, R.color.bar)
        setBackgroundColor(bg)
        itemIconTintList = tint()
        itemTextColor = tint()
        itemActiveIndicatorColor = ColorStateList.valueOf(ContextCompat.getColor(app, R.color.bar_active))
        labelVisibilityMode = NavigationBarView.LABEL_VISIBILITY_LABELED
        visibility = View.GONE
        elevation = 0f
    }

    private var tabs: List<Item> = emptyList()
    private var more: List<Item> = emptyList()
    private var hidden = false
    /** The keyboard is up: the bar steps aside, so what you type sits right on the keyboard. */
    var keyboard = false
        set(v) { if (field != v) { field = v; apply() } }
    private var onAppPage = false
    private var settingSelection = false

    init {
        bar.setOnItemSelectedListener { item ->
            if (settingSelection) return@setOnItemSelectedListener true
            bar.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
            if (item.itemId == MORE) { showMore(); return@setOnItemSelectedListener false }
            tabs.getOrNull(item.itemId)?.let { go(it.path) }
            true
        }
        // The page re-selects More on every update while you're on a More page: only a real tap opens it.
        bar.setOnItemReselectedListener { item -> if (item.itemId == MORE && !settingSelection) showMore() }
    }

    private fun tint(): ColorStateList {
        val on = ContextCompat.getColor(app, R.color.accent_soft)
        val off = ContextCompat.getColor(app, R.color.muted)
        return ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(on, off))
    }

    /** From the page: {tabs, more, active, badge, hidden}. */
    fun update(m: JSONObject) {
        fun items(key: String) = (0 until (m.optJSONArray(key)?.length() ?: 0)).mapNotNull { i ->
            val d = m.optJSONArray(key)!!.optJSONObject(i) ?: return@mapNotNull null
            Item(d.optString("id"), d.optString("label"), d.optString("path"), d.optString("group"))
        }
        val newTabs = items("tabs")
        more = items("more")
        if (newTabs.map { it.id } != tabs.map { it.id }) {
            tabs = newTabs
            bar.menu.clear()
            tabs.forEachIndexed { i, t -> bar.menu.add(Menu.NONE, i, i, t.label).setIcon(icon(t.id)) }
            bar.menu.add(Menu.NONE, MORE, tabs.size, "More").setIcon(R.drawable.ic_more)
        }
        val badge = m.optInt("badge", 0)
        tabs.forEachIndexed { i, t ->
            if (t.id == "squad" && badge > 0) bar.getOrCreateBadge(i).apply {
                number = badge
                backgroundColor = ContextCompat.getColor(app, R.color.decline)
            } else bar.removeBadge(i)
        }
        val active = m.optString("active").takeIf { !m.isNull("active") }
        val sel = tabs.indexOfFirst { it.id == active }.takeIf { it >= 0 }
            ?: if (more.any { it.id == active }) MORE else null
        // A bottom bar always has one tab lit; a page outside the bar (Notifications…) lights More.
        val want = sel ?: MORE
        if (bar.selectedItemId != want) {
            settingSelection = true
            bar.selectedItemId = want
            settingSelection = false
        }
        hidden = m.optBoolean("hidden", false)
        apply()
    }

    /** The web view moved to another page: off app.crcmz.me/app (sign-in) there's no bar. */
    fun pageChanged(url: Uri?) {
        onAppPage = url?.host == "app.crcmz.me" && url.path.orEmpty().startsWith("/app")
        if (!onAppPage) { tabs = emptyList(); bar.menu.clear() }
        apply()
    }

    private fun apply() {
        val show = onAppPage && !hidden && !keyboard && tabs.isNotEmpty()
        if (show != (bar.visibility == View.VISIBLE)) app.setBarVisible(show)
    }

    private fun showMore() {
        val sheet = BottomSheetDialog(app)
        val list = LinearLayout(app).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8))
            setBackgroundColor(ContextCompat.getColor(app, R.color.sheet))
        }
        fun header(text: String) = list.addView(TextView(app).apply {
            this.text = text.uppercase()
            setTextColor(ContextCompat.getColor(app, R.color.accent_soft))
            textSize = 12f
            letterSpacing = 0.12f
            setPadding(dp(16), dp(16), dp(16), dp(6))
        })
        fun row(item: Item, iconRes: Int) = list.addView(TextView(app).apply {
            text = item.label
            setTextColor(ContextCompat.getColor(app, R.color.text))
            textSize = 17f
            minHeight = dp(52)
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(16), 0)
            compoundDrawablePadding = dp(16)
            val d = ContextCompat.getDrawable(app, iconRes)?.mutate()
            d?.setTint(ContextCompat.getColor(app, R.color.accent_soft))
            setCompoundDrawablesRelativeWithIntrinsicBounds(d, null, null, null)
            background = ContextCompat.getDrawable(app, R.drawable.row_ripple)
            setOnClickListener { sheet.dismiss(); go(item.path) }
        }, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val squad = more.filter { it.group == "squad" }
        val account = more.filter { it.group != "squad" }
        if (squad.isNotEmpty()) { header("Squad"); squad.forEach { row(it, icon(it.id)) } }
        header("Account")
        account.forEach { row(it, icon(it.id)) }
        row(Item("edit", "Change the tab bar", "/settings/app#tabbar", "account"), R.drawable.ic_settings)
        sheet.setContentView(android.widget.ScrollView(app).apply { addView(list) })
        sheet.window?.navigationBarColor = ContextCompat.getColor(app, R.color.sheet)
        sheet.show()
    }

    private fun dp(v: Int) = (v * app.resources.displayMetrics.density).toInt()

    companion object {
        private const val MORE = 99

        fun icon(id: String): Int = when (id) {
            "squad" -> R.drawable.ic_squad
            "clips" -> R.drawable.ic_clips
            "slap" -> R.drawable.ic_slap
            "whatsapp" -> R.drawable.ic_chat
            "giveaway" -> R.drawable.ic_giveaway
            "watch" -> R.drawable.ic_watch
            "huddle" -> R.drawable.ic_huddle
            "coach" -> R.drawable.ic_coach
            "ask" -> R.drawable.ic_ai_chat
            "notifications" -> R.drawable.ic_bell
            "portal" -> R.drawable.ic_link
            "settings" -> R.drawable.ic_settings
            "help" -> R.drawable.ic_info
            "admin" -> R.drawable.ic_admin
            "getapp" -> R.drawable.ic_download
            else -> R.drawable.ic_more
        }
    }
}
