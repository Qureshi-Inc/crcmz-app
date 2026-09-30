# JOURNEY.md: CRCMZ App (`/app`)

**Status:** Phase 1 of `.design-foundations/plans/2026-09-30-crcmz-app.md` is done: §Inventory, §Job, §Journey and §IA. §Flows and §Page specs come in Phase 2, §Microcopy in Phase 5 and §Data specs in Phase 6.
**Pairs with:** `DESIGN.md` (locked in Phase 3; not yet present).
**Owner:** Moiz (squad admin). **Date:** 2026-09-30.
**Sources of truth:** `_DASHBOARD_TMPL` and routes in `server.py` (template lines 7557–16998), the `reels.py` router, `soundboard.py`, `_portal_page()`, and the research doc `.design-foundations/research/2026-09-30-crcmz-app.md`. The prior attempt (`frontend/src`, `docs/ux/`) was deliberately not consulted.
**Scope:** `/app` only. The original dashboard at `/` and the legacy `/portal` page stay untouched and remain the default. Every route below keeps its existing contract.

---

## §Inventory

Every capability found in `_DASHBOARD_TMPL`, plus the research-listed capabilities outside it, each with a disposition. MCP/OAuth machine endpoints and the Stream Deck plugin are out of scope (listed at the end for completeness).

**Disposition vocabulary**

| Value | Meaning |
|---|---|
| **KEEP** | Same destination in `/app`. It will be re-laid-out, but the capability and endpoint contract are unchanged. |
| **MOVE → X** | The capability survives but lives in destination X. |
| **EXCLUDE** | Not carried into `/app`. The row states the reason. |

Endpoints are relative to `app.crcmz.me` unless marked `SLAP` (`https://slap.qureshi.io/api/v1/dashboard`). The cadence is the legacy poll interval, where there is one.

### G · Global shell

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| G-01 | Wordmark "CRCMZ APP", logo (`/footer-avatar.png`; mascot `crcmz-logo.png`), tagline "Yes. We have one." | `.top` header | static assets | KEEP | Sidebar header (desktop) and top bar (mobile) |
| G-02 | Section switcher: a dropdown with 9 items, active icon and label | `#navWrap` (`toggleNav`, `tab`) | none | MOVE → IA global nav | Replaced by the persistent sidebar, tab bar and More sheet (§IA). This fixes "no persistent orientation" |
| G-03 | Deep links `?p=<panel>`, legacy `#hash`, `?p=upload` (opens the upload sheet), pushState/popstate Back | boot IIFE, `tab()`, popstate | `/watch` → 302 `/?p=watch` | KEEP | `/app/<route>`. `/app?p=<legacy key>` resolves to the new route (§IA → URL map) |
| G-04 | Account menu: display name, Settings, Sign out. Signed out: Sign in | `__USER__` (`toggleUserMenu`) | `/auth/logout`, `/auth/login` | KEEP | Sidebar footer account row / mobile top-bar avatar |
| G-05 | Live-count banner "**N** in a game right now 🎮" | `#livecount` | derived from `/api/squad` (30 s) | KEEP | Squad header, plus a count badge on the Squad nav item |
| G-06 | Toast (2 s) | `#toast` | none | KEEP | Global polite live region |
| G-07 | Recoverable panel error with Retry (clears the load guard) | `panelError()` | none | KEEP | Standard error state for every surface (Phase 2 state matrix) |
| G-08 | Watch Party mini-bar: shown off-Watch while connected, viewer summary ("just you", "A, B +2"), 🎤 Live/Muted toggle, "🍿 Watch" back | `#wpMiniBar` (`wpMiniSync`, `wpMiniGoWatch`) | WatchParty socket presence | KEEP (extended) | A persistent call bar for **Watch and Huddle** (see HU-08): docked above the tab bar on mobile, at the bottom of the sidebar on desktop |
| G-09 | Aurora background (3 drifting blobs) plus scanline grid | CSS `body::before/after` | none | KEEP | Phase 3 token lock (opacity ~25–28%, reduced motion stops the drift) |
| G-10 | Body height sync / `board-off` class that hides the Chat Board off Squad | `syncBoardHeight`, `paintTab` | none | EXCLUDE | A layout workaround. In `/app` the Chat Board renders only on Squad |
| G-11 | Ask AI force-collapses the Chat Board so it does not cover the composer | `loadAsk()` | none | EXCLUDE | The problem does not exist: there is no Chat Board off Squad (research "structurally broken" #3) |
| G-12 | Unused Ranks panel placeholder | `#p-lb` (empty, `display:none`) | none | EXCLUDE | Dead markup. Ranks live on Squad (SQ-05) |

### SQ · Squad (home) — legacy `#p-squad` (`#p-lb` is G-12)

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| SQ-01 | "Playing together" card when 2 or more are on the same game ("🔥 3 in X"), with the names and **Rally ▶** | `#together` (`renderTogether`, `rally`) | `/api/squad` (30 s); POST `/v2/squad` `{message}` | KEEP | Top of Squad |
| SQ-02 | Hype meter: "Today's Hype", label, count of msgs, fill % by level (dead…hot) | `#hypeMeter` (`loadHype`) | GET `/api/hype` · 60 s | KEEP | Squad. Compact on mobile, visible scale (mock-review carry-over) |
| SQ-03 | Stat tiles: total ⚪ Platinums, 🏆 Top Level, 🎯 Squad Fav game | `#statgrid` (`renderStats`) | derived `/api/squad` | KEEP | Squad. Compact on mobile |
| SQ-04 | Presence list: avatar, game icon, name, `@mm_username`, "🎮 On **Game**" (glowing) or last game (dimmed), players floated to the top. Empty state: "Nobody linked yet → Link your account" | `#squad` (`loadSquad`, `renderSquad`) | GET `/api/squad` · 30 s | KEEP | Squad primary content. Empty-state link goes to Portal |
| SQ-05 | Ranks: sorted by trophy level then platinum, 🥇🥈🥉/#n, level, plat/gold/silver/bronze, relative bar | `#lb` (`renderBoard`) | derived `/api/squad` | KEEP | Squad, below presence |
| SQ-06 | **Squad Up** / Game Time: built-in Chat Board tiles that post canned rally messages | `soundboard.DEFAULTS` | POST `/v2/squad` | KEEP | Chat Board tiles (CB-01) |
| SQ-07 | Resolve my avatar and the `crcmz-mod` avatar for the sent flyout | `loadSquad` | derived `/api/squad` | KEEP | Supports CB-11 |

### CB · Chat Board (soundboard; Squad only) — legacy `#boardWrap`

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| CB-01 | Shared board: 7 built-in tiles plus shared custom tiles, each with a neon colour class `c1`–`c5`. Firing posts the message as crcmz-mod. 429 → "Slow down a sec" | `#board` (`renderButtons`, `fire`) | inline `__SOUNDBOARD__`, GET `/api/soundboard`; POST `/v2/squad` `{message}` | KEEP | Squad: right panel (desktop) / bottom sheet (mobile) |
| CB-02 | Path-action tiles: a tile with `path` POSTs that path instead of a message (the roast hook, e.g. `/roast/once`) | `fire()` `b.path` branch | POST `b.path` | KEEP | The tile model supports path actions. See AD-07 for roast |
| CB-03 | Personal (private) board: page 2, private to the user, still fires into the group. Signed out: "Sign in to build it". Empty-state hint | `#board` page 1 (`refreshPersonal`) | inline `__PERSONAL__`, GET `/api/soundboard/personal` | KEEP | Second board page |
| CB-04 | Switch shared ⇄ personal: **horizontal swipe** (gesture) plus unlabeled pager dots | `bindBoardSwipe`, `#boardPager` | none | KEEP | Visible equivalent: labeled segmented tabs **Shared / Mine** (`role=tab`). Swipe stays as an accelerator |
| CB-05 | Add custom tile: prompt, then the AI adds flavor, "✨ AI is cooking…" | `openCustom()` (`window.prompt`) | POST `/api/soundboard` or `/api/soundboard/personal` `{text}` → `{flavored}` | KEEP | "+ Custom" tile opens a dialog (replaces `prompt`) |
| CB-06 | Delete custom tile: **long-press 600 ms** (gesture) → confirm | `bindLongPress`, `delBtn` | POST `/api/soundboard/delete` or `/api/soundboard/personal/delete` `{text}` | KEEP | Visible equivalent: an **Edit** toggle in the board header shows a ✕ remove control on each custom tile |
| CB-07 | Organize / reorder: **fullscreen + long-press** enters organize mode, **drag** to reorder, "✓ Done Organizing". Shared order is per device (`localStorage cb_order`); personal order is saved server-side | `enterOrganize`, `bindDrag`, `_saveOrder` | POST `/api/soundboard/personal/order` `{labels}` | KEEP | Visible equivalent: an **Organize** button in the board header (no fullscreen gate). Drag plus **Move earlier / Move later** buttons (WCAG 2.5.7) |
| CB-08 | Collapse/expand by tapping the title, persisted (`sb_collapsed`) | `toggleBoard` | none | KEEP | Desktop: collapsible right panel. Mobile: slim handle plus "Chat" trigger; the composer shows only when the sheet is open (mock-review Major) |
| CB-09 | Fullscreen board (⛶ / ✕), locks body scroll | `toggleBoardFs` | none | KEEP | Mobile: sheet full-height snap. Desktop: expand the panel |
| CB-10 | Quick message composer: sent **as the user**, not saved, no AI. Double-send guard. A network error keeps the draft with "may not have been sent" (not idempotent). 429 handling | `#quick` (`sendQuick`) | POST `/v2/send` `{message}` | KEEP | Inside the Chat Board. Placeholder must fit at 375 px (carry-over) |
| CB-11 | Sent flyout: avatar, name and message float up from the pressed tile, ✓ | `showSentFly` | none | KEEP | Success feedback (Nielsen #1) |
| CB-12 | Gesture hint line ("swipe left for your own board · tap title to minimize · hold in fullscreen to organize") | `#boardHint` | none | EXCLUDE | It only existed to reveal hidden gestures. CB-04/06/07 now have visible controls |

### CL · Clips — legacy `#p-pipeline` + `#up-sheet`

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| CL-01 | Summary bar: "📅 Month · N clips · build in Xd Yh", "📤 Send a video", upload progress pill ("Uploading 42%", "Queued ✓", "paused — tap to resume") | `.cl-top` (`clPill`) | derived `/api/pipeline-status` | KEEP | Clips header |
| CL-02 | Layout: mobile folding sections (`cl-open-*` persisted), desktop 3 columns (upload · reels · month/montage/clips) | `.cl-grid`, `clApply` | none | KEEP (re-laid-out) | Phase 2 page spec defines the layout |
| CL-03 | This Month: clips captured, "Until Build" countdown, last clip ago + sender | `[data-sec=month]` (`loadPipeline`) | GET `/api/pipeline-status` · 30 s | KEEP | Clips |
| CL-04 | Montage: scheduled label/date, countdown, "auto-send to Goopers". Last montage: version, year-month, clips, duration, sent badge | `[data-sec=montage]` | `/api/pipeline-status` · 30 s | KEEP | Clips |
| CL-05 | Clips This Month list: included ✓ / excluded ✕ / pending, sender, duration, reason, age | `[data-sec=clips]` | `/api/pipeline-status .clips` · 30 s | KEEP | Clips |
| CL-06 | Services health: PSN Messenger, Montage Engine, WhatsApp Bridge (dot, ms, "unreachable") | `[data-sec=services]` | `/api/pipeline-status .services` · 30 s | MOVE → Admin | Plan constraint: Admin collects the service health from legacy Clips (AD-02) |
| CL-07 | My reels list: frame thumbnail, sender/game, duration, age, message, badges (pipeline state, 🔥 fire, 😂 fail, AI analyzed, rendered, approved, 🛑 vetoed) | `#reels-inner` (`loadReels`, `renderList`) | GET `/api/reels`; thumbs `/api/reels/clips/{id}/frame?t=` | KEEP | Clips: reels section |
| CL-08 | Reel filter chips (All · Needs review · Rendered · 🛑 Vetoed), counts (eligible / total / vetoed), source note (roster pushed Xm ago / mirror), Show more (12 mobile / 24 desktop) | `renderList` | client-side | KEEP | Clips |
| CL-09 | Scope toggle "Everyone's / Only mine" (admin only) | `data-act=scope` | GET `/api/reels?all=true` | KEEP | Clips, role-gated. Admin links here |
| CL-10 | ↻ Sync clips | `data-act=sync` | POST `/api/reels/sync` | KEEP | Clips |
| CL-11 | Needs-PSN-link state: "Link your PlayStation account → ⚙️ Open Settings" | `S.needsLink` | `/api/reels .needs_psn_link` | KEEP | Contextual link to **Portal** |
| CL-12 | Reel Studio: full-screen editor dialog, `#edit` history entry, Back/Esc/✕ close, "Leave without saving?" | `openStudio`, `closeStudio` | GET `/api/reels/clips/{id}`; source `/api/reels/clips/{id}/source` | KEEP | Clips → Studio overlay route (`/app/clips/{id}/edit`) |
| CL-13 | Studio views ✨ Live / 🎬 Render / 🖼 Frame, 🔊 mute, ⬇ download reel | `.rrs-views`, `setView`, `setReel` | `/api/reels/renders/{rid}/video` | KEEP | Studio |
| CL-14 | Transport: ▶/⏸, −0.1 / +0.1 s, time. Keys: Space, ←/→ (Shift = 1 s), I / O / A, Esc | `.rrs-transport`, `onKey` | none | KEEP | Studio. Keys are accelerators; every one has a button |
| CL-15 | Timeline: filmstrip, trim window, zoom lane, subtitle lane, ruler, playhead. **Drag** handles | `renderTimeline`, `onPointer*` | frames `/api/reels/clips/{id}/frame?t=` | KEEP | Button equivalents already exist (Start here / End here) |
| CL-16 | Trim tool: ⇤ Start here, End here ⇥, ✨ Use AI pick, ↔ Whole clip | `tool.trim` | none | KEEP | Studio |
| CL-17 | Crop tool: AI tracking / Center / Manual. Manual size slider 30–100 %. **Drag** the green box in Full frame. AI trajectory | `tool.crop`, `setReel` | GET `/api/reels/renders/{rid}/trajectory` | KEEP | Box position is drag-only today. Visible equivalent: **X-position slider plus ◀ ▶ nudge** |
| CL-18 | Zoom tool: ＋ Add zoom here, zoom chips, strength 1.1–3×, start/end here, ▶ Preview, Delete, tap the preview to aim | `tool.zoom` | none | KEEP | Studio (tap-to-aim is a single pointer, not a path gesture) |
| CL-19 | Text tool: featured label plus caption (AI drafts) | `tool.text` | none | KEEP | Studio |
| CL-20 | Subs tool: AI subtitle segments, ＋ Add line here, edit text, start/end, Delete, ↺ Reset to AI | `tool.subs` | none | KEEP | Studio |
| CL-21 | ⚙ Render: queued, then "Rendering your reel… Ns", then Render view on done / error on failure | `startRender` | POST `/api/reels/clips/{id}/render` → GET `/api/reels/renders/{rid}` · 2 s | KEEP | Studio |
| CL-22 | ✅ Save & approve (validated: end > start for trim, zooms and subs) | `save`, `validate` | POST `/api/reels/clips/{id}/override` | KEEP | Studio |
| CL-23 | 🚀 Force post toggle | `toggleForce` | POST `/api/reels/clips/{id}/force-post` `{force}` | KEEP | Studio (shown when allowed) |
| CL-24 | 🛑 Veto toggle | `toggleVeto` | POST / DELETE `/api/reels/clips/{id}/veto` | KEEP | Studio |
| CL-25 | Pipeline status strip in the Studio (posted / fire / daily / vetoed / not eligible + detail) | `syncPipe` | from the clip detail `pipeline` | KEEP | Studio |
| CL-26 | **Send a video** to @crcmzclan: file (`video/*`), caption (max length), limits (MP4/MOV, max minutes, one in queue). **Resumable chunked upload**: 8 MB chunks, SHA-256 file key, backoff retries, offline wait, pause after 8 failures, 24 h resume, "Checking the video…" | `#upload-inner` (`upSend`); mobile sheet `#up-sheet` | GET `/api/video-uploads/mine`; POST `/start`; PUT `/chunk?id=&offset=`; POST `/finish` | KEEP | Clips: bottom sheet (mobile) / inline column (desktop). `?upload` deep link |
| CL-27 | Your uploads: Queued / Posted / Skipped, filename, time, caption, skip reason, per-platform links (Instagram / TikTok / YouTube ↗ or pending), **Withdraw** (queued, no links) | `#upload-list` (`upRow`, `upWithdraw`) | GET `/api/video-uploads/mine`; POST `/api/video-uploads/withdraw` | KEEP | Clips |
| CL-28 | Upload states: 401 "Sign in to upload", 403 "Link your account", error + Retry, "previous video not posted yet" | `loadUpload` | `/api/video-uploads/mine` | KEEP | 403 links to **Portal** |
| CL-29 | Clip catalogue (research-listed, **not in the template**): sender, time, duration, resolution, size, WA delivery status, montage eligibility. Filters: month / sender / status | none | GET `/clips` (JSON; HTML → 302 `/?p=pipeline`), GET `/clips/{uid}` | KEEP (new section) | Clips → "All clips" |
| CL-30 | Re-send a clip to WhatsApp (research-listed) | none | POST `/api/clips/{uid}/resend` (409 not archived · 410 missing · 503 no bridge) | KEEP | Clips → clip detail. Not idempotent; Phase 2 specifies confirmation |
| CL-31 | Inline clip playback with thumbnails (owner decision) | none | GET `/api/clips/media?uid=`: **bearer-only today**, session-cookie access is a planned backend change. **410** after the 14-day retention purge | KEEP | Clips player. Depends on the backend change |
| CL-32 | Video job queue: counts + queue depth (research-listed) | none | GET `/api/video-jobs` | MOVE → Admin | AD-04 |

### SL · Slap — legacy `#p-slap` (Slapshare music; external, CORS `*`; all 19 endpoints verified HTTP 200 on 2026-09-30)

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| SL-01 | Stat tiles: 🎵 Tracks, 👥 Squad, 🎤 Top Artist, 📅 This Week | `#slap-stats` | `SLAP /stats` | KEEP | Slap |
| SL-02 | AI vibe check (mood emoji, vibe, description; hidden if unavailable) | `#slap-vibe` | `SLAP /ai/vibe-check` | KEEP | Slap |
| SL-03 | Weekly digest plus highlight chips | `#slap-digest` | `SLAP /ai/digest` | KEEP | Slap |
| SL-04 | 🎧 On Repeat IRL: scrobble top artists/tracks, period, plays (hidden when disabled or empty) | inserted section | `SLAP /listening` | KEEP | Slap |
| SL-05 | 👑 The Throne (top contributor) | section 1 | `SLAP /leaderboard` [0] | KEEP | Slap |
| SL-06 | 🔥 Hot Right Now (last 24 h) | section 2 | `SLAP /hot` | KEEP | **Fix:** the API returns `{tracks:[…]}`; legacy reads `items`/`hot`, so the panel never showed |
| SL-07 | 🏆 Leaderboard (medals, bars, counts, per-user colour) | section 3 | `SLAP /leaderboard` | KEEP | Slap |
| SL-08 | 🔥 Streak tracker (best, active current) | section 4 | `SLAP /streaks` | KEEP | Slap |
| SL-09 | 🧬 Taste DNA head-to-head: two user selects, split bar, shared artists, AI analysis + compatibility % | section 5 (`slapH2H`) | `SLAP /head-to-head/{u1}/{u2}`, `SLAP /taste-dna/{u1}/{u2}` | KEEP | Slap |
| SL-10 | 🤖 AI recommendations per user (reasoning + 6 picks) | section 6 (`slapRec`) | `SLAP /ai/recommendations/{username}` | KEEP | Slap |
| SL-11 | 📈 Submissions over time | section 7 | `SLAP /timeline` | KEEP | Slap (Phase 6 data spec) |
| SL-12 | 🍩 Platform breakdown | section 8 | `SLAP /genres` | KEEP | Slap (Phase 6) |
| SL-13 | 📊 Activity heatmap, hour × day | section 9 | `SLAP /heatmap` | KEEP | Slap (Phase 6) |
| SL-14 | 🎤 Top artists (10) | section 10 | `SLAP /artists?limit=10` | KEEP | Slap |
| SL-15 | 🏅 Achievements (unlocked by / 🔒) | section 11 | `SLAP /achievements` | KEEP | Slap |
| SL-16 | 🎩 Hipster index ("lower = more obscure") | section 12 | `SLAP /hipster` | KEEP | Slap |
| SL-17 | 🎭 Personality cards | section 13 | `SLAP /personalities` | KEEP | Slap |
| SL-18 | 🏛️ Hall of fame | section 14 | `SLAP /hall-of-fame` | KEEP | Slap |
| SL-19 | 📜 Recent activity feed (platform icon, title, artist, album, who, age) plus "Full dashboard ↗" | section 15 | `SLAP /recent?limit=30`; link `slap.qureshi.io/dashboard` | KEEP | Slap |
| SL-20 | Username → display name map (`SLAP_NAMES`, hard-coded) | `slapName()` | none | KEEP | Note: candidate to source from the Zitadel identity graph later |

### WA · WhatsApp — legacy `#p-wa` ("Professional Goopers" analytics)

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| WA-01 | Range selector: All Time / This Year / This Month / Prev Month / Custom (start → end dates), with a stale-response generation guard | `#waRange`, `waSetRange`, `_waGen` | `?range=&start=&end=` on every WA call | KEEP | WhatsApp |
| WA-02 | Stat tiles: 💬 Messages, 👥 Members, 🎬 Videos, 📷 Photos, 📅 Days, 📊 Msgs/Person | `#wa-stats` | GET `/api/whatsapp/stats` | KEEP | WhatsApp |
| WA-03 | 🏅 Awards (10): Certified Yapper, Night Owl, Early Bird, Video King, Photo King, Most 💀/😂/🔥, Fastest Replier, Ghost of Month | awards grid | GET `/api/whatsapp/awards` | KEEP | WhatsApp |
| WA-04 | 📈 Activity timeline (last 60 days) | section | GET `/api/whatsapp/activity .daily` | KEEP | Phase 6 |
| WA-05 | 📅 Monthly activity | section | `/api/whatsapp/activity .monthly` | KEEP | Phase 6 |
| WA-06 | ⏰ Activity by hour | section | `/api/whatsapp/activity .by_hour` | KEEP | Phase 6 |
| WA-07 | 📆 Activity by day of week | section | `/api/whatsapp/activity .by_dow` | KEEP | Phase 6 |
| WA-08 | 🌡️ Heatmap, day × hour | section | GET `/api/whatsapp/heatmap` | KEEP | Phase 6 |
| WA-09 | 👥 Member activity table | section | GET `/api/whatsapp/members` | KEEP | Phase 6 (table) |
| WA-10 | 😂 Top emoji (12, count, %), plus per-member top emoji | section | GET `/api/whatsapp/emojis` | KEEP | WhatsApp |
| WA-11 | 📝 Word analysis | section | GET `/api/whatsapp/words` | KEEP | WhatsApp |
| WA-12 | ⚡ Response times (distribution, member average, exchange count) | section | GET `/api/whatsapp/response-times` | KEEP | Phase 6 |
| WA-13 | Excel export for the current range | download link | GET `/api/whatsapp/export?range…` | KEEP | WhatsApp |
| WA-14 | Import history (.txt/.zip, ≤ 50 MB, without media, re-import safe). Shown only if allowed; errors for 413/401/403 | `#wa-import-section` (`waDoImport`) | GET `/api/whatsapp/can-import`; POST `/api/whatsapp/import` (multipart) | KEEP | WhatsApp, role-gated section |
| WA-15 | Empty state: "No WhatsApp messages yet" plus import hint or "Ask Moiz" | `loadWa` | `/api/whatsapp/stats` | KEEP | WhatsApp |

### GW · Giveaway — legacy `#p-giveaway`

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| GW-01 | Hero by state: none · open/draft/locked (title, prize, reveal date, countdown) · drawn (member sees "Winner reveal in") · revealed/closed (🏆 winner + 🎁 prize) | `gwRender` | GET `/api/giveaway` | KEEP | Giveaway |
| GW-02 | Countdown D / H / M / S (local-time parse) | `gwStartCountdown` | client · 1 s | KEEP | Giveaway. At zero it **re-fetches only** (see GW-13) |
| GW-03 | Eligibility: ✅ eligible / 🏆 won this cycle / ⏸ not in this draw | hero | `/api/giveaway .user_eligible, .user_won_this_cycle` | KEEP | Giveaway |
| GW-04 | Rotation progress: cycle, eligible of total, won count, bar | `.gw-rotation` | `/api/giveaway .rotation` | KEEP | Giveaway |
| GW-05 | Past winners (up to 8, collapsible) | `.gw-history` | GET `/api/giveaway/history` | KEEP | Giveaway |
| GW-06 | Confetti once per revealed giveaway (`celebrated_gw_<id>`) | `gwConfetti` | none | KEEP | Reduced motion: no confetti |
| GW-07 | Admin: new giveaway (title, prize, reveal date-time) with auto-publish, "N members entered" | `gwAdminCreate`, `gwCreate` | POST `/api/giveaway`; POST `/api/giveaway/{id}/publish` | KEEP | Giveaway → admin section (role-gated, in context) |
| GW-08 | Admin: edit title / prize / reveal | `gwUpdate` | PUT `/api/giveaway/{id}` | KEEP | Giveaway admin |
| GW-09 | Admin: entries list, remove (×, confirm), add a member from the rotation list | `gwAddEntry`, `gwRemoveEntry` | POST `/api/giveaway/{id}/entries`; DELETE `/api/giveaway/{id}/entries/{member_id}` | KEEP | Giveaway admin |
| GW-10 | Admin: winner preview (draw #, manifest hash, date) | `gwAdminPanel` | `/api/giveaway .active_draw` | KEEP | Giveaway admin |
| GW-11 | Admin state actions: Publish (draft), 🎲 Draw & Reveal (open/locked), 🎉 Reveal Now (drawn), Close (revealed, confirm), Disqualify & Redraw (reason) | `gwAdminPanel` | POST `/publish`, `/draw-and-reveal`, `/close`, `/redraw {reason}` | KEEP | Giveaway admin. Redraw reason becomes a dialog, not `prompt` |
| GW-12 | Admin danger zone: Reset & Seed (past winner, optional title and prize; errors `ambiguous` and `no_match`) | `gwResetAndSeed` | POST `/api/giveaway/admin/reset-and-seed` | KEEP | Giveaway admin, danger zone with explicit confirmation |
| GW-13 | **Auto draw-and-reveal from the page**: an admin loading past `reveal_at`, or the countdown hitting zero, POSTs draw-and-reveal | `loadGiveaway`, `gwStartCountdown` | POST `/api/giveaway/{id}/draw-and-reveal` | EXCLUDE | Rendering must never mutate (plan edge case). Replaced by the idempotent backend auto-reveal job (follow-on code plan) |
| GW-14 | Separate Lock / Draw / Reveal steps (JS helpers exist, no button renders them) | `gwLock`, `gwDraw`, `gwReveal` | POST `/lock`, `/draw`, `/reveal` | EXCLUDE | No legacy UI reaches them; Draw & Reveal covers the flow. The endpoints stay |

### WP · Watch — legacy `#p-watch` + `#wpCamFs` + `#wpMiniBar` (Watch Party)

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| WP-01 | Boot: config (401 → login `next`), load `socket.io.js` from `cfg.origin`, signed Watch Ticket, Socket.IO connect with retry and watchdog | `loadWatch`, `wpTicket`, `wpConnect` | GET `/api/watch/config`; POST `/api/watch/join` `{roomId}` | KEEP | Watch |
| WP-02 | Presence pill (connecting… / live / offline) plus viewer roster | `#wpPresence`, `wpRenderPresence` | socket `watch:presence`, `roster` | KEEP | Watch |
| WP-03 | Stage: HTML5 / HLS (hls.js) / YouTube iframe. Empty state "Nothing playing yet". Autoplay-blocked unblock button | `#wpStage`, `wpMount*`, `wpUnblock` | none | KEEP | Watch |
| WP-04 | Set video: URL + ▶ Play (YouTube and direct files go straight to the room; others resolve via yt-dlp, 429). ✕ Clear | `wpSetVideo` | POST `/api/watch/extract`; streams may use GET `/api/watch/proxy`; socket `CMD:host` | KEEP | Watch |
| WP-05 | "What are we watching?" title (feeds rally + history) | `#wpTitle` | none | KEEP | Watch |
| WP-06 | Shared playback sync: play/pause/seek broadcast, 1 s timestamp map, host recovery (500 ms), ↻ re-sync | `wpBindVideoEl`, `wpRecoverHost`, `wpUserSync` | socket `CMD:play/pause/seek/ts/askHost/host`, `REC:*` | KEEP | Watch |
| WP-07 | Overlay control bar: seek bar (buffered, tooltip, drag or tap), play/pause, video volume/mute, time, everyone's-mic volume/mute (desktop), mic, camera, leave, react, sync, cams-over-video, fullscreen. Auto-hides. Mouse click = play, double-click = fullscreen; touch tap = show bar | `#wpBar`, `wpBindBar` | client · 250 ms tick | KEEP | Watch |
| WP-08 | Keyboard: k/Space play, ←/→ 5 s, j/l 10 s, f fullscreen, c camera, e reactions, m mic (global) | `keydown` handler | none | KEEP | Accelerators; every one has a visible button |
| WP-09 | Reactions tray (10 emoji). 3 of the same within 5 s = celebration. Spam guard 8 per 3 s. Reduced-motion aware | `#wpRxTray`, `wpReact` | peer `signal` relay | KEEP | Watch |
| WP-10 | Join call with camera + mic (mic-only fallback), mute, camera off, flip camera, leave. Mic and output device selects | `wpToggleCam`, `wpToggleVideo`, `#wpMicSel`, `#wpOutSel` | WebRTC via socket `signal` | KEEP | Watch |
| WP-11 | Camera orbs: one per viewer, speaking glow (120 ms meter), tap to enlarge | `#wpOrbs`, `wpRenderOrbs`, `wpMeter` | none | KEEP | Watch |
| WP-12 | Per-person menu via **long-press 450 ms / right-click** on an orb: Mute for me, per-person volume, Enlarge/Shrink, Remove from party (moderator). Own orb: join / mute / camera / flip / leave | `wpBindOrbPress`, `wpPopOpen`, `wpKick` | socket `CMD:kickUser` | KEEP | Visible equivalent: a **⋯ button** on every orb/tile opens the same menu |
| WP-13 | ⛶ Camera grid fullscreen overlay with 🔄 Flip | `#wpCamFs` (`wpFsOpen`, `wpFsClose`, `wpFlipCam`) | none | KEEP | Watch |
| WP-14 | Cams-over-video overlay toggle | `wpToggleOverlay` | none | KEEP | Watch |
| WP-15 | Fullscreen stage with an inline chat feed + input (Enter focuses) | `#wpFsc`, `wpFscSend` | socket `CMD:chatV` | KEEP | Watch |
| WP-16 | Room chat log + input | `#wpChatLog`, `wpSendChat` | socket `CMD:chatV`, `REC:chat`, `chatinit` | KEEP | Watch |
| WP-17 | ✏️ Display name (blank = PSN name), then reconnect | `wpEditNickname` (`prompt`) | POST `/api/watch/nickname` | KEEP | Dialog, not `prompt` |
| WP-18 | 📣 Rally: "@all <viewers> are on CRCMZ app watching <title>… /watch" to WhatsApp (503 = not configured) | `wpRally` | POST `/api/watch/rally` `{message}` | KEEP | Watch. The link target `/watch` → legacy `/?p=watch` is an existing route contract; unchanged |
| WP-19 | 🕘 History: This room / Just me, ↻ refresh. Cards show poster, title/year, kind, progress, "left off at", viewers, age and 💬 count, plus ▶ Resume/Play, ⓘ, ✎ rename, ✕ forget. Open a card to see the past chat | `wpHistLoad`, `wpHistRender`, `wpHistOpen`, `wpHistRename`, `wpHistForget` | GET `/api/watch/history?limit=24&…`; GET `/api/watch/history/chat?url=`; POST `/api/watch/history/title`; DELETE `/api/watch/history` | KEEP | Watch |
| WP-20 | Progress save (on pause, 3 s check, `keepalive`) | `wpHistPost` | POST `/api/watch/history` | KEEP | Background |
| WP-21 | Client diagnostics ring buffer (flush 10 s, heartbeat 30 s) | `wpLog`, `wpLogFlush` | POST `/api/watch/log` | KEEP | Non-visual |
| WP-22 | Server error and kicked messages | socket `errorMessage`, `kicked`; `#wpErr` | none | KEEP | Watch states (Phase 2) |
| WP-23 | Semantic event report (feedback/errors) | not called by the template | POST `/api/watch/event` | EXCLUDE | No legacy UI. It is a telemetry endpoint; stays available |

### HU · Huddle — legacy `#p-huddle` (LiveKit video call + AI)

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| HU-01 | Pre-join: local camera preview (camera-off state), room name (default `crcmz`), mic and camera selects, 🎥 Join, status message | `#huddlePre` (`loadHuddle`, `huddleJoin`) | POST `/api/huddle/token` `{room}`; LiveKit client from the jsDelivr CDN | KEEP | Huddle |
| HU-02 | In-call top bar: room name, participant count, ⊞ layout toggle, 💬 AI toggle | `.hs-topbar` | none | KEEP | Huddle |
| HU-03 | Spotlight + filmstrip, or grid; active-speaker spotlight | `huddleRenderAll`, `huddleActiveSpeakers` | LiveKit | KEEP | Huddle |
| HU-04 | Controls: 🎤 mic, 📷 camera, 🖥 screen share, 🌫 background blur, 🔴 Leave | `.hs-controls` | LiveKit | KEEP | Huddle |
| HU-05 | AI side panel: ask the AI in-call, status | `huddleAiSend` | POST `/api/huddle/ai` `{messages}` | KEEP | Huddle |
| HU-06 | 🎙 Live transcript (MediaRecorder chunks → transcription) | `huddleToggleTranscript` | POST `/api/huddle/transcribe` (multipart) | KEEP | Huddle |
| HU-07 | 📋 Meeting notes from the transcript | `huddleMeetingNotes` | POST `/api/huddle/ai` | KEEP | Huddle |
| HU-08 | In-call state when you navigate away (legacy: silent, no indicator) | none | LiveKit room stays connected | MOVE → global call mini-bar (G-08) | Plan constraint: the Watch/Huddle mini-bar persists across routes |

### CO · AI Coach — legacy `#p-coach`

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| CO-01 | Scope tabs: Mine (n) / Squad (n) | `coachSetScope` | GET `/api/coaching?scope=me\|squad` | KEEP | AI Coach |
| CO-02 | Notify prefs: Group / DM / Off. Shows: Report / Link only | `coachSetMode`, `coachSetDetail` | POST `/api/coaching/prefs` `{mode}` / `{detail}` | KEEP | AI Coach (in context; not moved to Settings) |
| CO-03 | Hero: latest grade + delta (▲ ▼ =), repeated-mistake focus line, "Next session" drill, grade trajectory chart (last 12) | `coachHero`, `coachTrend` | `/api/coaching` | KEEP | Phase 6 chart |
| CO-04 | Stats: reviews, this week, processing, 30-day sparkline | `coach-stats` | `/api/coaching .counts, .charts.per_day` | KEEP | AI Coach |
| CO-05 | Grades bars and Themes bars | `coachBars` | `/api/coaching .charts` | KEEP | Phase 6 |
| CO-06 | Mistake patterns (×2+ = habit; tap opens the source report) | `mistakeRows` | `.charts.mistakes` | KEEP | AI Coach |
| CO-07 | Squad sightings (squad scope; no link to private reports) | `sightRows` | `.sightings` | KEEP | AI Coach |
| CO-08 | Processing list | `.coach-proc` | `.processing` | KEEP | AI Coach |
| CO-09 | Reports toolbar (Mine): search, game filter, player filter (squad), sort Newest / Oldest / Best / Worst, count, Clear filters | `coachToolbarHtml` | client-side | KEEP | AI Coach |
| CO-10 | Report card: expand/collapse, grade badge (complete only), summary, strengths, mistakes, tips, notable moments, squad voice (own). Feedback: 👍/👎, tags, comment, Submit, ✓ saved | `coachCard`, `coachFb*` | POST `/api/coaching/feedback` `{review_id, rating, tags, comment}` | KEEP | AI Coach |
| CO-11 | States: signed out, error + Retry, empty ("send **rev** within ~5 s of a clip") | `loadCoach` | `/api/coaching` 401 | KEEP | AI Coach |

### AI · Ask AI — legacy `#p-ai`

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| AI-01 | Model + tool count line. No model configured → error, composer disabled | `loadAsk` | GET `/api/assistant/tools` | KEEP | Ask AI |
| AI-02 | Suggestion chips (6: squad, who's online, music taste, who yaps, busiest hours, what is CRCMZ) | `.ai-chips` (`aiChip`) | none | KEEP | Ask AI |
| AI-03 | Server-stored thread: re-renders from the server, pending answer polling (1 s counter, 2 s fetch), "thinking… Ns", tools used and elapsed meta, refresh on tab return | `loadHistory`, `renderThread`, `startPolling` | GET `/api/assistant/history` · 2 s while pending | KEEP | Ask AI |
| AI-04 | Ask with optional image (≤ 4 MB, thumbnail, remove). 202 accepted. 429 / 409 / 401 / network ("may not have been sent") | `askSend`, `aiImgPicked` | POST `/api/assistant/ask` `{question, image_b64?, image_type?}` | KEEP | Ask AI (reading width) |
| AI-05 | 🗑 Clear chat (confirm; facts stay) | `askClear` | POST `/api/assistant/clear` | KEEP | Ask AI |
| AI-06 | 🧠 Squad facts: total / mine / max per user, add (subject with suggestions + text), filter (> 6), list with author, delete own (confirm) | `#factBox` (`loadFacts`, `factAdd`, `factDel`) | GET / POST `/api/assistant/facts`; POST `/api/assistant/facts/delete` `{id}` | KEEP | Ask AI |
| AI-07 | Explainer: "Runs on the Mac at home… It only reads." | `#p-ai` intro | none | KEEP | Ask AI (Phase 5 copy) |

### ST · Settings — legacy `#settingsOverlay` modal with 6 tabs

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| ST-01 | Settings entry: account menu → modal overlay, tab strip, ✕ / backdrop close | `openSettings`, `switchTab`, `closeSettings` | none | MOVE → Settings destination | `/app/settings/<tab>` sub-routes. Deep-linkable, Back works |
| ST-02 | 🔑 Passkeys: list (name, added date), Remove (confirm), ＋ Add new passkey (WebAuthn) | `#tab-passkeys` | GET `/auth/settings/passkeys`; DELETE `/auth/settings/passkeys/{id}`; POST `/auth/passkey/register/begin`, `/complete` | KEEP | Settings → Passkeys |
| ST-03 | 🔒 Change password (current, new, confirm, ≥ 8) | `#tab-security` | POST `/auth/settings/password` | KEEP | Settings → Security |
| ST-04 | 🎮 PSN status: online id, linked date, Active/Expired, expired warning, Re-link | `#tab-psn` (`loadPsnStatus`) | GET `/auth/settings/psn` | KEEP | Settings → PSN. Re-link hands off to Portal |
| ST-05 | Claim an unclaimed PSN account ("This is mine", confirm) | `claimPsn` | POST `/auth/settings/psn/claim` `{key}` | KEEP | Settings → PSN, also offered on Portal |
| ST-06 | Inline 3-step PSN link flow (step dots, open PlayStation.com, open the Sony token page, paste + 📋 clipboard, 🔗 Link) | `#psnLinkFlow` (`psnAdvance`, `linkPsn`, `psnPasteClipboard`) | POST `/api/psn/link` `{npsso}`; external `playstation.com`, `ca.account.sony.com/api/v1/ssocookie` | MOVE → Portal | One wizard in `/app` (PO-01). Settings links to it |
| ST-07 | Admin: "All accounts" list (claimed/unclaimed, Active/Expired) inside the PSN tab | `_adminUsersHtml` | `/auth/settings/psn .users` (admin) | MOVE → Admin | AD-06 |
| ST-08 | 💬 Mattermost: status, 🔗 Connect (OAuth popup, `postMessage 'mm_linked'`), Disconnect | `#tab-mattermost` | GET `/auth/settings/mattermost`; popup `/auth/settings/mattermost/connect`; POST `/auth/settings/mattermost/unlink` | KEEP | Settings → Mattermost |
| ST-09 | 🤖 MCP: connected + last used, or how-to steps + config block + Copy + 🔄 Refresh. Disconnect (confirm) | `#tab-mcp` | GET `/auth/settings/mcp`; POST `/auth/settings/mcp/revoke` | KEEP | Settings → MCP |
| ST-10 | 👥 Users tab (admin only): list (name, email, state), 🔑 Reset pw form (≥ 8, confirm) | `#tab-users` (`loadAdminUsers`, `adminResetPassword`) | GET `/api/admin/users`; POST `/api/admin/users/{id}/reset-password` | MOVE → Admin | AD-05 |
| ST-11 | Legacy passkey shortcut from the user menu | `registerPasskey()` | as ST-02 | EXCLUDE | Not reachable from any current control; superseded by ST-02 |

### PO · Portal (PSN link wizard; `_portal_page()` at `/portal`)

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| PO-01 | 3-step wizard with locked steps: ① Sign in to PlayStation ② Grab your token (NPSSO page) ③ Paste & link (textarea, 📋 Paste from clipboard, 🔗 Link my account) | `/portal` form | legacy: POST `/portal/link` (form). `/app`: POST `/api/psn/link` `{npsso}` (session) | KEEP | `/app/portal` (reading width). Legacy `/portal` untouched |
| PO-02 | "Who are you?" Mattermost username select (fallback: text field) | `/portal` form | `portal.mattermost_usernames()`; `/portal/users` | EXCLUDE | In `/app` the session is the identity: `/api/psn/link` derives or keeps `mm_username` from the Zitadel session |
| PO-03 | Success screen "You're all set! 🎉 <online id>" with See the Squad / Link another account | `_portal_page(ok=)` | none | KEEP | Portal success state. "See the Squad" → `/app` |
| PO-04 | Error banner ("⚠️ …", "Try a fresh token") | `_portal_page(error=)` | 400/500 from the link endpoint | KEEP | Portal error state |
| PO-05 | Claim an existing unclaimed account before linking a new one | Settings PSN tab | POST `/auth/settings/psn/claim` | KEEP | Portal step 0 when unclaimed accounts exist (shared with ST-05) |

### AD · Admin (new destination; collects ops)

| ID | Capability | Legacy location | Endpoint(s) · cadence | Disposition | `/app` target / note |
|---|---|---|---|---|---|
| AD-01 | Admin gate (shows the Users tab / admin UI) | `openSettings` → `/api/admin/check` | GET `/api/admin/check` `{admin}` | KEEP | Gates the Admin nav item and admin sections |
| AD-02 | Service health: PSN Messenger, Montage Engine, WhatsApp Bridge | legacy Clips `[data-sec=services]` (CL-06) | GET `/api/pipeline-status .services` · 30 s | MOVE → Admin | From Clips |
| AD-03 | Ops snapshot: PSN connected, WhatsApp configured, clip store backend, watched groups, queue depth | none (research-listed) | GET `/status` | KEEP (new) | Admin |
| AD-04 | Video job queue: stats + depth | none (research-listed) (CL-32) | GET `/api/video-jobs` | MOVE → Admin | Admin |
| AD-05 | User management: list + reset password | Settings Users tab (ST-10) | GET `/api/admin/users`; POST `/api/admin/users/{id}/reset-password` | MOVE → Admin | Admin |
| AD-06 | PSN accounts: all linked accounts, claimed/unclaimed, token Active/Expired (NPSSO ~60-day expiry) | Settings PSN tab admin list (ST-07) | GET `/auth/settings/psn .users` | MOVE → Admin | Admin |
| AD-07 | Roast bot: status, start/stop auto-roast, roast once | none in the template (routes only; `b.path` hook in CB-02) | GET `/roast/status`; POST `/roast/start`, `/roast/stop`, `/roast/once` | MOVE → Admin | **Owner confirm (O-1).** If declined: EXCLUDE (no legacy UI) |
| AD-08 | Shortcuts to in-context admin: Giveaway admin (GW-07…12), Clips "Everyone's reels" (CL-09), WA import (WA-14) | none | none | KEEP (new, links only) | Admin → links. The controls stay where the task lives |

### Pollers (all 13 `setInterval` in the template)

| Poller | Cadence | Row |
|---|---|---|
| Squad presence | 30 s | SQ-04 (feeds SQ-01/03/05, G-05) |
| Hype | 60 s | SQ-02 |
| Pipeline status | 30 s | CL-03/04/05, AD-02 |
| Ask AI pending thread | 1 s tick / 2 s fetch (only while pending) | AI-03 |
| Studio render status | 2 s (until done/failed) | CL-21 |
| Giveaway countdown | 1 s | GW-02 |
| Watch log flush | 10 s | WP-21 |
| Watch heartbeat log | 30 s | WP-21 |
| Watch timestamp broadcast `CMD:ts` | 1 s | WP-06 |
| Watch control-bar tick | 250 ms | WP-07 |
| Watch speaking meter | 120 ms | WP-11 |
| Watch host recovery | 500 ms (transient) | WP-06 |
| Watch history progress check | 3 s | WP-20 |

### Gesture-only capabilities → visible equivalents (plan edge case)

| Gesture (legacy) | Row | Visible equivalent in `/app` | Principle |
|---|---|---|---|
| Horizontal swipe to switch shared ⇄ personal board | CB-04 | Labeled **Shared / Mine** tabs in the board header | WCAG 2.2 SC 2.5.1 Pointer Gestures; Norman: signifiers |
| Long-press a custom tile to delete | CB-06 | **Edit** toggle → ✕ on each custom tile | WCAG 2.5.1; Nielsen #6 recognition over recall |
| Fullscreen + long-press to enter organize | CB-07 | **Organize** button, always in the board header | Nielsen #6; discoverability |
| Drag to reorder tiles | CB-07 | **Move earlier / Move later** per tile in organize mode | WCAG 2.2 SC 2.5.7 Dragging Movements |
| Drag the manual crop box | CL-17 | X-position slider + ◀ ▶ nudge | WCAG 2.5.7 |
| Drag trim/zoom/sub timeline handles | CL-15 | Existing **Start here / End here** buttons | WCAG 2.5.7 (already met) |
| Long-press / right-click a Watch orb for its menu | WP-12 | **⋯** button on each orb | WCAG 2.5.1; Norman: signifiers |
| Double-click the stage for fullscreen; tap to show the bar | WP-07 | Existing Fullscreen button; the bar is reachable by focus | (already met) |
| Tap the board title to minimize | CB-08 | Explicit collapse control / sheet handle with a label | Nielsen #1 |

### Server routes outside `_DASHBOARD_TMPL` (completeness)

| Route(s) | Disposition | Reason |
|---|---|---|
| `/mcp`, `/oauth/*`, `/.well-known/*`, `/api/watch/jwks.json` | EXCLUDE | Scope OUT: MCP/OAuth machine endpoints (no UI) |
| `/api/clips/media` (bearer), `/api/video-uploads/media` | EXCLUDE (as machine routes) | Machine clients. CL-31 depends on the planned session-cookie change to `/api/clips/media` |
| `/api/whatsapp/ingest` | EXCLUDE | Machine-to-machine (WA bridge) |
| `/send`, `/messages`, `/v2/messages`, `/v2/messages/raw`, `/health`, `/v2/health` | EXCLUDE | Legacy / monitoring / Stream Deck paths; no dashboard UI |
| `/api/scan-group` | EXCLUDE | Backfill op with no UI. It must only register clips in the DB and never forward to WA; kept off the UI to avoid accidental runs |
| `/auth/login`, `/auth/callback`, `/auth/passkey/begin`, `/auth/passkey/complete` | EXCLUDE | Login flow, not dashboard. `/app` redirects to it when signed out |
| `/`, `/dashboard`, `/portal`, `/portal/link`, `/portal/users`, `/watch` | EXCLUDE | Legacy pages stay untouched; `/app` links into them only where noted (WP-18) |

---

## §Job

**JTBD school:** Moesta's Switch interview (four forces), written as job stories. I use one school only (journey doctrine). **Research basis:** the owner brief (research doc, confirmed 2026-09-30) plus this code audit. **No interviews have been run.** Treat the forces as hypotheses until two squad members walk through the Phase 2 mock.

### Core job

> **When** I've got a few minutes around a gaming session, **I want to** see who's on and pull the squad together in one tap, **so I can** play and hang out with my friends instead of coordinating in three different chats.

Functional: presence, a one-tap rally, going back to shared moments. Emotional: feeling part of the crew, the "the squad's live!" buzz. Social: in-jokes as a shared language (the soundboard *is* the group's voice), bragging rights.

### Job stories

| # | Job story | Destination(s) | Dimension |
|---|---|---|---|
| J1 | When I pick up my phone before or mid-session, I want to see who's online and what they're playing at a glance, so I can decide whether to hop on. | Squad | functional |
| J2 | When two or more of us are on, I want to rally or ping everyone with one tap (Squad Up, an in-joke tile, a quick line), so I can pull people in without typing on a controller. | Squad (Chat Board) | functional + social |
| J3 | When I've clipped something wild, I want to see it land, trim/crop it into a reel and know if it makes the montage, so I get the credit and the squad sees it. | Clips | emotional + social |
| J4 | When I have a video worth sharing, I want to send it to @crcmzclan from my phone even on a flaky connection, so it gets posted without me babysitting it. | Clips (upload) | functional |
| J5 | When we're not gaming, I want to watch something together or jump on a call, so we can hang out remotely. | Watch, Huddle | social + emotional |
| J6 | When I'm curious or want ammunition for banter, I want trophies, chat awards, music leaderboards and my coach grade, so I can talk trash with receipts. | Squad (ranks), WhatsApp, Slap, AI Coach | social |
| J7 | When I want to get better, I want the AI's read on my clips and one drill for next time, so I improve without watching my own VODs. | AI Coach | functional |
| J8 | When I have a question about the squad, I want to ask something that already knows our history, so I don't have to scroll back through chats. | Ask AI | functional |
| J9 | When the monthly giveaway runs, I want to see if I'm eligible and watch the reveal, so it feels fair and fun. | Giveaway | emotional |
| J10 | When I'm new, or my PSN token expires (~60 days), I want a quick link/relink, so I show up on Squad and my clips are matched to me. | Portal, Settings | functional |
| J11 (admin) | When something looks off (no clips, silent bridge, expired tokens), I want service health and account status in one place, so I can fix it before the squad notices. | Admin | functional |

### Four forces (Switch)

| Force | For moving to `/app` |
|---|---|
| **Push** (legacy pain) | The dropdown nav gives no orientation. 760 px on desktop wastes half the screen. The Chat Board covers the Ask AI composer. Everything glows, so nothing stands out. No type scale. Board delete/reorder are hidden behind long-press. |
| **Pull** (new promise) | Persistent nav (sidebar / tab bar), every place reachable in ≤ 2 taps, a denser desktop, Watch/Huddle staying live while you browse, inline clip playback. |
| **Anxiety** (fear of switching) | "Will it still feel like CRCMZ?" (aurora, neon, Orbitron — Phase 3 pins). "Will my tiles, order and muscle memory survive?" (swipe and long-press kept as accelerators). "Did my message send?" (non-idempotent sends stay honest). |
| **Habit** (pull of the old) | `/` stays the default and untouched. `?p=` bookmarks and the `/watch` rally links keep working. Stream Deck buttons are unaffected. |

---

## §Journey

**Actor:** a squad member (~10 friends who know each other). Phone during gaming, desktop while streaming or watching.
**Scenario:** an ordinary evening, plus the month-end ritual.
**Scope:** the `/app` touchpoints plus the channels that trigger them (PSN group, WhatsApp "Goopers", Stream Deck, Mattermost).
**Owner:** Moiz. **Update cadence:** after each `/app` release, or when a destination is added or removed. **Basis:** brief + code audit, no field research. This is a hypothesis map, not evidence (Watermark 2023 warns maps without an owner and basis become theater).

**Decision model:** the McKinsey loyalty loop (Court et al. 2009), not a funnel. The squad does not "convert". It loops: a **trigger** (a friend comes online, a WA rally, a clip lands, the montage drops) → **open** the app → **act** (fire, watch, edit) → **bond** (a shared moment, the reveal) → the next trigger. Entry is from anywhere in the loop: most sessions start from a push outside the app, not from the home screen.

### Swim lanes

| Phase | 1 Check-in | 2 Rally | 3 Play & capture | 4 Relive | 5 Hang out | 6 Banter & reflect | 7 Month-end ritual |
|---|---|---|---|---|---|---|---|
| **Actions** | Open `/app`, scan presence, see the hype level | Fire Squad Up or an in-joke tile, quick message, Rally ▶ on "3 in X" | Play. Post a clip in the PSN group, send `rev` for coaching | Open Clips, review a reel, trim/crop/subs, render, approve or veto. Send a video to socials | Start a Watch Party (paste link, Rally to WA) or join Huddle. Keep browsing via the mini-bar | Check trophies, WA awards, Slap leaderboard, coach grade. Ask the AI a squad question | Montage builds and auto-sends. Giveaway reveal. Clips older than 14 days purge after publish |
| **Mindset** | "Anyone on?" | "Get in here." | "That was insane — clip it." | "Make me look good." | "Let's just chill." | "Receipts." | "Did I make it? Did I win?" |
| **Emotion (1–5)** | 3 curious | 4 hyped | 5 peak | 3→4 (editing effort → payoff) | 4 warm | 3→4 playful | 5 peak (win) / 2 dip (didn't make the cut) |
| **Touchpoints** | Squad (presence, hype, stats) | Squad Chat Board; PSN group receives | PSN app/console; PSN group | Clips (reels, Studio, upload); IG/TikTok/YT | Watch, Huddle, mini-bar; WhatsApp receives the rally | Squad ranks, WhatsApp, Slap, AI Coach, Ask AI | Clips (montage, retention), Giveaway, WhatsApp |
| **Channels** | phone (primary), desktop | phone | console + phone | desktop (Studio) and phone | desktop/TV + phone | phone, desktop | phone (notification-driven) |
| **Pain today (legacy)** | Presence is below a dropdown and a board that eats the screen | Delete/reorder hidden behind long-press; "did it send?" | none (outside the app) | 760 px column. Services health clutters the top of Clips | Leaving Watch hides call state; Huddle has no indicator | Stats spread across dropdown sections | Auto-reveal happens on an admin's page load (a render side effect) |
| **Opportunities** | Presence first above the fold; compact hype/stats on mobile (≤ 12 % chrome) | Visible Shared/Mine, Edit, Organize; honest send states | Coach empty state teaches `rev` | Desktop Studio at full width; health moves to Admin; inline playback | One call mini-bar for Watch and Huddle across all routes | Consistent data tiles (Phase 6) | Idempotent backend reveal; fair, pressure-free copy (Phase 5); make the "not in montage" dip gentle |

**Emotion curve (hypothesis):** `3 ─ 4 ─ 5 ─ 3↗4 ─ 4 ─ 3↗4 ─ 5|2`. The peaks are rally and capture; the dip risk is month-end for anyone left out. The design should protect the peaks (one tap, instant feedback) and soften the dip (clear eligibility, no shaming copy).

**Admin lane (Moiz):** notices trouble through silence (no clips, no WA messages) → opens Admin → reads service health, token expiry and the job queue → fixes (reset password, relink a token, run the giveaway). Today this is scattered across Clips, the Settings PSN tab and Settings Users.

---

## §IA

### Model

- **Organization scheme:** a task/topic hybrid (Rosenfeld/Morville ambiguous schemes). Destinations are named for what the squad does (Watch, Huddle, Ask AI) or the thing they look at (Clips, WhatsApp, Slap).
- **Structure:** hub-and-spoke on a **flat** tree. Squad is the hub; every destination is one level deep. Depth appears only inside a destination (Settings tabs, Clips → Studio). Broad-and-shallow beats deep for 12 known destinations and a known audience (usability doctrine: Miller/Cowan is about memory, not visible item count).
- **Navigation systems:**
  - Global: the sidebar at ≥ 1024 px; the tab bar + More sheet below 1024 px.
  - Local: Settings tabs; Clips sections; AI Coach Mine/Squad; Watch history This room/Just me.
  - Contextual: see the table below.
  - Utility: the account menu.
  - Persistent status: the call mini-bar and the toast.
- **Breakpoint for switching nav systems:** 1024 px, matching the legacy side-panel and Clips breakpoints. Phase 3 (surface/responsive) owns the final values; the IA only needs two nav modes.
- **Role gating:** Admin is shown only when `/api/admin/check → admin`. Non-admins see 11 destinations. The reachability audit below uses the admin persona, the superset.
- **Validation:** there was no card sort. The labels are the squad's existing ones (continuity: Jakob's law). **Tree test before code:** 5 squad members, 6 tasks (find Chat Board, send a video, re-link PSN, open Watch history, change coach notify, check service health), target ≥ 80 % direct success. This is a follow-up; it is not blocking Phase 2.

### Destinations (12)

| # | Destination | Nav label | Route | Legacy source | Role | Content width |
|---|---|---|---|---|---|---|
| 1 | Squad | Squad | `/app` (alias `/app/squad`) | `p-squad` + Chat Board | all | full, with Chat Board right panel (desktop) |
| 2 | Clips | Clips | `/app/clips` (`?upload` opens the sheet; `/app/clips/{id}/edit` = Studio) | `p-pipeline` | all | full; wide media grid ≥ 1440 |
| 3 | Slap | Slap | `/app/slap` | `p-slap` | all | full |
| 4 | WhatsApp | WhatsApp | `/app/whatsapp` | `p-wa` | all | full |
| 5 | Giveaway | Giveaway | `/app/giveaway` | `p-giveaway` | all (+ admin section) | full |
| 6 | Watch | Watch | `/app/watch` | `p-watch` | all (+ mod actions) | full (stage) |
| 7 | Huddle | Huddle | `/app/huddle` | `p-huddle` | all | full (call stage) |
| 8 | AI Coach | AI Coach | `/app/coach` | `p-coach` | all | full |
| 9 | Ask AI | Ask AI | `/app/ask` | `p-ai` | all | reading width (~760 px) |
| 10 | Settings | Settings | `/app/settings/{passkeys\|security\|psn\|mattermost\|mcp}` | settings modal | all | reading width |
| 11 | Admin | Admin | `/app/admin` | Clips services, Settings Users/PSN list, `/status`, `/api/video-jobs`, roast | admin | full |
| 12 | Portal | Link PSN | `/app/portal` | `/portal` wizard + Settings PSN inline flow | all | reading width |

**Label note:** Portal's nav label is **"Link PSN"**. It is named for the task, not the internal page name (Rosenfeld/Morville labeling: use the user's language). The destination stays "Portal" in specs.

**Legacy URL map** (`/app?p=<key>` and bookmarks):

| Legacy key | New route |
|---|---|
| `squad` | `/app` |
| `pipeline` | `/app/clips` |
| `upload` | `/app/clips?upload` |
| `slap` | `/app/slap` |
| `wa` | `/app/whatsapp` |
| `giveaway` | `/app/giveaway` |
| `watch` | `/app/watch` |
| `huddle` | `/app/huddle` |
| `coach` | `/app/coach` |
| `ai` | `/app/ask` |

An unknown key goes to `/app`, as in the legacy fallback. The legacy `/watch` and `/portal` routes are unchanged.

### Desktop sidebar (≥ 1024 px), persistent, landmark `aria-label="Primary"`

```
┌──────────────────────┐
│ [logo] CRCMZ APP     │  wordmark (G-01)
│ Yes. We have one.    │
├──────────────────────┤
│ ● Squad        (3)   │  live-count badge (G-05)
│   Clips              │
│   Slap               │
│   WhatsApp           │
│   Giveaway           │
│   Watch              │
│   Huddle             │
│   AI Coach           │
│   Ask AI             │
├──────────────────────┤  footer utility group
│   Link PSN           │  (Portal)
│   Settings           │
│   Admin              │  admin only
├──────────────────────┤
│ [call mini-bar]      │  only while in Watch/Huddle (G-08, HU-08)
│ [avatar] name  ▾     │  account menu: Sign out (G-04)
└──────────────────────┘
```

The main list keeps the research-locked order. Rows are ≥ 44 px (carry-over). `aria-current="page"` marks the active item.

### Mobile tab bar (< 1024 px), landmark `aria-label="Tab bar"`, thumb zone (Fitts 1954)

```
┌────────┬────────┬────────┬────────┐
│ Squad  │ Watch  │ Clips  │  More  │
└────────┴────────┴────────┴────────┘
```

**More** is highlighted as active when the current route is one of its destinations, so orientation holds (Nielsen #1). The call mini-bar docks directly above the tab bar while you're in Watch or Huddle. Tapping it returns to the call.

### Mobile More sheet (bottom sheet with a scrim; tap the scrim or swipe down to close)

```
── Squad ─────────────────────────
  Slap       WhatsApp    Giveaway
  Huddle     AI Coach    Ask AI
── Account ───────────────────────
  Link PSN   Settings    Admin*
```

This keeps the research order and adds Portal. It has two labeled groups, 6 + 3, to cut decision time (Hick–Hyman 1952). Admin* is shown to admins only. Each item is a ≥ 44 px target.

### Reachability (admin persona, from any destination)

| # | Destination | Desktop sidebar | Clicks | Mobile placement | Taps | Path |
|---|---|---|---|---|---|---|
| 1 | Squad | main list, item 1 | 1 | Tab bar | 1 | Squad |
| 2 | Clips | main list, item 2 | 1 | Tab bar | 1 | Clips |
| 3 | Slap | main list, item 3 | 1 | More sheet · Squad group | 2 | More → Slap |
| 4 | WhatsApp | main list, item 4 | 1 | More sheet · Squad group | 2 | More → WhatsApp |
| 5 | Giveaway | main list, item 5 | 1 | More sheet · Squad group | 2 | More → Giveaway |
| 6 | Watch | main list, item 6 | 1 | Tab bar | 1 | Watch |
| 7 | Huddle | main list, item 7 | 1 | More sheet · Squad group | 2 | More → Huddle |
| 8 | AI Coach | main list, item 8 | 1 | More sheet · Squad group | 2 | More → AI Coach |
| 9 | Ask AI | main list, item 9 | 1 | More sheet · Squad group | 2 | More → Ask AI |
| 10 | Settings | footer group | 1 | More sheet · Account group | 2 | More → Settings |
| 11 | Admin | footer group (admin) | 1 | More sheet · Account group (admin) | 2 | More → Admin |
| 12 | Portal | footer group ("Link PSN") | 1 | More sheet · Account group ("Link PSN") | 2 | More → Link PSN |

**Result:** 12/12 destinations in the sidebar (max 1 click) and 12/12 in the tab bar + More sheet (3 in the tab bar at 1 tap, 9 in More at 2 taps). The maximum is **2 taps**.

Secondary surfaces, for reference only (not destinations):

| Surface | Mobile path | Taps |
|---|---|---|
| Chat Board | Squad → handle | 1 |
| Send a video | Clips → Send a video | 2 |
| Reel Studio | Clips → reel | 2 |
| A Settings tab | More → Settings → tab | 3 |
| Call return (mini-bar) | tap the mini-bar | 1 |

### Contextual navigation (cross-links that shortcut the tree)

| From | Trigger | To |
|---|---|---|
| Squad presence empty state | "Nobody linked yet" | Portal |
| Clips reels | needs-PSN-link state (CL-11) | Portal |
| Clips upload | 403 "link your account" (CL-28) | Portal |
| Settings → PSN | Link / Re-link / token expired | Portal |
| Portal success | "See the Squad" | Squad |
| Admin | Giveaway admin, Everyone's reels, WA import | Giveaway, Clips, WhatsApp (in-context sections) |
| Admin → PSN accounts | expired token row | (reads only; the member relinks via Portal) |
| Call mini-bar | tap | Watch or Huddle |
| Watch Rally message | `/watch` link in WhatsApp | legacy `/?p=watch` (unchanged route contract) |
| Coach empty state | "send **rev**" instruction | (no link; PSN group action) |

### Persistent and scoped elements

| Element | Scope | Rule |
|---|---|---|
| Chat Board | **Squad only** | Right panel on desktop, bottom sheet on mobile. Never rendered elsewhere (research decision) |
| Call mini-bar | all routes except the active call's own page | Shows while connected to Watch or in a Huddle |
| Toast / live region | global | Transient feedback |
| Account menu | global (sidebar footer / top bar) | Sign out; Settings shortcut |
| Admin sections | role-gated | Hidden, not disabled, for non-admins |
