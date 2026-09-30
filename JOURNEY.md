# JOURNEY.md: CRCMZ App (`/app`)

**Status:** Phases 1–2 of `.design-foundations/plans/2026-09-30-crcmz-app.md` are done: §Inventory, §Job, §Journey, §IA (Phase 1) and §Flows, §Page specs (Phase 2). §Microcopy comes in Phase 5 and §Data specs in Phase 6. The inventory now counts 163 KEEP / 12 MOVE / 10 EXCLUDE; Phase 2 moved AD-07 (roast) to EXCLUDE per owner decision O-1 and added the O-2 note to CL-30.
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
| CL-30 | Re-send a clip to WhatsApp (research-listed) | none | POST `/api/clips/{uid}/resend` (409 not archived · 410 missing · 503 no bridge) | KEEP | Clips → clip detail. **Admins only, behind a confirm naming the clip (owner decision O-2).** Not idempotent; needs a server-side admin gate (backend change). *Phase 2 note added.* |
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
| AD-07 | Roast bot: status, start/stop auto-roast, roast once | none in the template (routes only; `b.path` hook in CB-02) | GET `/roast/status`; POST `/roast/start`, `/roast/stop`, `/roast/once` | EXCLUDE | **Owner decision O-1 (2026-09-30): roast bot excluded from `/app`.** No legacy UI; the routes stay for other callers. `/app` does not render `/roast/*` path tiles (CB-02). *Phase 2 fix: was "MOVE → Admin, pending O-1".* |
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
| 11 | Admin | Admin | `/app/admin` | Clips services, Settings Users/PSN list, `/status`, `/api/video-jobs` (roast removed in Phase 2, owner decision O-1) | admin | full |
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

---

## §Flows

**Notation** (journey doctrine §E): ○ entry/exit · ◇ decision · ▭ action · ⚠ failure branch. These are **user flows** (branching). Each ends in a named outcome that the page spec's state matrix covers. Contracts were verified against `server.py` / `reels.py` on 2026-09-30. Slap contracts come from a live probe the same day.

**Laws applied throughout.** Fitts (1954): primary actions sit in the thumb zone and are large. Hick–Hyman (1952): each decision node offers few options, staged. Nielsen #1 (visibility of status), #3 (user control), #5 (error prevention) and #9 (recover from errors) (1994).

### F-0 · Send outcome model (shared by every non-idempotent send)

PSN group messages, the WhatsApp rally, clip re-send and "add tile + send now" **cannot be deduplicated by the server**. A retry can double-post. Every such send uses this model and **never retries automatically**.

| Outcome | Trigger (verified) | What the UI does | Next action |
|---|---|---|---|
| **Sending** | request in flight | The trigger control is disabled and shows a busy state (`aria-busy`). Further taps on it are ignored (double-send guard, CB-10) | none |
| **Sent** | 2xx with `status:"sent"` | Inline ✓. On the Chat Board this is the flyout from the pressed tile (CB-11). The polite live region announces "Sent" | none |
| **Not sent** | 400 / 401 / 403 / 409 / 503. The server refused before sending | Inline reason. The draft is kept | The user may send again |
| **Slow down** | 429 + `Retry-After` | The countdown sits on the control ("Try again in 7 s"). **Every control on the same limiter shows it.** For `psn_send` that is all tiles, Squad Up, Rally ▶ and the composer. The copy never blames the user: the bucket is keyed on client IP and is probably squad-wide behind the tunnel (backend flag B-4) | The control re-enables at 0 and does not auto-send |
| **Unknown** | network error, client timeout (15 s; 190 s for clip re-send), **500 or 502** | "This may or may not have sent. Check the group before sending again." The draft is kept. The button becomes **Send again anyway** | Manual only |

Why 500 counts as unknown: for `/v2/send` and `/v2/squad`, a 500 covers both "PSN returned false" and "an exception after the request left". The client cannot tell them apart. For the WA rally and clip re-send, a 502 wraps bridge timeouts, and a message might still be delivered after one.

**Exception, Ask AI (F-7):** the thread is server-stored, so after a transport failure the client re-reads `GET /api/assistant/history` once. If the question is there it was accepted. If not, the draft stays. That resolves "unknown" from data instead of asking the user to guess.

### F-1 · Soundboard fire and quick-send (J2)

```
○ Squad ─▭ open Chat Board (mobile, primary: tap the "Chat" handle → ~60 % sheet + scrim · desktop: the right panel, open unless collapsed to its rail)
  ─◇ which board?  [Shared | Mine] tabs (CB-04; swipe is an accelerator)
      Mine & personal board says signed_in:false → "Sign in to build your board" (signed-out row)
  ─▭ tap a tile ─◇ tile has `path`?
        yes, path starts with /roast/ → tile is not rendered in /app (owner decision O-1)
        yes, other path → POST that path → F-0
        no → POST /v2/squad {message: tile.msg} → F-0 → Sent: flyout from the tile (CB-11), avatar = crcmz-mod (SQ-07)
  ─▭ or type in the composer ("Message the squad…", fits at 375 px) → Send → POST /v2/send {message} → F-0
        Sent → clear the draft · Unknown/Not sent → keep the draft
  ○ close the sheet (handle, scrim tap, Esc, swipe down) → focus returns to the handle
```

**Accidental-fire prevention** (instead of a confirm). A group message cannot be unsent, and interaction doctrine lists sending as a destructive action. A confirm would break the one-tap job (J2), so accidents are prevented by the design of the target itself (Nielsen #5):
- A tile fires on pointer-up inside the tile. A scroll or drag that starts on a tile cancels the fire.
- Tiles are ≥ 64 px with ≥ 8 px gaps (Fitts).
- Tiles **never fire in Edit or Organize mode**.
- The flyout names the message, so a wrong fire is noticed straight away.

**Sub-flows:**
- **Add (CB-05).** "+ Custom" opens a dialog: text (≤ 200 characters, counter), target = current tab, and "Also send it now" (default on; legacy `send:true`). The request is `POST /api/soundboard` or `POST /api/soundboard/personal` `{text, send}`, followed by "AI is cooking…". The response returns `button`, `flavored` and `sent`. If `sent` is true, show the Sent outcome for the send part. Error: 400 means full (24 custom max), too long or empty. A 429 comes from `custom_add` (6/min) or `psn_send`.
- **Remove (CB-06).** Edit toggle → ✕ on custom tiles only → confirm naming the tile. On Shared the confirm adds "Everyone loses it." The request is `POST /api/soundboard/delete` or `POST /api/soundboard/personal/delete` `{text}`, then the board re-fetches.
- **Organize (CB-07).** Organize → each tile shows a drag handle plus **Move earlier / Move later** → Done. Mine saves with `POST /api/soundboard/personal/order {labels}`. The shared order is per device (local).

### F-2 · Squad Up (J1 → J2)

```
○ Squad ─▭ GET /api/squad (30 s) ─◇ ≥ 2 members with playing:true on the same `game`?
     no → the "Playing together" card is absent (no empty card; the live count says "Nobody in a game right now")
     yes → card "🔥 3 in <game> — A, B, C" + [Rally ▶]
  ─▭ Rally ▶ → POST /v2/squad {message: "🔥 3 in <game>…"} → F-0
  ─▭ or the "Squad Up" / "Game Time" tile (SQ-06) → same as F-1
  ○ Sent → flyout. The PSN group receives it as crcmz-mod
```

Rally ▶ is one tap for the same reason as F-1. The message text is the button's accessible description, so screen-reader users hear what will be posted before they activate it.

### F-3 · Clip review and playback (J3)

```
○ Clips (tab bar) | deep link /app/clips/{id}/edit | push from the PSN group
  ─▭ GET /api/reels ─◇ needs_psn_link → "Link your PlayStation account" → Portal (CL-11)
                    ─◇ clips = [] → empty: "Post a clip in the PSN group, then ↻ Sync" (POST /api/reels/sync)
  ─▭ filter chips (All · Needs review · Rendered · Vetoed) → tap a reel
  ─▭ Studio /app/clips/{id}/edit: GET /api/reels/clips/{id} + stream GET /api/reels/clips/{id}/source
      ─▭ edit: Trim · Crop · Zoom · Text · Subs (each drag has a button equivalent)
      ─◇ preview the render?  ⚙ Render → POST …/render → poll GET /api/reels/renders/{rid} every 2 s → done: Render view (GET …/video) | failed: inline error + Render again
      ─▭ ✅ Save & approve → validate (end > start) → POST …/override
            ⚠ 409 "duplicate of one already posted" → explain; the edit cannot publish (pipeline state twin_of_posted)
      ─▭ 🛑 Veto (POST/DELETE …/veto) · 🚀 Force post (POST …/force-post {force})
      ○ close (Back / Esc / ✕) ─◇ unsaved changes? → "Leave without saving?" [Keep editing | Discard]
  ─▭ All clips (catalogue) → GET /clips?month&sender&status (Accept: application/json) → tap a row
      ─▭ detail GET /clips/{uid} (uid URL-encoded; it contains '#') → player src GET /api/clips/media?uid=  (session cookie: assumed change B-1)
          ◇ 410 → purged: metadata stays, the player is replaced by "Media cleared after the 14-day retention" (no play control)
          ◇ 404 / 409 / 503 → error with reason
      ─◇ admin? → [Re-send to WhatsApp] → confirm naming the clip:
            "Re-send <sender>'s clip from <date> (<duration> s) to the Goopers group? It posts again even if it was delivered before."
            → POST /api/clips/{uid}/resend → F-0 (409 not archived · 410 missing from store · 503 no bridge · 502 → Unknown)
            Server-side admin gate = assumed change B-3. Non-admins never see the control.
```

### F-4 · Watch join (J5)

```
○ Watch (tab bar) | call mini-bar | legacy /watch link (unchanged, goes to /?p=watch)
  ─▭ GET /api/watch/config → { rooms, defaultRoom, origin, socketPath, viewer{name,nickname,mod} }   ⚠ 401 → signed-out
  ─▭ load socket.io.js from cfg.origin   ⚠ fail → "Watch Party server unreachable" + Retry
  ─▭ POST /api/watch/join {roomId} → { ticket, expiresIn, room, viewer{mod} }
        ⚠ 403 "link your PSN account to join" → forbidden → Portal
        ⚠ 429 → wait Retry-After, then reconnect automatically (joining is idempotent; this is not a send)
        ⚠ 503 "watch party not configured" → error
  ─▭ socket connect → presence "live" → stage:
        ◇ nothing playing → "Nothing playing yet" + URL field focused
        ◇ autoplay blocked → one "Start playback" button (WP-03)
  ─◇ set a video? URL + title → Play → YouTube or a direct file goes straight to the room; otherwise POST /api/watch/extract {url}
        ⚠ 400 (not a URL / a Drive folder) · 422 "could not extract" · 429 (5/min) countdown on Play
  ─◇ join the call? [Join with camera + mic] → permission prompt
        ◇ denied → mic-only fallback, or "Camera and mic blocked — you can still watch"
        → in-call: orbs, Live/Muted, camera, flip, Leave
  ─▭ 📣 Rally → an editable preview prefilled "@all A, B are on CRCMZ app watching <title>… /watch" → Send → POST /api/watch/rally {message} → F-0 (503 not configured)
  ─▭ navigate elsewhere → the shell keeps the socket and WebRTC alive → call mini-bar (PS-0)
  ○ Leave call (no confirm: rejoining is one tap) · kicked by a moderator → back to the pre-join view with "A moderator removed you from the party"
```

A ticket expiring during a session re-mints silently through `POST /api/watch/join`, within the 30/min limit.

### F-5 · Huddle join (J5)

```
○ Huddle (More) | call mini-bar
  ─▭ pre-join: local camera preview (getUserMedia) + room (default "crcmz") + mic/camera selects
        ◇ permission denied → camera-off preview + "Allow camera and mic in your browser settings" + [Join without camera]
  ─▭ 🎥 Join → POST /api/huddle/token {room} → { token, url, room }   ⚠ 401 · 503 "Huddle not configured"
  ─▭ load the LiveKit client (CDN) + connect(url, token)   ⚠ CDN or WebSocket failure → error + Retry
  ─▭ in-call: spotlight/grid, mic, camera, screen share, blur, AI panel (POST /api/huddle/ai), transcript (POST /api/huddle/transcribe), notes
        ◇ LiveKit "reconnecting" → stale overlay "Reconnecting…", controls disabled, the call is kept
  ─▭ navigate elsewhere → the shell keeps the room connected → mini-bar
  ○ 🔴 Leave → disconnect → back to pre-join
```

**Two calls at once** (Watch plus Huddle) is allowed, and the mini-bar shows one row per call. Joining the second call with a live mic **auto-mutes the first call's mic**, with a toast "Muted your Watch mic while you're in Huddle". This changes only the user's own local state.

### F-6 · Giveaway lifecycle (J9)

```
state:  (none) → draft → open → [locked] → drawn → revealed → closed
member view:
  none      → "No giveaway right now" (admins: [Start a giveaway])
  draft     → members never see drafts (GET /api/giveaway returns it, but the member view renders "none")
  open/locked → title, prize, reveal date + countdown, eligibility (✅ in the draw / 🏆 won this cycle / ⏸ not in this draw), rotation progress
  drawn     → "Winner reveal in …". Never render `active_draw` or `draws[]` for members (backend flag B-5: `draws[]` still carries winner_name)
  revealed  → 🏆 winner + 🎁 prize; confetti once per giveaway id (not with reduced motion)
  closed    → drops into Past winners
countdown hits 0 → **re-fetch only** (5 s, 15 s, 60 s, then every 60 s until the status changes) and show "The reveal is on its way"
                   the reveal comes from the idempotent backend auto-reveal job (assumed change B-2), never from rendering
admin actions (Giveaway → Admin tools, role-gated):
  create    → POST /api/giveaway {title, prize, reveal_at} → POST /api/giveaway/{id}/publish
              ⚠ create succeeds, publish fails → it stays a draft with a visible [Publish]; no silent retry
  edit      → PUT /api/giveaway/{id}
  entries   → add from the rotation list POST …/entries {member_id, display_name} · remove (confirm naming the member) DELETE …/entries/{member_id}
  open/locked → [Draw & reveal now] confirm "Draw a winner from N entries and show everyone now?" → POST …/draw-and-reveal
  drawn     → [Reveal now] (same endpoint; it only reveals) · [Disqualify & redraw] → dialog with a reason (required) naming the current winner → POST …/redraw {reason}
  revealed  → [Close] confirm → POST …/close
  danger zone → Reset & seed: type the winner's name to confirm → POST /api/giveaway/admin/reset-and-seed {winner_query, title?, prize?}
              ⚠ 404 no_match → shows all_members to pick from · 409 ambiguous → shows matches to pick from
```

**Fairness** (carried to Phase 5): member copy states the rule plainly (one win per rotation cycle). No urgency or scarcity pressure, and no shaming for "not in this draw".

### F-7 · Ask AI (J8)

**Goal contract** (ai-native §C). This guidance is principle-derived: Dibia's agent-UX principles and Smashing 2024. **There is no settled canon; weight it accordingly.**
- The assistant **only reads** squad data through tools (AI-07). It never sends, posts or changes anything.
- Answers land in *your* server-stored thread.
- Squad facts are *shared* and feed everyone's answers.

```
○ Ask AI (More) ─▭ GET /api/assistant/tools → { available, model, tools[] }
      ◇ available false → composer disabled with the reason + exits to the deterministic pages (Squad, WhatsApp, Slap)
  ─▭ GET /api/assistant/history → { messages[]{id, role, content, status, tools, elapsed_ms, created_at}, pending, count }
      ◇ pending → "thinking… Ns" + poll every 2 s (paused while hidden; re-fetch on return)
  ─▭ ask: a chip (fills the composer and sends it: a fixed control for a known intent, ai-native §E.3)
          or type (≤ 1000 characters, counter) + optional image (≤ 4 MB, thumbnail, remove)
      → POST /api/assistant/ask {question, image_b64?, image_type?} → 202 {status:"queued", reply_id}
      → the question bubble shows at once → the pending bubble polls history every 2 s
      ◇ done → answer + "Used: <tools> · 12.3 s" (makes the agent inspectable, ai-native §C.2)
      ◇ status "error" → "Couldn't get an answer" + [Ask again] (puts the question back in the composer; the user sends)
      ⚠ 409 still working · 429 (10/min) Retry-After · 400 empty/too long · 503 not configured
      ⚠ network → re-read the history once (F-0 exception) before saying "may not have been sent"
  ─▭ 🗑 Clear chat → confirm "Clear your chat? Squad facts stay." → POST /api/assistant/clear
  ─▭ 🧠 Facts (the grounding panel: what the AI knows) → add {subject (suggestions from `subjects`), text ≤ max_chars} → POST /api/assistant/facts
      ⚠ 400 (limit max_per_user, length) · 429 (12/min) · delete own → confirm → POST /api/assistant/facts/delete {id} (404 = "not yours or already gone")
  ○ exit: any nav item. The answer keeps generating server-side and is there when you come back
```

### F-8 · Portal link (J10)

```
○ "Link PSN" (nav) | Squad empty | Clips needs-link | upload 403 | Watch join 403 | Settings → PSN (Link / Re-link / expired)
  ─▭ GET /auth/settings/psn
      ◇ linked & token_ok → "Linked as <online_id> since <linked_at>" + [Re-link] (goes to step 1)
      ◇ not linked & unclaimed[] non-empty → Step 0 "Is one of these you?" → [This is mine] → confirm naming online_id → POST /auth/settings/psn/claim {key}
            ⚠ 404 already claimed → refresh the list · ✓ → success
      ◇ otherwise → Step 1
  ─▭ ① Sign in to PlayStation (opens playstation.com in a **new tab**, so a call survives) → [I'm signed in] unlocks ②
  ─▭ ② Open the token page (ca.account.sony.com/api/v1/ssocookie, new tab) → copy the `npsso` value → [Got it] unlocks ③
  ─▭ ③ Paste (textarea + 📋 Paste from clipboard; ⚠ clipboard denied → "Long-press and paste") → 🔗 Link
      → POST /api/psn/link {npsso}
      ⚠ 400 {error} / 500 "Try a fresh token" → stay on ③, show the error (PO-04), keep the value, link back to ②
      ✓ {ok, online_id} → PO-03 "You're all set, <online_id>" → [See the Squad] (/app) · [Link a different account] (back to ①, warns it replaces the current link)
```

Steps unlock in order; they are not hidden (Nielsen #6). Each step can be reopened.

---

## §Page specs

### Shared state vocabulary

Every page spec below has a row for each of the nine states. Where a row says "default", the behavior below applies. Otherwise the row gives the page-specific trigger and behavior, or **N/A** with the reason the state cannot occur.

| State | Default trigger | Default behavior |
|---|---|---|
| **loading** | The first fetch for a panel is in flight | A skeleton matching the panel's layout (interaction doctrine: skeleton over spinner). The shell and nav stay usable. After 10 s: "Still loading…" + Retry |
| **empty** | 2xx with zero items | Say what will appear here, plus the next action (interaction pattern 3). Never a bare "No items" |
| **error** | non-2xx other than 401/403/410/429, or a network failure on first load | Per-panel G-07 pattern: what failed + Retry (clears the load guard). **Panels fail independently**; one failing never blanks the page |
| **stale** | A poll fails after a success, or no success within 2× its cadence | Keep the last good data. The panel header shows "Updated 2 min ago · Retry". It clears on the next success. Polls pause while `document.hidden` and fetch at once when the page is visible again |
| **429** | `Retry-After` from `_rate_limit` (the only source of 429 in `server.py`) | The affected control is disabled with a countdown. It re-enables at 0. **No auto-send** (F-0) |
| **signed-out** | Document load with no session → the server sends a 302 to `/auth/login?next=<path>` (`_auth_gate`). In a session: any API returns 401 | Mid-session: a non-blocking banner "You're signed out · Sign in" linking `/auth/login?next=<current>`. Drafts are kept locally and polls stop. Nothing is wiped |
| **forbidden** | 403, or a role check returns false | Explain why and route to the fix (Portal for a PSN link; "Admins only" for role). Admin-only controls are **hidden, not disabled**, for non-admins |
| **410-purged** | Only clip media (`/api/clips/media`, clip re-send) | See PS-2 |
| **in-call** | Watch socket connected or Huddle room connected (PS-0) | The mini-bar shows on every route except that call's own page |

**Backend flags** (referenced as B-n):

| # | Change | Status |
|---|---|---|
| B-1 | Session-cookie access to `GET /api/clips/media?uid=` | **Assumed** (plan) |
| B-2 | Idempotent giveaway auto-reveal job | **Assumed** (plan) |
| B-3 | Server-side admin gate on `POST /api/clips/{uid}/resend` | **Assumed** (plan, owner O-2) |
| B-4 | `psn_send` limiter is keyed on `client.host`, which is shared behind the tunnel. Key it on the session `sub` | Recommended |
| B-5 | Strip `draws[]` (winner_name) from `/api/giveaway` for non-admins while `drawn` | Recommended (spoiler leak) |
| B-6 | `/v2/send` should return `as: "user" \| "server"` (it silently falls back to crcmz-mod) | Recommended |
| B-7 | `/api/hype` should flag errors (today it returns a fake `cold/0`) | Recommended |
| B-8 | Admin gate on `/status`, `/api/video-jobs`, `/api/pipeline-status .services` (today readable by any member) | Recommended |
| B-9 | `GET /auth/settings/passkeys` should return an error on upstream failure (today it returns `[]`, which looks empty) | Recommended |

### Device rules (brief §Device priority, amended 2026-09-30)

**Mobile first. When mobile and desktop needs conflict, mobile wins.** These rules apply to every page spec below:
- **`**Mobile 375 (primary):**`** is the design. It comes first in every spec.
- **`**Desktop 1280 (reflow):**`** is the default. It is the PS-0 sidebar plus the *same* mobile components in the *same* order, reflowed into columns or grids. Each spec states its reflow rule in one to three lines. Sheets can become side sheets or centred dialogs with the same content. There is no second design.
- **`**Desktop 1280 (bespoke):**`** is allowed for three jobs only, because they are painful on a phone:
  - the Clips Studio editor (PS-2)
  - WhatsApp stats, export and import (PS-4)
  - Giveaway admin (PS-5)

  Each of these also states a **`**Mobile fallback:**`**, so the phone can still do the job.
- **Nothing relies on hover.** Nothing is revealed, explained or activated only on pointer-over. Tooltips are never the only label. Mouse-only gestures (double-click, right-click) are never the only path.
- **Keys are accelerators, never the only path.** Every key has a visible button. There are no soundboard hotkeys. Normal keyboard a11y stays everywhere: focus order, Enter to submit, Esc to close, arrow keys in tab lists.
- **Capability, not device class.** Where behaviour differs, it is gated on feature detection, for example `getDisplayMedia` or a settable media `volume`. It is never gated on width, hover or user-agent.
- **No multi-pane "second screen" layouts.** A desktop page may place mobile blocks side by side. It does not add panes the phone lacks.

---

### PS-0 · App shell (global; not a destination)

**Purpose:** Orientation, navigation and cross-route status. **Rows:** G-01, G-02, G-03, G-04, G-05, G-06, G-07, G-08, G-09, HU-08, AD-01, ST-01.

**Architecture constraint (code plan).** The Watch Party socket, its WebRTC peers and the LiveKit room are **owned by the shell, not by a page**. A route change must never unmount them; that is what lets the mini-bar persist. A full document navigation ends a call. Examples: sign-out, legacy `/portal`, `/auth/login`. So while `in-call`, those navigations confirm first ("Signing out ends your call"). External links (PlayStation, Sony, Slap "Full dashboard") open in a new tab.

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/admin/check` | At boot, and on focus if older than 5 min (the server caches for 5 min) | `admin` | Returns `{admin:false}` without a session |
| `GET /api/squad` | 30 s, one shared store with PS-1, runs on all routes while visible | `squad[].playing`, used for the Squad nav badge count (G-05) | 500 / `error`: the badge hides (no stale number) |
| `GET /auth/logout` | Account menu → Sign out | 302 → `/auth/login` | none |

**Mobile 375 (primary):** below 1024 px, designed at 375 × 800. This is the product (brief §Device priority).
- A 48 px top bar: logo and wordmark (G-01) and the account avatar (G-04: name, Settings, Sign out).
- The bottom tab bar is 56 px, `aria-label="Tab bar"`. It holds Squad · Watch · Clips · More.
- The More sheet has a scrim.
- The call mini-bar docks directly above the tab bar, 48 px per call row. **On Squad it merges into the Chat handle row** (see PS-1) to hold the 12 % budget.

**Desktop 1280 (reflow):** at ≥ 1024 px, the top bar and tab bar become a persistent 240 px sidebar: `aria-label="Primary"`, rows ≥ 44 px, `aria-current="page"`, the footer group Link PSN · Settings · Admin*, and the mini-bar above the account row.
The content is fluid; reading-width pages (Ask AI, Settings, Portal) cap at ~760 px. This is the **default desktop treatment for every page**, and nothing in the shell relies on hover.

**Call mini-bar (G-08, HU-08).** One row per active call:
- An icon and label: "Watch Party · A, B +2", or "Huddle · crcmz · 3".
- 🎤 Live/Muted toggle (≥ 44 px)
- **Return**, which routes to the call page
- **Leave**

It is an `aria-label`ed region, `role="region"`. Status changes are announced politely.

**Other shell elements:**
- **Toast / live region (G-06).** One polite `aria-live` region. Toasts show for ≥ 2 s, 4 s for errors.
- **Legacy URL map (G-03).** `/app?p=<key>` is replaced (`replaceState`) with the mapped route (§IA). An unknown key goes to `/app`.
- **Aurora (G-09).** Decorative, `aria-hidden`. Reduced motion stops the drift (Phase 3).

| State | Behavior |
|---|---|
| loading | The shell renders at once from static assets. The badge and the Admin item appear when their data lands (no layout shift: the Admin row space is only reserved after `admin:true`) |
| empty | N/A: the shell has no list content. The badge hides when the count is 0 |
| error | `/api/admin/check` failure → treated as non-admin (fail closed). Squad store failure → the badge hides |
| stale | The badge hides if the squad store is stale (a wrong live count is worse than none) |
| 429 | N/A: no shell endpoint is rate-limited |
| signed-out | Default. The account row shows "Sign in" |
| forbidden | Admin nav is hidden for non-admins. A direct `/app/admin` renders PS-11's forbidden state |
| 410-purged | N/A: no media in the shell |
| in-call | The mini-bar shows (rules above). A full document navigation confirms first |

---

### PS-1 · Squad (`/app`)

**Purpose:** See who's on and rally the squad in one tap (J1, J2). **Entry:** default route, tab bar, sidebar, Portal success. **Primary CTA:** a Chat Board tile / Rally ▶. **Exit:** any destination; the Chat Board sheet.
**Rows:** G-05, SQ-01, SQ-02, SQ-03, SQ-04, SQ-05, SQ-06, SQ-07, CB-01, CB-02, CB-03, CB-04, CB-05, CB-06, CB-07, CB-08, CB-09, CB-10, CB-11. Flows: F-1, F-2.

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/squad` | 30 s (shared store, PS-0). The server's PSN cache TTL is 55 s, so identical responses are normal, not stale | `squad[]`: `online_id`, `mm_username`, `avatar`, `online`, `playing`, `game`, `game_icon`, `recent_game`, `recent_game_icon`, `last_online`, `platform`, `trophy_level`, `trophy_progress`, `trophy_tier`, `trophy_total`, `platinum`, `gold`, `silver`, `bronze`, `has_stats`, `linked`; top-level `error` | 200 + `error:"auth unavailable"`, or 500 → presence error |
| `GET /api/hype` | 60 s | `count`, `pct`, `label`, `level` (dead · cold · warm · hot · fire · overload). Scale: 150 msgs = 100 %; thresholds 15 / 40 / 80 / 120 | Errors look like `cold/0` (B-7) |
| `GET /api/soundboard` | On load, and after add/remove | `buttons[]`: `label`, `msg`, `cls` (c1–c5), `custom`, `path?` | error → board error |
| `GET /api/soundboard/personal` | On load, on the Mine tab, after changes | `buttons[]` (+`mine`), `signed_in` | none (`signed_in:false`) |
| `POST /v2/squad` `{message}` | Tile fire, Rally ▶, Squad Up | `status`, `message` | 429 (psn_send 8/60 s) · 503 · 500 → F-0 |
| `POST /v2/send` `{message}` | Composer | `status` | 400 empty · 429 · 503 · 500 → F-0 |
| `POST /api/soundboard` / `POST /api/soundboard/personal` `{text, send}` | Add tile | `button`, `flavored`, `sent` | 400 (empty, > 200, 24 max) · 401 (personal) · 429 (custom_add 6/60 s, psn_send) |
| `POST /api/soundboard/delete` / `POST /api/soundboard/personal/delete` `{text}` | Remove | `removed` | 401 (personal) |
| `POST /api/soundboard/personal/order` `{labels}` | Organize → Done (Mine) | `buttons` | 401 |

**Mobile 375 (primary):** at 375 × 800, in order:
1. Top bar (PS-0), 48 px.
2. `h1` "Squad" + live count "3 in a game right now" (G-05).
3. **A compact strip ≤ 64 px:**
   - The hype mini-meter: label, "137 / 150", a bar with ticks at 15/40/80/120, and an end label "150 = max" (carry-over: scale visible).
   - Three stat chips: Plats · Top level · Fav game (SQ-03).
4. "Playing together" card (SQ-01), only when a group of 2 or more exists, with Rally ▶.
5. **Who's on** (SQ-04), the primary content, with ≥ 5 rows visible above the fold. Each row has:
   - avatar, name, `@mm_username`
   - status as text + dot, never colour alone: "On <game>" / "Online" / "Last: <recent_game>"
   - the game icon
   - Offline rows are dimmed and players float to the top.
6. Ranks (SQ-05): medal/#n, level, plat/gold/silver/bronze, relative bar.

**The bottom chrome is fixed at 96 px = 12 % of 800** (mock-review Major):
- A 40 px **handle row**. It holds a grab handle, the "Chat" trigger (CB-08), and the call chip (● Huddle 3 · 🎤) during a call.
- The 56 px tab bar.

Tapping the handle opens the **sheet** at ~60 % height with a **scrim** (carry-over). The sheet can expand to full height (CB-09). The page behind is `inert`, and focus is trapped inside the sheet. Sheet contents:
- **Header:** title, Shared / Mine tabs (`role=tablist`, CB-04, CB-03), Edit (CB-06), Organize (CB-07), and Close.
- **Tile grid:** 2 columns (3 at ≥ 400 px), tiles ≥ 64 px, each a distinct neon class plus a text label. Hue alone never tells tiles apart. The last tile is "+ Custom" (CB-05).
- **Composer (CB-10), pinned to the sheet bottom and shown only when the sheet is open:** a visible label "Quick message", the placeholder "Message the squad…", and Send ≥ 44 px. It is a single line, and Enter sends (a11y, same on every device).
- A note under the composer when not PSN-linked: "Sends as crcmz-mod until you link PSN" (B-6).

**Desktop 1280 (reflow):** the sheet becomes the locked **Chat Board right panel** (360 px, same header, tiles and composer; CB-08 collapses it to a labelled rail, CB-09 widens it). No scrim or `inert`, because nothing is covered.
Main keeps the mobile order. The compact strip widens to one row (full hype meter + 3 stat tiles). Who's on and Ranks sit side by side when main is ≥ 880 px wide, otherwise stacked. Rows use the same component, with platform and trophy level shown inline.

| State | Behavior |
|---|---|
| loading | Skeleton: 7 presence rows, a strip of tiles and 8 tile placeholders. The Chat Board loads independently of presence |
| empty | `squad:[]` → "Nobody linked yet" + [Link your account] → Portal (SQ-04). Nobody playing → the list shows everyone offline, the together card is absent, and the count reads "Nobody in a game right now". Mine board empty → "Your own tiles live here. They still fire into the group." + [+ Custom] |
| error | Presence: 500, or `error` present → "PSN isn't answering" + Retry. The board stays usable. Board load failure → board-panel error + Retry. Hype errors are not detectable (B-7) and show as cold |
| stale | Presence / hype poll failure after a success → "Updated N min ago" on the panel header. The live count and badge hide while stale |
| 429 | `psn_send`: a shared countdown on **every** tile, Rally ▶ and composer Send. `custom_add`: a countdown on the add dialog's Save. Copy is neutral: the limit may be shared squad-wide (B-4) |
| signed-out | Default banner. The draft is kept. The Mine tab shows "Sign in to build it" (`signed_in:false`). Firing a tile on a 401 → Not sent |
| forbidden | N/A: no Squad or soundboard route returns 403 (the personal board uses 401) |
| 410-purged | N/A: Squad shows no clip media |
| in-call | Mobile: the call chip rides in the handle row (no extra bar, the 12 % budget holds). Desktop: the sidebar mini-bar. Tiles and the composer work during a call |

---

### PS-2 · Clips (`/app/clips`, `?upload`, `/app/clips/{id}/edit`)

**Purpose:** Relive and polish clips, send videos to socials, and track the monthly montage (J3, J4). **Entry:** tab bar; `?upload` deep link; the PSN group. **Primary CTA:** review a reel / 📤 Send a video. **Exit:** Studio → back to Clips; Portal (needs link).
**Rows:** CL-01, CL-02, CL-03, CL-04, CL-05, CL-07, CL-08, CL-09, CL-10, CL-11, CL-12, CL-13, CL-14, CL-15, CL-16, CL-17, CL-18, CL-19, CL-20, CL-21, CL-22, CL-23, CL-24, CL-25, CL-26, CL-27, CL-28, CL-29, CL-30, CL-31. (CL-06 and CL-32 moved to PS-11.) Flow: F-3.

**Local navigation:** `Overview` (upload · reels · this month) and `All clips` (the catalogue), as `role=tablist`. The Studio is an overlay route.

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/pipeline-status` | 30 s while Overview is visible | `clips_this_month`, `last_clip_at`, `last_clip_sender`, `next_build_ts`, `next_build_label`, `next_build_month`, `last_montage{version, year, month, clips, duration, sent}`, `clips[]{uid, sender, duration, at, included, reason}`. (`services` is not read here → PS-11) | error → month panel error |
| `GET /api/reels` (`?all=true` admin) | On load, focus, after Sync. No poll | `me{psn_id, display_name, admin}`, `scope`, `clips[]` (+`pipeline` state, `vetoed`), `source`, `roster`, `needs_psn_link` | 401 · 502 "reel review is unreachable" · 503 not configured |
| `GET /api/reels/clips/{id}/frame?t=` | Thumbnails, lazy in the viewport; filmstrip | image | 404 → placeholder |
| `POST /api/reels/sync` | ↻ Sync | upstream result | 502 |
| `GET /api/reels/clips/{id}` · `GET /api/reels/clips/{id}/source` | Studio open | clip detail + `pipeline`; video stream (Range) | 404 not yours / not found |
| `POST /api/reels/clips/{id}/render` → `GET /api/reels/renders/{rid}` | Render; poll 2 s until done/failed | render `status`, `rid` | 409 · 502 |
| `GET /api/reels/renders/{rid}/video` · `GET /api/reels/renders/{rid}/trajectory` | Render view; AI crop path | stream; trajectory points | 404 |
| `POST /api/reels/clips/{id}/override` | ✅ Save & approve | ok + updated pipeline | 409 twin_of_posted |
| `POST /api/reels/clips/{id}/force-post` `{force}` · `POST`/`DELETE /api/reels/clips/{id}/veto` | Toggles | ok | 409 |
| `GET /api/video-uploads/mine` | On load, after each upload action | `psn_id`, `uploads[]{video_post_id, status, caption, filename, uploaded_at, posted_at, skip_reason, duration_seconds, file_size_bytes, platforms{instagram\|tiktok\|youtube: {url}\|null}}`, `can_upload`, `open_session`, `limits{max_bytes, max_seconds, min_seconds, max_caption, formats}` | 401 · 403 link PSN |
| `POST /api/video-uploads/start` → `PUT /api/video-uploads/chunk?id=&offset=` (8 MB) → `POST /api/video-uploads/finish` | Send a video (resumable; SHA-256 `file_key`) | session id/offset; `upload` | 409 `already_queued`/`duplicate`/`offset`/`posting`/`posted` · 413 chunk · 404 no_session · 503 storage |
| `POST /api/video-uploads/withdraw` `{video_post_id}` | Withdraw (queued, no links) | `upload` | 404 · 409 |
| `GET /clips?month=&sender=&status=&montage_eligible=&limit=50&offset=` (Accept: application/json) | All clips, on filter change + Load more | `clips[]{message_uid, sender_online_id, psn_created_at, duration_seconds, width, height, file_size, status, archive_status, whatsapp_delivered_at, montage_eligible}`, `count` | error |
| `GET /clips/{uid}` (uid URL-encoded) | Clip detail | the full row (+`body`, `last_error`) | 404 |
| `GET /api/clips/media?uid=` | Player `src` + poster (`preload="metadata"`, lazy) | MP4 (Range) | **410 purged** · 404 · 409 · 503 · 401 until B-1 |
| `POST /api/clips/{uid}/resend` | Admin, after the confirm (F-3) | `status`, `caption` | 404 · 409 · 410 · 503 · 502 → F-0 |

**Mobile 375 (primary):**
1. Summary bar (CL-01): "📅 September · 23 clips · build in 3d 4h" plus [📤 Send a video]. The upload progress pill shows here: "Uploading 42 %", "Queued ✓", "Paused — tap to resume".
2. Local tabs.
3. The Overview sections fold, and the open/closed state persists (CL-02):
   - **My reels** (CL-07–11): scope toggle (admin, CL-09), ↻ Sync, filter chips with counts (CL-08), and one reel card per row (thumbnail, sender/game, duration, age, badges). Show more after 12.
   - **This month** (CL-03), **Montage** (CL-04) and **Clips this month** (CL-05).
   - **Your uploads** (CL-27).
4. **Send a video** is a bottom sheet (`?upload`, CL-26), the same as legacy.
5. **All clips:** filters (month · sender · status) sit in a sticky row. A list of rows opens a detail sheet with the player (CL-31) and metadata (CL-29). Re-send shows for admins only (CL-30).
6. **Studio** (CL-12–25): see the Studio block below. On a phone it is the mobile fallback for the one bespoke desktop job on this page.

**Desktop 1280 (reflow):** Overview's folding sections become 3 columns (upload + Your uploads · reels · This month / Montage / Clips this month), as main ships today. The reels grid auto-fills cards ≥ 280 px (2 at 1280, 3 at ≥ 1440). Show more comes after 24.
All clips keeps the mobile row list, with its columns inline. Its detail sheet becomes a centred dialog (max 760 px) with the same player, metadata and admin re-send. There is no side pane.

**Studio (CL-12–25), `/app/clips/{id}/edit`.** This is a full-viewport overlay on both layouts. It is specified from the shipped `_DASHBOARD_TMPL` editor (main `2c7c2a6`: `buildStudio`, `.rrs-*`, `onKey`). The shipped breakpoint is 960 px; `/app` aligns it to the shell's 1024 (Phase 3 owns final values). The tab bar is hidden and the call mini-bar collapses to a chip in the Studio top bar.

**Mobile fallback:** this is the shipped phone editor. The whole job (trim, crop, zoom, text, subs, render, save, veto, force post) works on a phone:
- **Top bar:** ✕ close · title (sender · duration / age · game · message) · 🛑 Veto (CL-24) · ⚙ Render · 🚀 Force post (when allowed, CL-23) · ✅ Save (CL-22). The pipeline strip sits under it (CL-25).
- **Stage:**
  - It is as large as possible, because no tool panel is open at first.
  - The view buttons ✨ Live / 🎬 Render / 🖼 Frame are stacked on the left edge. 🔊 mute and ⬇ download are on the right edge (CL-13).
  - In Zoom, tap the preview to aim (CL-18).
- **Transport** (CL-14): −1 s · −0.1 · ▶/⏸ · +0.1 · +1 s · time. The ±1 s pair is **new**: the shipped build had it only on Shift+←/→.
- **Timeline** (CL-15): four lanes (trim window over the filmstrip with handles, 🔍 zoom, 💬 subs, seconds ruler) and the playhead. Tap to seek. Every drag has a button: Start here / End here, zoom and subs start/end, and the crop X-slider + ◀ ▶ nudge (CL-17).
- **Tool tabs:** a bottom strip (Trim · Crop · Zoom · Text · Subs). A tab opens its panel above the strip (≤ ~⅓ of the height, scrolls), and tapping the active tab closes it again (shipped behaviour).

**Desktop 1280 (bespoke) · Studio editor:** a precision job (Fitts 1954: frame-accurate trim targets are small, and a large pointer surface helps).
- **Two columns:**
  - left, fluid: stage (views left, mute/download right), transport and a full-width timeline with taller lanes
  - right: a 400 px tool card, with pill tabs at the top, a panel title, the panel filling the height, and a pinned action row ⚙ Render · ✅ Save & approve · 🚀 Force post
- The top bar keeps ✕, the title and 🛑 Veto. Its Render and Save buttons move into the action row.
- **Trim is open by default**, and tapping the active tab does not collapse the card.
- **Keys** (CL-14): Space play · ←/→ 0.1 s (Shift 1 s) · I start here · O end here · A whole clip · Esc close. They are ignored while an input has focus.
  - They are **accelerators only**, and each maps to a visible button above.
  - A "Keys" disclosure in the tool card lists them. It is not an always-on legend, and it is available on phones with keyboards too.

| State | Behavior |
|---|---|
| loading | A skeleton for each section. The Studio shows the filmstrip skeleton plus "Loading clip…". Render in progress: "Rendering your reel… Ns" (CL-21) |
| empty | Reels `[]` → "Post a clip in the PSN group, then ↻ Sync". Month 0 → "No clips yet this month. The montage builds <next_build_label>". Uploads `[]` → "Nothing sent yet" + [Send a video]. Catalogue filter with no rows → "No clips match" + [Clear filters] |
| error | Per section: reels 502/503 ("Reel review is unreachable") + Retry. Render failed → inline + [Render again]. Upload errors: 409 codes explained in words ("You already have one in the queue"; "This exact video was already sent"); 503 storage → Retry; pause after 8 failed chunks (CL-26) |
| stale | Pipeline status poll failure → "Updated N min ago" on This month; the countdown keeps ticking from the last `next_build_ts`. Reels/catalogue have no poll: they refresh on focus |
| 429 | N/A: no Clips, reels, upload or catalogue route calls `_rate_limit` |
| signed-out | Default. **An upload in progress keeps its file key and offset for 24 h**, so after sign-in it offers "Resume upload" (`open_session`). Studio edits are kept in memory, and the "Leave without saving?" guard still applies |
| forbidden | Reels `needs_psn_link` or upload 403 → "Link your PlayStation account" → Portal (CL-11, CL-28). Re-send is hidden for non-admins. If the server gate (B-3) returns 403 → "Admins only" and the control is removed |
| 410-purged | `/api/clips/media` 410 → the player area is replaced by "Media cleared after the 14-day retention" + metadata (sender, date, duration, montage status). No play or download control. Re-send 410 → "The archived clip is gone from storage", so re-send is disabled with that reason. A reels `source` 404 → "Video unavailable" |
| in-call | Clip and reel players start **muted** while in a call, with a visible unmute. The mini-bar shows (a chip in the Studio) |

---

### PS-3 · Slap (`/app/slap`)

**Purpose:** The squad's music receipts: leaderboards, taste and vibes (J6). **Entry:** More / sidebar. **Primary CTA:** Taste DNA compare. **Exit:** "Full dashboard ↗" (new tab).
**Rows:** SL-01, SL-02, SL-03, SL-04, SL-05, SL-06, SL-07, SL-08, SL-09, SL-10, SL-11, SL-12, SL-13, SL-14, SL-15, SL-16, SL-17, SL-18, SL-19, SL-20. Charts are specified in Phase 6.

**Endpoint contract.** The base is `SLAP = https://slap.qureshi.io/api/v1/dashboard`: external, CORS `*`, no auth. It is loaded on page open with no poll; a manual ↻ refreshes every section. The AI sections (vibe, digest, recommendations, taste DNA) are slow and load **lazily when scrolled into view**.

| Call | Fields consumed (live-verified 2026-09-30) |
|---|---|
| `SLAP GET /stats` | `total_songs`, `total_contributors`, `top_artist`, `this_week_additions` (+`total_artists`, `most_active_day`, `peak_hour`, `longest_streak_user`, `longest_streak_days`) |
| `SLAP GET /ai/vibe-check` | `vibe`, `mood_emoji`, `description` (the section hides when absent) |
| `SLAP GET /ai/digest` | `digest`, `highlights[]`, `vibe_shift` |
| `SLAP GET /listening` | `enabled`, `top_artists[]`, `top_tracks[]`, `total_scrobbles`, `period_days` (the section hides when `!enabled` or both lists are empty) |
| `SLAP GET /leaderboard` | `entries[]{rank, username, song_count, color, latest_addition}` (Throne = `entries[0]`, SL-05) |
| `SLAP GET /hot` | **`tracks[]`**, `period_hours` (**fix:** legacy read `items`/`hot`; today it is `tracks:[]`, so empty) |
| `SLAP GET /streaks` | `entries[]{username, color, current_streak, longest_streak, is_active}` |
| `SLAP GET /head-to-head/{u1}/{u2}` | `user1/2`, `user1/2_color`, `user1/2_songs`, `user1/2_artists`, `user1/2_platforms`, `shared_artists[]`, `user1/2_unique_artists[]` |
| `SLAP GET /taste-dna/{u1}/{u2}` | `analysis`, `compatibility_score`, `shared_artists[]`, `unique_to_user1/2[]`, `vibe_user1/2` |
| `SLAP GET /ai/recommendations/{username}` | `username`, `recommendations[]` (strings), `reasoning` |
| `SLAP GET /timeline` | `entries[]{date, count}` |
| `SLAP GET /genres` | `genres[]{name, count, percentage}` (platform breakdown) |
| `SLAP GET /heatmap` | `cells[]{day, hour, count}`, `max_count` |
| `SLAP GET /artists?limit=10` | `artists[]{name, count, latest_album}` |
| `SLAP GET /achievements` | `achievements[]{id, name, emoji, description, unlocked, unlocked_by[]}` |
| `SLAP GET /hipster` | `entries[]{username, color, unique_artists, hipster_score}` ("lower = more obscure") |
| `SLAP GET /personalities` | `cards[]{username, color, personality, description, dominant_platform, song_count}` |
| `SLAP GET /hall-of-fame` | `entries[]{title, description, value, emoji}` |
| `SLAP GET /recent?limit=30` | `items[]{title, artist, album, username, color, created_at, source_platform, url}` |

Display names use the SL-20 map (`username → name`); an unknown username falls back to the raw username. Per-user `color` is decoration only; the name is always shown as text.

**Mobile 375 (primary):** a sticky **jump row** (chips, horizontally scrollable) groups 19 panels into five, which cuts scan and decision cost (Hick–Hyman; Gestalt proximity):

| Group | Panels |
|---|---|
| Overview | stats 2×2 (SL-01) · vibe (SL-02) · digest + highlight chips (SL-03) · On Repeat (SL-04) |
| Rankings | Throne (SL-05) · Hot (SL-06) · Leaderboard (SL-07) · Streaks (SL-08) · Hipster (SL-16) |
| Compare | Taste DNA: two stacked selects + [Compare] (SL-09) · Recommendations: user select (SL-10) |
| Charts | Timeline (SL-11) · Platforms (SL-12) · Heatmap (SL-13) · Top artists (SL-14) |
| Feed | Achievements (SL-15) · Personalities (SL-17) · Hall of fame (SL-18) · Recent + "Full dashboard ↗" (SL-19) |

**Desktop 1280 (reflow):** the same five groups in the same order, with the jump row still sticky. Inside each group the panels auto-fill a card grid (min 320 px, so 2–3 across). Stats go 4-up, and the two Compare selects sit side by side.

| State | Behavior |
|---|---|
| loading | Per-panel skeletons. AI panels show "Asking the AI…" only once scrolled into view |
| empty | Hot `tracks:[]` → "Nothing new in the last 24 h" (live today). Streaks with none active → "No active streaks". Compare before a pick → "Pick two people to compare". Vibe or On Repeat unavailable/disabled → the panel is hidden (SL-02, SL-04) |
| error | Per panel: "Slap didn't answer" + Retry. The service is external, so one panel failing never blocks the others. Compare error → inline under the selects |
| stale | A manual ↻ that fails keeps the last data with "Updated N min ago". There is no poll |
| 429 | N/A: Slap sent no rate-limit headers in the probe and `server.py` is not in the path. If one ever arrives, the default 429 row applies (read `Retry-After` if present) |
| signed-out | The document is gated by `_auth_gate` (default). The Slap calls themselves are public, so they cannot 401 |
| forbidden | N/A: Slap endpoints are public and there is no role content |
| 410-purged | N/A: no clip media |
| in-call | Default (mini-bar). No media plays on this page |

---

### PS-4 · WhatsApp (`/app/whatsapp`)

**Purpose:** "Professional Goopers" chat analytics: awards, activity and receipts (J6). **Entry:** More / sidebar; Admin shortcut (import). **Primary CTA:** the range selector. **Exit:** Excel export (download).
**Rows:** WA-01, WA-02, WA-03, WA-04, WA-05, WA-06, WA-07, WA-08, WA-09, WA-10, WA-11, WA-12, WA-13, WA-14, WA-15. Charts are specified in Phase 6.

**Endpoint contract.** Every data call takes `?range=all_time|this_year|this_month|prev_month|custom&start=&end=`. All eight fire in parallel on a range change. A **generation guard** drops late responses from an earlier range (WA-01). There is no poll.

| Call | Fields consumed |
|---|---|
| `GET /api/whatsapp/stats` | `total_messages`, `total_members`, `total_videos`, `total_photos`, `total_media`, `conversation_days`, `member_message_counts`, `first_ts`, `last_ts` |
| `GET /api/whatsapp/awards` | `certified_yapper`, `night_owl`, `early_bird`, `video_king`, `photo_king`, `most_skull`, `most_laugh`, `most_fire`, `fastest_replier`, `ghost_of_month` (each `{name, count\|avg_minutes\|hour…}`), + `biggest_day`, `longest_streak_days`, `most_reacted_*`, `peak_hour`, `most_used_emoji` |
| `GET /api/whatsapp/activity` | `daily[]{date, count}`, `monthly[]{month, count}`, `by_hour[]{hour, count}`, `by_dow[]{dow, label, count}`, `member_monthly`, `top_days` |
| `GET /api/whatsapp/heatmap` | `cells[]{dow, hour, count}`, `max_count` |
| `GET /api/whatsapp/members` | `members[]{name, messages, total_words, total_chars, avg_words_per_msg, photos, videos, audios, media_omitted, first_ts, last_ts}` |
| `GET /api/whatsapp/emojis` | `top_emoji[]{emoji, count, pct}`, `total_emoji`, `member_top_emoji` |
| `GET /api/whatsapp/words` | `top_words[]{word, count}`, `member_top_words` |
| `GET /api/whatsapp/response-times` | `distribution`, `member_avg_minutes`, `event_count`, `fastest_responder` |
| `GET /api/whatsapp/export` | A download link with the current range. xlsx; 401; 501 "export unavailable" |
| `GET /api/whatsapp/can-import` | `can_import`. The import section renders only if true (WA-14) |
| `POST /api/whatsapp/import` (multipart `file`) | `status`, `message_count`, `duplicate_count`, `total_parsed`. Errors: 400 (not .txt/.zip) · 401 · 403 · 413 (> 50 MB) |

**Mobile 375 (primary):**
1. The range selector is a horizontally scrollable segmented control. "Custom" opens a date sheet (start → end, Apply).
2. Stats 2×3 (WA-02).
3. Awards: 2-column cards, the winner name as text (WA-03).
4. Activity charts (WA-04–08; Phase 6 encodings).
5. Members are cards (WA-09).
6. Emoji (WA-10), then Words (WA-11), then Response times (WA-12).
7. Export (WA-13).
8. Import (WA-14, role-gated): file picker (.txt/.zip ≤ 50 MB), "Without media", Import.

**Mobile fallback:** every desktop WhatsApp job still works on a phone.
- **Stats table** (WA-09): one card per member (name, messages, words, avg words/msg, media counts, first/last seen). A visible **Sort by** select (Messages · Words · Avg words · Media · Last seen) and an ↑/↓ toggle replace the header clicks. Nothing is hidden: the card shows every column the table has.
- **Charts** (WA-04–08, WA-12): they stack at full width. Each chart has a "Show as table" disclosure, so the numbers can be read without precise taps (Phase 6 encodes it).
- **Export** (WA-13): a button that downloads the xlsx for the current range (the browser's download or share sheet).
- **Import** (WA-14): the OS file picker (.txt / .zip from Files or the WhatsApp "Export chat" share). The result shows as text: imported / duplicates / parsed.

**Desktop 1280 (bespoke):** an analysis desk for comparing many members across many columns. This is the data-table pattern (usability ui-patterns), because on a phone the cross-member comparison takes too many scrolls.
- **The range bar is sticky** at the top of the content: the segmented control, the Custom start/end date inputs inline (no sheet), and **Export to Excel** on the right. Export names the range it will export: "Export This Month (.xlsx)".
- **The stats row is 6-up.** Awards are a 5 × 2 grid.
- **Charts** are a 2-column grid. The activity timeline (WA-04) and the heatmap (WA-08) span both columns. The "Show as table" disclosure stays.
- **The member table** (WA-09) is full width:
  - Columns: Member · Messages · Words · Avg words/msg · Chars · Photos · Videos · Audio · Media omitted · First seen · Last seen.
  - The header is sticky and the Member column is frozen.
  - Column headers are **buttons** that sort, with `aria-sort`. The same Sort by select as mobile sits above the table.
  - Top-emoji and top-words per member open in an expandable row (WA-10, WA-11), not a hover card.
- **Emoji and Words sit side by side.** Response times (WA-12) are full width below.
- **The import panel** (WA-14, role-gated) is a bordered admin panel at the bottom:
  - the file button, a drop zone as an accelerator (the button is always there), the "Without media" checkbox and Import
  - the result line ("Imported N · N duplicates skipped · N parsed")
  - the last import's summary, kept until the page reloads

| State | Behavior |
|---|---|
| loading | First load: skeletons. **Range change:** the previous numbers stay but dimmed, with a "Loading This Month…" marker, and are replaced atomically when the current generation lands |
| empty | `total_messages == 0` → WA-15 "No WhatsApp messages yet", plus the import hint if `can_import`, otherwise "Ask Moiz to import the chat". A range with no messages → "Nothing in this range" + [All time] |
| error | Per panel + Retry. Import errors are inline: 400 wrong file type, 413 too large, 403 not allowed |
| stale | A late response from an old range is discarded, never shown (the generation guard). A failed refresh keeps the last data with "Updated N min ago" |
| 429 | N/A: no WhatsApp route calls `_rate_limit` |
| signed-out | Default. Export and import 401 → banner |
| forbidden | `can_import:false` → the import section is hidden. An import 403 (role revoked mid-session) → "You're not allowed to import — ask Moiz", and the section hides |
| 410-purged | N/A: analytics only, no media |
| in-call | Default (mini-bar) |

---

### PS-5 · Giveaway (`/app/giveaway`)

**Purpose:** Monthly giveaway: am I in, when is the reveal, who won (J9). Admins run it in context. **Entry:** More / sidebar; Admin shortcut. **Primary CTA:** none for members (read-only); admins get the next state action. **Exit:** none.
**Rows:** GW-01, GW-02, GW-03, GW-04, GW-05, GW-06, GW-07, GW-08, GW-09, GW-10, GW-11, GW-12. (GW-13 and GW-14 are excluded.) Flow: F-6. **Rendering never mutates.**

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/giveaway` | On load, on visibility, after every admin action, and after the countdown hits 0 (5 s, 15 s, 60 s, then every 60 s until `status` changes) | `giveaway{id, title, prize, status, draw_at, reveal_at, drawn_at, revealed_at, entries[]{member_id, display_name}, active_draw{draw_number, winner_name, drawn_at, manifest_hash}}`, `rotation{cycle, total_members, won_count, eligible_count, eligible[], won_members[], all_members[]}`, `is_admin`, `user_eligible`, `user_won_this_cycle`. **Never read `giveaway.draws` for members** (B-5) | 401 |
| `GET /api/giveaway/history` | On load | the past giveaways list (title, prize, revealed_at, `active_draw.winner_name`), up to 8 shown | 401 |
| `POST /api/giveaway` `{title, prize, reveal_at}` → `POST /api/giveaway/{id}/publish` | Admin create (auto-publish) | `id`, `status`; publish → `entries` count ("N members entered") | 403 "admin only" · 400 |
| `PUT /api/giveaway/{id}` | Admin edit | updated giveaway | 400 (closed) · 403 |
| `POST /api/giveaway/{id}/entries` · `DELETE /api/giveaway/{id}/entries/{member_id}` | Admin entries | `status` | 400 · 403 |
| `POST /api/giveaway/{id}/draw-and-reveal` | [Draw & reveal now] / [Reveal now] (after the confirm) | `status:"revealed"` | 400 (state) · 404 · 403 |
| `POST /api/giveaway/{id}/redraw` `{reason}` · `POST /api/giveaway/{id}/close` | Admin | `winner` / `status` | 400 · 403 |
| `POST /api/giveaway/admin/reset-and-seed` `{winner_query, title?, prize?}` | Danger zone | `status` | 404 `no_match` + `all_members` · 409 `ambiguous` + `matches` · 400 |

The countdown (GW-02) is a client 1 s tick parsed as local time. At zero it re-fetches only.

**Mobile 375 (primary):**
1. **Hero by state** (GW-01): title, prize, and the state line. States: open → "Reveal in"; drawn → "Winner reveal in"; revealed → 🏆 winner + 🎁 prize.
2. The countdown D:H:M:S, as large numerals with an `aria-live="off"` ticker and an `aria-label` refreshed every minute.
3. The eligibility badge (GW-03), in text.
4. Rotation progress: "Cycle 3 · 6 of 9 still eligible", with a bar (GW-04).
5. Past winners, collapsible (GW-05).
6. **Admin tools** (role-gated, collapsed by default, `h2` "Admin tools"), in order:
   - the winner preview (GW-10)
   - the next state action as the primary button (GW-11)
   - edit (GW-08)
   - entries (GW-09)
   - the danger zone (GW-12), last and visually separated

**Mobile fallback:** the Admin tools above are the complete admin job on a phone. The layout is one column, and each tool is a collapsible card in lifecycle order.
- The state card shows the current status in text ("Open · 9 entries · reveal Fri 20:00") and **one primary button for the next transition** (GW-11). Secondary transitions (Disqualify & redraw, Close) sit under a "More actions" disclosure.
- **Entries** (GW-09) are a list: name + ✕ Remove, ≥ 44 px, with a confirm naming the member. [+ Add entry] opens a sheet with the rotation list, searchable.
- **Create / edit** (GW-07, GW-08) is a single-column form: title, prize, and reveal date-time with the native picker. It uses visible labels and validates on blur.
- Every dialog (redraw reason, close, reset & seed) is a full-height sheet with its confirm at the bottom, in the thumb zone.

**Desktop 1280 (reflow):** member view. The hero, countdown and eligibility take a fluid left column. Rotation and past winners take a 360 px right column.

**Desktop 1280 (bespoke):** Admin tools (role-gated) are a full-width admin desk below the member view. It is for running the monthly lifecycle and editing entries, a list-editing job that is clunky one-handed.
- **The lifecycle strip** runs across the top: none → draft → open (→ locked) → drawn → revealed → closed. The current state is marked in text and with `aria-current="step"`. The next transition is the one primary button at the end of the strip (GW-11), and a confirm names its effect (F-6). Secondary transitions sit beside it as secondary buttons.
- **Three columns** below the strip:
  1. **State + winner preview** (GW-10): draw #, manifest hash with [Copy], drawn at, and the winner (admins only).
  2. **Entries** (GW-09), as a table: Member · Eligible (✅ / 🏆 won this cycle, from `rotation.eligible[]` / `won_members[]`) · Remove.
     - The header is sticky.
     - An add row at the top holds a rotation-member combobox and [Add].
     - "N entered · N eligible" shows in the column header.
  3. **Create / edit** (GW-07, GW-08): title, prize, reveal date-time and Save. For a closed giveaway it is disabled, with the reason given.
- **Danger zone** (GW-12): a separate bordered row at the bottom. Reset & seed uses a type-to-confirm with the winner's name, and shows the `no_match` / `ambiguous` pick lists inline.
- Dialogs (redraw reason, close) are centred dialogs with the same fields as the mobile sheets.

| State | Behavior |
|---|---|
| loading | Hero skeleton. The countdown is not rendered until `reveal_at` is known (no "00:00:00" flash) |
| empty | No active giveaway (or a draft, for members) → "No giveaway running right now. The next one shows up here." Admins also get [Start a giveaway]. History `[]` → the section is hidden |
| error | Per panel + Retry. Admin action 400 → inline under that action with the server's reason (e.g. "not open") |
| stale | Refresh failure → "Updated N min ago". **Reveal overdue** (`now > reveal_at` and status still open/locked/drawn) → "The reveal is on its way", while the backoff re-fetch continues (B-2). It never POSTs |
| 429 | N/A: no giveaway route calls `_rate_limit` |
| signed-out | Default |
| forbidden | Admin tools are hidden unless `is_admin`. A 403 on an admin action (the role was revoked) → "Admins only", the page re-fetches and the tools hide. The member-side "not in this draw" is eligibility, not forbidden |
| 410-purged | N/A: no clip media |
| in-call | Default (mini-bar). Confetti is visual only, never audio |

---

### PS-6 · Watch (`/app/watch`)

**Purpose:** Watch something together in sync, with an optional call (J5). **Entry:** tab bar; mini-bar Return. **Primary CTA:** Play (set a video) / Join call. **Exit:** navigate away (the call persists) · Leave.
**Rows:** WP-01, WP-02, WP-03, WP-04, WP-05, WP-06, WP-07, WP-08, WP-09, WP-10, WP-11, WP-12, WP-13, WP-14, WP-15, WP-16, WP-17, WP-18, WP-19, WP-20, WP-21, WP-22. (WP-23 is excluded.) Flow: F-4.

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/watch/config` | Page boot (shell-owned) | `origin`, `socketPath`, `rooms`, `defaultRoom`, `ticketTtl`, `viewer{id, name, nickname, psnOnlineId, mod}` | 401 |
| `POST /api/watch/join` `{roomId}` | Connect / reconnect / ticket expiry | `ticket`, `expiresIn`, `room`, `viewer{name, mod}` | 400 room · 401 · **403 link PSN** · 429 (30/60 s) · 503 |
| `POST /api/watch/extract` `{url}` | Play with a non-YouTube, non-direct URL | `url`, `kind`, `title` | 400 · 422 · 429 (5/60 s) |
| `GET /api/watch/proxy` | Stream source for browser-extracted HLS | stream | 4xx/5xx → playback error |
| `POST /api/watch/nickname` `{nickname}` | ✏️ Display name dialog → reconnect | `nickname`, `name` | 401 |
| `POST /api/watch/rally` `{message}` | 📣 Rally → F-0 | `status` | 400 · 503 · 502 (Unknown) |
| `GET /api/watch/history?room=&mine=&limit=24` | History open / ↻ | `items[]{url, title, year, kind, poster, overview, genres, viewers[]{name, position, finished, updated_at}, mine{position, finished, updated_at}, chat_count, last_watched_at}` | 401 |
| `GET /api/watch/history/chat?url=&room=` | Open a history card | `messages[]` | 400 |
| `POST /api/watch/history/title` `{url, title}` · `DELETE /api/watch/history` | ✎ rename (10/60 s) · ✕ forget (confirm naming the title) | `ok` · `removed` | 400 · 429 |
| `POST /api/watch/history` | Progress: on pause and every 3 s check (`keepalive`) · 40/60 s | `ok` | Silent, retried on the next tick (idempotent) |
| `POST /api/watch/log` | Diagnostics every 10 s, heartbeat 30 s | none | Silent |
| WatchParty socket | Live | `watch:presence`, `roster`, `REC:*`, `chatinit`, `errorMessage`, `kicked`; emits `CMD:play/pause/seek/ts/host/askHost/chatV/kickUser`, `signal` | disconnect → stale |

**Mobile 375 (primary):**
1. Presence pill (connecting / live / offline) + the roster as an avatar row with a "+N" overflow (WP-02).
2. **The stage** at 16:9 full width (WP-03). A tap on the stage shows the overlay bar, and so does keyboard focus. It auto-hides after inactivity but never while it holds focus. It holds:
   - seek (the time readout shows while dragging or focused), play/pause, volume/mute, time
   - mic, camera, reactions, sync, cams-over-video, fullscreen, Leave
   - "Everyone's mic" mute is always shown. Its volume slider, and the per-person volume in the ⋯ menu, show wherever the browser lets media `volume` be set. This is **feature detection, not device class**: iOS Safari's `volume` is read-only. The legacy `(hover:none)` proxy wrongly hid it on Android as well (WP-07).
   - Every key has a button (WP-07). WP-08 keys are accelerators only. They are **scoped to this page** (not global) and ignored while typing.
3. "What are we watching?" title + URL field + [▶ Play] + ✕ Clear (WP-04, WP-05).
4. The action row: [Join with camera + mic] / in-call controls, 📣 Rally, ✏️ Display name (WP-10, WP-18, WP-17).
5. Camera orbs row (WP-11). Each orb has a **⋯ button** for its menu (WP-12) and can be enlarged. There is a ⛶ grid fullscreen with flip (WP-13).
6. Reactions tray (WP-09).
7. Room chat log + input (WP-16). The fullscreen stage has its inline chat (WP-15).
8. History, with tabs This room / Just me (WP-19).

**Desktop 1280 (reflow):** two columns. On the left (fluid) are the stage, then title/URL/Play and the action row. On the right (360 px) are the roster, the orbs as a grid, reactions and the chat (items 5–7 of the mobile stack). This matches main's shipped "cams beside the player" at ≥ 1024.
History auto-fills a card grid below (cards ≥ 280 px). The stage uses the same tap/focus overlay as mobile, and nothing is bound to double-click or hover.

| State | Behavior |
|---|---|
| loading | Pill "connecting…". The stage is a skeleton. Controls that need the socket are disabled with the reason "Connecting to the party…" |
| empty | Nothing playing → "Nothing playing yet — paste a link" with the URL field focused. Alone → roster "Just you". History `[]` → "Nothing watched yet in this room" |
| error | Config 503 / socket script failure → "Watch Party server unreachable" + Retry. Extract 422 → "Couldn't find a video at that link"; 400 Drive folder → the server's hint. Playback error → "This video won't play here" + Clear. `errorMessage` from the socket → inline (WP-22) |
| stale | Socket disconnected → pill "offline — reconnecting". The stage keeps the last frame and sync controls are disabled until `live`. History refresh failure → "Updated N min ago" |
| 429 | Join (30/60 s) → wait `Retry-After`, then reconnect automatically (idempotent). Extract (5/60 s) → countdown on Play. Title rename (10/60 s) → countdown in the dialog. Progress pings (40/60 s) → dropped silently |
| signed-out | Config/join 401 → default banner. The live socket keeps working until the ticket expires. Then the re-mint fails → the call ends with "Sign in to rejoin" |
| forbidden | Join 403 → "Link your PSN account to join" + [Link PSN] → Portal. Kicked → pre-join with "A moderator removed you from the party". Mod-only "Remove from party" in the ⋯ menu is hidden for non-mods |
| 410-purged | N/A: Watch plays external URLs, not archived clips. A dead URL is the error row |
| in-call | **This is the call's own page, so the mini-bar is hidden here.** The action row shows Live/Muted, camera, flip and Leave. Leaving the route keeps the call (PS-0) |

---

### PS-7 · Huddle (`/app/huddle`)

**Purpose:** A video call for the squad, with an in-call AI helper and a transcript (J5). **Entry:** More / sidebar; mini-bar Return. **Primary CTA:** 🎥 Join. **Exit:** 🔴 Leave; navigate (the call persists).
**Rows:** HU-01, HU-02, HU-03, HU-04, HU-05, HU-06, HU-07. (HU-08 is in PS-0.) Flow: F-5.

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `POST /api/huddle/token` `{room}` | Join (the token lives 6 h) | `token`, `url`, `room` (sanitised to `[a-z0-9-]`) | 401 · 503 not configured |
| LiveKit client (jsDelivr CDN) + WebSocket `url` | Join; live | participants, tracks, active speakers, connection state | CDN/WS failure → error; `reconnecting` → stale |
| `POST /api/huddle/ai` `{messages}` | AI panel send | `message.content` | 400 · 401 · 503 · 502 |
| `POST /api/huddle/transcribe` (multipart `file`) | 🎙 Transcript chunks | `text` | 400 · 401 · 503 · 502 |

**Mobile 375 (primary):**
- **Pre-join:** camera preview (camera-off state), room field, mic and camera selects, and [🎥 Join] ≥ 44 px in the thumb zone (HU-01).
- **In call:**
  - A top bar: room · N people · ⊞ layout · 💬 AI (HU-02).
  - The spotlight, plus a filmstrip scrollable horizontally (HU-03).
  - A bottom control bar: 🎤 📷 🖥 🌫 🔴 (HU-04). Screen share is hidden where the browser lacks `getDisplayMedia`.
  - The AI panel is a bottom sheet (HU-05, HU-07), holding 🎙 Transcript and 📋 Notes.
  - **While the transcript runs, a visible "🎙 Transcript on" chip** shows in the top bar (consent/transparency, ai-native §B). The code plan should broadcast it to the other participants.

**Desktop 1280 (reflow):** the same stage, filmstrip and control bar, with the filmstrip moved to a vertical strip beside the spotlight. The AI bottom sheet becomes a 360 px side sheet with the same content, which pushes the stage instead of covering it.

| State | Behavior |
|---|---|
| loading | Pre-join: "Starting camera…". Join: "Connecting to crcmz…" with controls disabled |
| empty | In a call alone → "You're the only one here." The AI panel before a question → a short explainer of what it can do (HU-05) |
| error | 503 "Huddle isn't set up on this server". CDN/WS failure → + Retry. Permission denied → the camera-off preview + how to allow it + [Join without camera]. AI/transcribe 502 → inline in the panel |
| stale | LiveKit `reconnecting` → an overlay "Reconnecting…" over the stage. The call is kept and controls are disabled. `disconnected` after retries → pre-join with "The call dropped" + [Rejoin] |
| 429 | N/A: no Huddle route calls `_rate_limit` |
| signed-out | Before join: token 401 → default. **During a call** the LiveKit token stays valid (6 h), so the call continues. AI/transcribe 401 → the banner inside the AI panel |
| forbidden | N/A: any member may join any room (no 403 path). Device permission is covered under error |
| 410-purged | N/A: no clip media |
| in-call | **This is the call's own page, so the mini-bar is hidden here.** If a Watch call is also live, its mini-bar row still shows. Navigating keeps the room (PS-0) |

---

### PS-8 · AI Coach (`/app/coach`)

**Purpose:** Your AI read on your clips, plus one drill for next time (J7). **Entry:** More / sidebar. **Primary CTA:** open the latest report. **Exit:** none.
**Rows:** CO-01, CO-02, CO-03, CO-04, CO-05, CO-06, CO-07, CO-08, CO-09, CO-10, CO-11. Charts are specified in Phase 6.

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/coaching?scope=me\|squad&limit=50` | On load, on scope change, on visibility. **60 s while `counts.processing > 0`** (new: shows when a review lands) | `scope`, `notify_mode`, `detail_mode`, `counts{mine, squad, complete, processing}`, `processing[]{clip_id, psn_user, status, created_at, reason}`, `reviews[]`, in two shapes. **Mine:** `{review_id, clip_id, psn_user, is_mine, game, created_at, status, summary, overall_assessment, grade, strengths, mistakes, coaching_tips, notable_moments, tags, voice_comms (own only), my_feedback}`. **Squad:** only `{grade, game, created_at}`, so squad scope shows no report cards, only the grade list, charts and sightings. Plus `sightings` and `charts{tags, mistakes, per_day, grades}` | 401 |
| `POST /api/coaching/prefs` `{mode}` or `{detail}` | Group / DM / Off; Report / Link only | `notify_mode`, `detail_mode` | 400 · 401 |
| `POST /api/coaching/feedback` `{review_id, rating, tags, comment}` | 👍/👎 + Submit | `ok`, `feedback_id` | 400 · 404 · 401 |

**Mobile 375 (primary):**
1. Scope tabs: Mine (n) / Squad (n) (CO-01).
2. **Hero** (CO-03): the latest grade + delta ▲▼=, the "Focus" line (a repeated mistake) and the "Next session" drill. The trajectory chart comes in Phase 6.
3. Stats row: reviews, this week, processing, sparkline (CO-04).
4. Grades and Themes bars (CO-05).
5. Mistake patterns (CO-06). Tapping one opens the source report.
6. Processing list (CO-08). In Squad scope, the sightings show here (CO-07).
7. Reports toolbar (CO-09): search, game, player (squad), sort, count, Clear. Filters are in a sheet on mobile.
8. Report cards (CO-10), **Mine scope only.** Squad scope lists grade · game · date rows instead, because the API returns nothing more for squad reviews. Cards are collapsed by default. They expand to show summary, strengths, mistakes, tips and moments, and the squad voice (own reports only). Feedback: 👍/👎, tags, comment, Submit, "✓ saved".
9. Notify prefs (CO-02) sit as a compact settings row at the top, next to the scope tabs.

**Desktop 1280 (reflow):** the hero (with the stats row inside it) spans the width. Below it, mobile items 4–6 stack in a left column (min 320 px), and items 7–8 (toolbar and reports) fill the right. The filter sheet becomes an inline toolbar row.

| State | Behavior |
|---|---|
| loading | Hero + 3 report card skeletons |
| empty | No reviews (CO-11) → "Send **rev** in the PSN group within ~5 s of a clip and the coach will grade it." Squad scope empty → "No one's been graded yet." Filters with no rows → [Clear filters] |
| error | Default + Retry. Feedback submit error → inline on that card, with the rating kept |
| stale | The 60 s processing refresh fails → "Updated N min ago" on the Processing list |
| 429 | N/A: no coaching route calls `_rate_limit` |
| signed-out | `/api/coaching` 401 "sign in to see coaching" → default banner (CO-11). A feedback draft is kept |
| forbidden | N/A: every member can read both scopes. Privacy (`voice_comms` own only; sightings never link to private reports) is enforced server-side. Nothing is gated in the UI |
| 410-purged | N/A: reports carry no clip media |
| in-call | Default (mini-bar) |

---

### PS-9 · Ask AI (`/app/ask`)

**Purpose:** Ask something that already knows the squad's history (J8). **Entry:** More / sidebar. **Primary CTA:** Ask (the composer). **Exit:** any nav item; exits to deterministic pages when the AI is unavailable.
**Rows:** AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, AI-07. Flow: F-7. The page is reading width (~760 px). **There is no Chat Board here**, so nothing covers the composer (G-11 fixed structurally).

**AI-native notes.** These are principle-derived (no settled canon; Dibia, Smashing 2024):
- **Goal contract:** the explainer (AI-07) says what it reads and that it never acts.
- **Inspectable:** each answer shows its tools and elapsed time.
- **Grounding:** the facts panel shows what it "knows".
- **Fixed anchors:** the composer, chips and nav stay stable. The answers are the only non-deterministic part.
- **Exit:** when the model is unavailable, link to the deterministic pages.
- Uncertainty is not faked: the page never paints a confidence score it doesn't have.

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/assistant/tools` | On load | `available`, `model`, `tools[]{name, description}` → "Model · N tools" (AI-01) | 401 |
| `GET /api/assistant/history` | On load and on return to the tab. **2 s while `pending`** (1 s elapsed counter client-side) | `messages[]{id, role, content, status (done\|pending\|error), tools, elapsed_ms, created_at}`, `pending`, `count` | 401 |
| `POST /api/assistant/ask` `{question, image_b64?, image_type?}` | Ask / chip | 202 `{status:"queued", reply_id}` | 400 · 401 · **409 still working** · **429 (10/60 s)** · 503 |
| `POST /api/assistant/clear` | 🗑 after the confirm | `status`, `removed` | 401 |
| `GET /api/assistant/facts` | On load, after add/delete | `facts[]{id, subject, text, author, created_at, mine}`, `total`, `mine`, `max_per_user`, `max_chars`, `subjects[]` | 401 |
| `POST /api/assistant/facts` `{text, subject}` · `POST /api/assistant/facts/delete` `{id}` | Add / delete own | `status`, `id`, `total` | 400 · **429 (12/60 s)** · 404 not yours |

**Mobile 375 (primary):**
1. Header: `h1` "Ask AI", the model line (AI-01) and 🗑 Clear.
2. A one-paragraph explainer, collapsible after the first visit (AI-07).
3. The thread (AI-03). Answer bubbles show tool/elapsed meta. The pending bubble reads "thinking… 12 s".
4. Suggestion chips (AI-02) show above the composer when the thread is empty. Otherwise they sit in a "Suggestions" disclosure.
5. **The composer is pinned bottom, above the tab bar:** a visible label, a textarea (grows to 4 lines), a 📎 image (thumbnail + remove), a counter at 900+/1000, and Send ≥ 44 px (AI-04).
6. 🧠 Squad facts (AI-06) sits behind a "Squad facts (N)" button that opens a sheet:
   - counts total / mine / max
   - add: subject combobox with suggestions + text
   - a filter when there are more than 6
   - the list, with delete on your own facts

**Desktop 1280 (reflow):** the thread and pinned composer are centred at reading width (~760 px, brief exception). The "Squad facts (N)" button stays in the header and opens the same facts panel as a 360 px side sheet instead of a bottom sheet. Grounding stays one tap away without adding a second pane.

| State | Behavior |
|---|---|
| loading | Thread skeleton (3 bubbles). The composer is disabled until tools/history resolve |
| empty | No messages → the explainer + 6 chips. No facts → "Teach it something about the squad" + the add form |
| error | `available:false` / 503 → composer disabled: "The AI is offline (it runs on the Mac at home)" + links to Squad, WhatsApp, Slap. An answer with `status:"error"` → the bubble reads "Couldn't get an answer" + [Ask again] (refills the composer). 400 too long → inline at the counter |
| stale | History poll failure while pending → "Still waiting — reconnecting" on the pending bubble. The poll resumes. The server keeps working regardless |
| 429 | Ask (10/60 s) → countdown on Send; the draft is kept. Facts add (12/60 s) → countdown on Add |
| signed-out | Default. The draft is kept, and any image is kept in memory |
| forbidden | N/A: every member may ask and add facts. Deleting someone else's fact returns **404** "not yours or already gone" (shown as an error), not 403 |
| 410-purged | N/A: no clip media |
| in-call | Default (mini-bar). The composer sits above the mini-bar and tab bar on mobile |

**409 note:** while `pending`, Send is disabled with the reason "Still answering your last one", so 409 is a fallback, not the normal path.

---

### PS-10 · Settings (`/app/settings/{passkeys|security|psn|mattermost|mcp}`)

**Purpose:** Your account: sign-in methods, PSN status, connected apps (J10). **Entry:** More → Settings; account menu; `/app/settings` → the last tab or `passkeys`. **Primary CTA:** per tab. **Exit:** PSN → Portal (link/relink).
**Rows:** ST-01, ST-02, ST-03, ST-04, ST-05, ST-08, ST-09. (ST-06 → PS-12; ST-07 and ST-10 → PS-11.) Tabs are sub-routes, so they deep-link and Back works (Nielsen #3).

**Endpoint contract**

| Tab | Call | Fields consumed | Errors |
|---|---|---|---|
| Passkeys | `GET /auth/settings/passkeys` | `passkeys[]{id, name}` | 401. **Upstream failure returns `[]`** (B-9), so "empty" may hide an error |
| Passkeys | `DELETE /auth/settings/passkeys/{id}` (confirm naming the passkey) | `ok` | 400 · 503 |
| Passkeys | `POST /auth/passkey/register/begin` → WebAuthn → `POST /auth/passkey/register/complete` | challenge / `ok` | 4xx → "Couldn't add the passkey"; the user cancelling the WebAuthn prompt is not an error |
| Security | `POST /auth/settings/password` `{currentPassword, newPassword}` | `ok` | 400 (wrong current, missing fields) · 503. Client check: ≥ 8 and confirm matches, validated on blur |
| PSN | `GET /auth/settings/psn` | linked: `online_id`, `linked_at`, `token_ok`, `npsso_ok`, `refresh_expires_at`. Not linked: `unclaimed[]{key, online_id, mm_username, linked_at}` (`users` ignored here → PS-11) | 401 |
| PSN | `POST /auth/settings/psn/claim` `{key}` | `ok` | 400 · 404 already claimed |
| Mattermost | `GET /auth/settings/mattermost` · popup `GET /auth/settings/mattermost/connect` (`postMessage 'mm_linked'`) · `POST /auth/settings/mattermost/unlink` | `linked`, `linked_at`, `connect_available` | 503 not configured |
| MCP | `GET /auth/settings/mcp` · `POST /auth/settings/mcp/revoke` (confirm) | `active`, `last_used_at` | 401 |

**PSN tab (ST-04, ST-05).** It shows:
- the linked `online_id`, and "linked on" `linked_at`
- the status in text: **Active** / **Expiring in N days** (within 7 days of `refresh_expires_at`, new) / **Expired** (`!token_ok` or past `refresh_expires_at`)
- **[Re-link in Link PSN]** → Portal
- when not linked: the unclaimed list with [This is mine] (the same component as Portal step 0), then [Link your PSN account] → Portal

The inline 3-step flow is gone (ST-06 moved).

**Mobile 375 (primary):** a horizontally scrollable tab strip (`role=tablist`, 5 tabs, each ≥ 44 px, arrow keys move between tabs) under the `h1`. The tab panel is a single column. Forms have visible labels above the inputs. MCP shows the config block with [Copy] (a tap target, not a select-to-copy).

**Desktop 1280 (reflow):** the same tab strip (it fits without scrolling) and single-column panel, capped at reading width (~760 px, brief exception).

| State | Behavior |
|---|---|
| loading | Skeleton per tab panel. The tab strip is live immediately |
| empty | Passkeys `[]` → "No passkeys yet" + [＋ Add a passkey] (may be hiding an error: B-9). MCP not connected → the how-to steps + config block + 🔄 Refresh. Mattermost not linked → [🔗 Connect] |
| error | Per tab + Retry. Password 400 → inline on the current-password field (`aria-describedby`). Mattermost popup blocked → "Allow pop-ups, or open the connect page" as a link |
| stale | N/A: no tab polls, and data is read on tab open. MCP has a manual 🔄 Refresh |
| 429 | N/A: no Settings route calls `_rate_limit` |
| signed-out | Default. Form input is kept (not passwords) |
| forbidden | N/A: every tab is the user's own. The admin-only content moved to Admin (PS-11) |
| 410-purged | N/A: no clip media |
| in-call | Default (mini-bar). The Mattermost connect opens a **popup**, so the call survives |

---

### PS-11 · Admin (`/app/admin`, admin only)

**Purpose:** One place for ops: service health, the queue, tokens and users (J11). **Entry:** sidebar footer / More (admin only). **Primary CTA:** fix the flagged item (reset a password, or ask a member to relink). **Exit:** shortcuts to Giveaway admin, Clips "Everyone's", WhatsApp import.
**Rows:** AD-01, AD-02, AD-03, AD-04, AD-05, AD-06, AD-08, CL-06, CL-32, ST-07, ST-10. (AD-07 roast is excluded, owner decision O-1.)

**Endpoint contract**

| Call | When / cadence | Fields consumed | Errors |
|---|---|---|---|
| `GET /api/admin/check` | Page gate on entry | `admin` | false → forbidden |
| `GET /api/pipeline-status` | 30 s | `services{psn_messenger, psn_montage, wa_bridge}{status ok\|error\|down, ms}` (AD-02, CL-06) | error |
| `GET /status` | 30 s | `psn`, `whatsapp`, `clip_store`, `groups`, `queue_depth`, `clips_total`, `clips_delivered`, `clips_archived`, `clips_failed`, `clips_active` (AD-03) | error |
| `GET /api/video-jobs` | 30 s | `stats{…}`, `queue_depth` (AD-04, CL-32) | error |
| `GET /auth/settings/psn` | On load + ↻ | `users[]{zitadel_user_id, mm_username, online_id, account_id, linked_at, refresh_expires_at}` (AD-06, ST-07). The claimed/unclaimed state comes from `zitadel_user_id` | 401 |
| `GET /api/admin/users` | On load + ↻ | `users[]{userId, userName, displayName, email, state}` (AD-05, ST-10) | 403 · 502 · 503 |
| `POST /api/admin/users/{id}/reset-password` `{newPassword}` | Reset, after a confirm naming the user | `ok` | 400 (< 8) · 403 · 503 |

`/status`, `/api/video-jobs` and `/api/pipeline-status` have no server role check today (B-8). The page is gated client-side; the recommendation is to gate them server-side.

**Mobile 375 (primary):**
1. **Health:** 3 service rows (dot + text status + ms, "unreachable") and the ops snapshot as a key/value list.
2. **Job queue:** depth + counts.
3. **PSN accounts:** a card list, **expired and expiring first**, each with a status in text.
4. **Users:** a list plus [Reset password], which opens a dialog (new + confirm, ≥ 8, names the user).
5. **Shortcuts** (AD-08): Giveaway admin · Everyone's reels · WhatsApp import.

**Desktop 1280 (reflow):** the mobile order is kept. Health, the ops snapshot and the job queue auto-fill a card row (min 280 px). PSN accounts and Users sit side by side as the same lists, and [Reset password] opens the same dialog. The shortcuts stay last.

| State | Behavior |
|---|---|
| loading | Card and table skeletons |
| empty | Queue depth 0 → "Queue is clear". No PSN accounts → "No one has linked PSN yet" + a link to Portal to share. Users `[]` → "No users returned" (with a Retry, since an empty list is unlikely) |
| error | Per card: a service `down` shows as **data** (a red dot + "unreachable"), not a page error. A fetch failure → card error + Retry. Users 502/503 → "Zitadel didn't answer" + Retry |
| stale | Health/status/jobs poll failure → "Updated N min ago" on the health row. Stale health is labelled, never shown as current |
| 429 | N/A: no admin route calls `_rate_limit` |
| signed-out | Default |
| forbidden | `admin:false`, or a 403 from users/reset → a full-page "Admins only" with a link back to Squad. The nav item is hidden for non-admins (PS-0) |
| 410-purged | N/A: no clip media |
| in-call | Default (mini-bar) |

---

### PS-12 · Portal (`/app/portal`, nav label "Link PSN")

**Purpose:** The single PSN link wizard: first link, relink after the ~60-day expiry, or claim an existing account (J10). **Entry:** nav "Link PSN"; Squad empty; Clips needs-link / upload 403; Watch join 403; Settings → PSN. **Primary CTA:** 🔗 Link my account. **Exit:** "See the Squad" (`/app`).
**Rows:** PO-01, PO-03, PO-04, PO-05, ST-06 (moved here), and ST-05 (claim, shared with Settings). (PO-02 is excluded: the session is the identity.) Flow: F-8. The page is reading width. The legacy `/portal` is untouched.

**Endpoint contract**

| Call | When | Fields consumed | Errors |
|---|---|---|---|
| `GET /auth/settings/psn` | On load, and after a claim or link | `linked`, `online_id`, `linked_at`, `token_ok`, `refresh_expires_at`, `unclaimed[]{key, online_id, mm_username, linked_at}` | 401 |
| `POST /auth/settings/psn/claim` `{key}` | Step 0 [This is mine] → confirm | `ok` | 400 invalid key · 404 already claimed |
| `POST /api/psn/link` `{npsso}` | Step ③ 🔗 Link | `ok`, `online_id` | 400 `{error}` (empty / LinkError) · 401 · 500 "Something went wrong. Try a fresh token." |
| External (new tab) | `https://www.playstation.com` (①), `https://ca.account.sony.com/api/v1/ssocookie` (②) | none | none |

**Mobile 375 (primary):**
1. `h1` "Link PSN".
2. A status card (linked as X / expired / not linked).
3. **A vertical stepper**: step 0 (only when unclaimed accounts exist), then ① ② ③. Each step has a number, a title, one instruction and one button. Later steps are **locked but visible**, so the whole path is known up front (Nielsen #6; Cowan ~4 chunks). A completed step can be reopened.
4. Step ③ has a labelled textarea (masked after paste, with a show toggle), 📋 Paste from clipboard, and 🔗 Link ≥ 44 px.
5. Success replaces the stepper (PO-03).

**Desktop 1280 (reflow):** the same status card and vertical stepper, capped at reading width (~760 px, brief exception).

| State | Behavior |
|---|---|
| loading | Status card skeleton. The stepper renders locked until the status is known |
| empty | No unclaimed accounts → step 0 is omitted (not an empty list). Not linked → the stepper starts at ① |
| error | Link 400/500 → PO-04 banner on step ③: the server's message + "Try a fresh token" + a link back to ②. The pasted value is kept. Claim 404 → "Someone already claimed that one" + the list refreshes. Clipboard denied → "Paste it manually (long-press → Paste)" |
| stale | N/A: no poll. Status is read on load and after each action |
| 429 | N/A: neither `/api/psn/link` nor the claim route calls `_rate_limit` |
| signed-out | Default. The token value is **not** persisted locally (it is a credential), so after sign-in the user pastes again |
| forbidden | N/A: any signed-in member may link or claim their own account. There is no role gate |
| 410-purged | N/A: no clip media |
| in-call | Default (mini-bar). The PlayStation and Sony pages open in **new tabs**, so the call and the wizard's progress both survive |

---

### Carry-overs to later phases

| To | Item |
|---|---|
| Phase 3 (DNA) | Input and card boundaries ≥ 3:1 non-text (mock review). A focus ring ≥ 2 px at 3:1. Neon tile classes must pair with a text label (hue is not the only cue). Reduced motion stops the aurora and confetti |
| Phase 4 (system) | Components: sheet + scrim (focus trap, `inert` background) with its desktop side-sheet / centred-dialog variants (same content), call mini-bar row, handle row with call chip, send-state button (Sending / Sent / Not sent / Unknown / countdown), stepper, per-panel error, stale marker. The bespoke desktop jobs need a sortable table (header buttons + `aria-sort`, with a Sort-by select as the mobile fallback) and a lifecycle strip (Giveaway) |
| Phase 5 (words) | Every state row above needs copy in the "YES. WE HAVE ONE." voice. F-0 "may or may not have sent" wording. Fair giveaway copy (F-6). Neutral 429 copy (B-4) |
| Phase 6 (data) | Hype meter with scale ticks 15/40/80/120 of 150. Stat tiles. WA charts/table. Slap charts. Coach trajectory and bars |
| Code plan | B-1…B-9. Shell-owned call connections. Studio −1 s / +1 s buttons (new) and the breakpoint aligned to 1024. Watch volume is gated on a settable `volume` (feature detection), and WP-08 keys are scoped to the Watch page. URL-encode `message_uid`. `Accept: application/json` on `/clips`. Tree test (Phase 1 follow-up) |
