# Discovery + Design: Phase 1 - Inventory + Job + IA

## Artifacts Found / Current State

- `JOURNEY.md` at the worktree root: **absent**. This phase creates it.
- `DESIGN.md`: **absent**. It is locked in Phase 3. This phase produces no tokens and no visuals, so nothing here needs the lock.
- `_DASHBOARD_TMPL` in `server.py` runs from line 7557 to 16998 (9,442 lines, 508 KB). I extracted it verbatim to a scratch file (`sed -n 7557,16998p server.py`) and read it in chunks:
  - HTML body: lines 1813-2408 of the extract (settings modal, 10 panels, Chat Board, mini-bar, cam-grid overlay)
  - JS: lines 2409-9441
- `_dashboard_html()` (server.py 7530-7555) injects `__USER__` (account menu, `/auth/logout`, `/auth/login`), `__SOUNDBOARD__`, `__PERSONAL__`, `__SIGNED_IN__` and `__PSN_ID__`.
- `_portal_page()` (server.py 372+): a server-rendered 3-step wizard. It has a success screen, an error banner and a Mattermost "who are you" select. It posts to `/portal/link`.
- `reels.py` router `/api/reels/*`: 13 routes used by the reel review list and the Studio editor.
- `soundboard.py`: 7 built-in tiles, and a `path` variant for non-message actions (the roast hook).
- Approved wireframe `.design-foundations/build/squad.html` (structure reference only). Its sidebar has 11 items and no Portal. Its tab bar is Squad · Watch · Clips · More.
- Following the constraint, I did not read `frontend/src` or `docs/ux/`.

## Grep counts (DW-1.1 evidence basis)

All counts are over the extracted `_DASHBOARD_TMPL`.

| Probe | Command (on extract) | Count |
|---|---|---|
| Panels | `grep -o 'id="p-[a-z_-]*"'` | **10**: p-squad, p-lb, p-pipeline, p-slap, p-wa, p-coach, p-ai, p-giveaway, p-watch, p-huddle |
| `fetch(` call sites | `grep -o 'fetch(' \| wc -l` | **104** |
| Distinct fetch expressions | `grep -oE "fetch\([^,)]{0,160}" \| sort -u` | **99** |
| `onclick=` occurrences | `grep -o 'onclick=' \| wc -l` | **140** |
| Distinct onclick handler heads | `grep -oE "onclick=[\"']?[A-Za-z_$.]+" \| sort -u` | **102** |
| `setInterval` pollers | `grep -c setInterval` | **13** |
| `function load*` loaders | `grep -o 'function load[A-Za-z]*' \| sort -u` | **19** |
| Delegated `data-a` / `data-act` / `data-view` / `data-tool` / `data-crop` / `data-filter` / `data-open` / `data-zsel` / `data-e` | `grep -oE 'data-(a\|act\|…)="'` | 30 / 7 / 5 / 1 / 1 / 1 / 1 / 2 / 1 |
| Reels `api()` call sites + `${API}` URL builds | `grep -oE "api\('…'"` and `API + '…'` | 8 + 4 |
| Non-fetch navigations (`href`, `window.open`, `src`) | path-literal grep | `/api/whatsapp/export`, `/auth/login`, `/auth/logout`, `/portal`, `/auth/settings/mattermost/connect`, `/api/reels/renders/{rid}/video`, `/api/reels/clips/{id}/source`, `/api/reels/clips/{id}/frame`, the LiveKit CDN, and `socket.io.js` from `cfg.origin` |
| Server routes (context) | `grep -E '^@app\.(get\|post\|put\|delete)\('` | 136 (+13 in the `reels.py` router) |

### Fetch target → inventory row (all 99 distinct expressions)

A script checked this mechanically. Every distinct fetch expression was matched against a regex→row table (`/tmp/p1/map.tsv`). Result: **99 expressions, 0 unmapped**.

| Fetch target (normalized) | Method(s) | Inventory row(s) |
|---|---|---|
| `/api/squad` | GET | SQ-01, SQ-03, SQ-04, SQ-05, G-05 |
| `/api/hype` | GET | SQ-02 |
| `/v2/squad` (×2: tile fire, rally) | POST | CB-01, SQ-01, SQ-06 |
| `/v2/send` | POST | CB-10 |
| `b.path` (path-action tile) | POST | CB-02 |
| `/api/soundboard` | GET, POST | CB-01, CB-05 |
| `/api/soundboard/personal` | GET, POST | CB-03, CB-05 |
| `mine ? /api/soundboard/personal : /api/soundboard` | POST | CB-05 |
| `b.mine ? /api/soundboard/personal/delete : /api/soundboard/delete` | POST | CB-06 |
| `/api/soundboard/personal/order` | POST | CB-07 |
| `/api/pipeline-status` | GET | CL-03, CL-04, CL-05, AD-02 (services, moved from CL-06) |
| `API + path` → `/api/reels` (`''`, `?all=true`, `/sync`, `/clips/{id}`, `/clips/{id}/render`, `/override`, `/force-post`, `/veto` POST+DELETE, `/renders/{rid}`, `/renders/{rid}/trajectory`) | GET, POST, DELETE | CL-07, CL-09, CL-10, CL-12, CL-17, CL-21, CL-22, CL-23, CL-24 |
| `/api/video-uploads/mine` | GET | CL-26, CL-27 |
| `/api/video-uploads/start`, `/chunk?id&offset`, `/finish` | POST, PUT, POST | CL-26 |
| `/api/video-uploads/withdraw` | POST | CL-27 |
| `SLAP_BASE/stats` | GET | SL-01 |
| `SLAP_BASE/ai/vibe-check` | GET | SL-02 |
| `SLAP_BASE/ai/digest` | GET | SL-03 |
| `SLAP_BASE/listening` | GET | SL-04 |
| `SLAP_BASE/leaderboard` | GET | SL-05, SL-07 |
| `SLAP_BASE/hot` | GET | SL-06 |
| `SLAP_BASE/streaks` | GET | SL-08 |
| `SLAP_BASE/head-to-head/{u1}/{u2}`, `/taste-dna/{u1}/{u2}` | GET | SL-09 |
| `SLAP_BASE/ai/recommendations/{u}` | GET | SL-10 |
| `SLAP_BASE/timeline` | GET | SL-11 |
| `SLAP_BASE/genres` | GET | SL-12 |
| `SLAP_BASE/heatmap` | GET | SL-13 |
| `SLAP_BASE/artists?limit=10` | GET | SL-14 |
| `SLAP_BASE/achievements` | GET | SL-15 |
| `SLAP_BASE/hipster` | GET | SL-16 |
| `SLAP_BASE/personalities` | GET | SL-17 |
| `SLAP_BASE/hall-of-fame` | GET | SL-18 |
| `SLAP_BASE/recent?limit=30` | GET | SL-19 |
| `/api/whatsapp/stats` | GET | WA-02, WA-15 |
| `/api/whatsapp/activity` | GET | WA-04, WA-05, WA-06, WA-07 |
| `/api/whatsapp/heatmap` | GET | WA-08 |
| `/api/whatsapp/members` | GET | WA-09 |
| `/api/whatsapp/emojis` | GET | WA-10 |
| `/api/whatsapp/words` | GET | WA-11 |
| `/api/whatsapp/response-times` | GET | WA-12 |
| `/api/whatsapp/awards` | GET | WA-03 |
| `/api/whatsapp/can-import`, `/api/whatsapp/import` | GET, POST | WA-14 |
| `/api/giveaway` | GET, POST | GW-01, GW-07 |
| `/api/giveaway/history` | GET | GW-05 |
| `/api/giveaway/{id}` | PUT | GW-08 |
| `/api/giveaway/{id}/publish` (×2) | POST | GW-07, GW-11 |
| `/api/giveaway/{id}/draw-and-reveal` (×3) | POST | GW-11 (button); GW-13 (auto-on-render, excluded) |
| `/api/giveaway/{id}/close`, `/redraw` | POST | GW-11 |
| `/api/giveaway/{id}/lock`, `/draw`, `/reveal` | POST | GW-14 |
| `/api/giveaway/{id}/entries`, `/entries/{mid}` | POST, DELETE | GW-09 |
| `/api/giveaway/admin/reset-and-seed` | POST | GW-12 |
| `/api/watch/config`, `/api/watch/join` | GET, POST | WP-01 |
| `/api/watch/extract` | POST | WP-04 |
| `/api/watch/history` (×2), `/history?limit=24&…`, `/history/chat?url=`, `/history/title` | GET, POST, DELETE | WP-19, WP-20 |
| `/api/watch/nickname` | POST | WP-17 |
| `/api/watch/rally` | POST | WP-18 |
| `/api/watch/log` | POST | WP-21 |
| `/api/huddle/token` | POST | HU-01 |
| `/api/huddle/ai` (×2) | POST | HU-05, HU-07 |
| `/api/huddle/transcribe` | POST | HU-06 |
| `/api/coaching?scope=` | GET | CO-01 |
| `/api/coaching/prefs` | POST | CO-02 |
| `/api/coaching/feedback` | POST | CO-10 |
| `/api/assistant/tools` | GET | AI-01 |
| `/api/assistant/history` | GET | AI-03 |
| `/api/assistant/ask` | POST | AI-04 |
| `/api/assistant/clear` | POST | AI-05 |
| `/api/assistant/facts` (×2), `/facts/delete` | GET, POST | AI-06 |
| `/auth/passkey/register/begin`, `/complete` | POST | ST-02 |
| `/auth/settings/passkeys`, `/passkeys/{id}` | GET, DELETE | ST-02 |
| `/auth/settings/password` | POST | ST-03 |
| `/auth/settings/psn` | GET | ST-04, ST-07 (admin list → Admin) |
| `/auth/settings/psn/claim` | POST | ST-05 |
| `/api/psn/link` | POST | ST-06, PO-01 |
| `/auth/settings/mattermost`, `/unlink` | GET, POST | ST-08 |
| `/auth/settings/mcp`, `/mcp/revoke` | GET, POST | ST-09 |
| `/api/admin/check` | GET | AD-01 |
| `/api/admin/users`, `/api/admin/users/{id}/reset-password` | GET, POST | AD-05 (moved from ST-10) |

Non-fetch targets: `/api/whatsapp/export` → WA-13; `/auth/login` and `/auth/logout` → G-04; `/portal` → SQ-04, CL-28 and PO-01; `/auth/settings/mattermost/connect` (popup) → ST-08; `/api/reels/renders/{rid}/video` → CL-13; `/api/reels/clips/{id}/source` and `/frame` → CL-12, CL-07 and CL-15; LiveKit CDN → HU-01; WatchParty `socket.io.js` plus 21 socket events → WP-01, WP-06, WP-16 and WP-12.

Pollers (13 `setInterval`): AI thread 1 s tick with a 2 s fetch (AI-03); squad 30 s (SQ-04); hype 60 s (SQ-02); pipeline 30 s (CL-03, AD-02); Studio render poll 2 s (CL-21); giveaway countdown 1 s (GW-02); watch log flush 10 s and heartbeat 30 s (WP-21); watch `CMD:ts` 1 s (WP-06); control bar tick 250 ms (WP-07); speaking meter 120 ms (WP-11); host-recovery 500 ms (WP-06); history-post check 3 s (WP-20). All 13 are listed in JOURNEY.md §Inventory → Pollers.

## Gaps

1. **Portal is missing from the approved mock's nav.** DW-1.2 needs it in both nav systems. I added it to the sidebar footer group and the More sheet's Account group, labeled "Link PSN".
2. **Research lists capabilities that are not in `_DASHBOARD_TMPL`.** These are the `/clips` catalogue and filters, `/api/clips/{uid}/resend`, clip media playback, `/api/video-jobs`, `/status` and `/api/watch/event`. Each has its own inventory row (in-scope via research) with a disposition.
3. **The roast bot has no dashboard UI.** It survives only as the Chat Board `b.path` mechanism; no built-in tile uses it today. `/roast/start|stop|status` has no UI anywhere, and the Stream Deck plugin does not reference it. Disposition: `/roast/once` KEEP as a path-action tile; start/stop/status MOVE → Admin. **Owner confirmation needed (O-1).** If declined, the fallback is EXCLUDE.
4. **Latent legacy bug.** Slap `/hot` returns `{tracks:[…]}`, but the legacy code reads `items`/`hot`, so "Hot Right Now" never renders. This was verified live and is recorded on SL-06.
5. **Giveaway `lock`/`draw`/`reveal` endpoints have JS helpers but no button.** Recorded as GW-14.
6. **All 19 Slapshare endpoints were verified live** (HTTP 200, CORS `*`, 2026-09-30), and the response keys match the legacy readers except `/hot`. The plan's "unverified Slap panels out of scope" clause therefore excludes nothing today.

## Gate Status

- DESIGN.md locked? **No, and not required.** Phase 1 is Discover: inventory, job and IA. No tokens are applied and nothing is rendered.
- JOURNEY.md present? No. This phase creates it with §Inventory, §Job, §Journey and §IA.
- Prerequisites: the research doc is confirmed and the mock was approved at the checkpoint. **Met.**

## DW Verification

| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-1.1 | JOURNEY.md §Inventory lists every capability found in `_DASHBOARD_TMPL`, each with a disposition | COVERED | (a) grep counts above; (b) all 99 distinct fetch expressions map to row IDs, 0 unmapped (script); (c) all 10 panels, 13 pollers and every modal/overlay (settings modal, upload sheet, Studio dialog, cam grid, board fullscreen, orb popover, reaction tray) have rows; (d) post-write check that every row carries KEEP/MOVE/EXCLUDE and every mapped row ID exists in JOURNEY.md; (e) gesture-only capabilities table with visible equivalents (plan dirty case) |
| DW-1.2 | §IA places all 12 destinations in both the desktop sidebar and the mobile bottom-bar + More sheet, each reachable in ≤2 taps | COVERED | §IA reachability table: 12 rows × (sidebar placement, clicks) × (tab bar or More placement, taps); post-write check counts 12 destinations in each nav system and asserts max taps ≤ 2 |

**All items COVERED:** YES (2/2 DW-IDs, which matches the dispatch count of 2)

Evidence kind: this phase's artifact is a spec, so "design execution evidence" here means grep/script traceability. Contrast, render and tokens-applied evidence are **N/A this phase**: no tokens and no mock are produced.

## Design Decisions

- **JTBD school: Moesta Switch (four forces) with job-story format.** Doctrine rule "pick one school" (journey.md). The job stories use "When / I want / so I can" phrasing, but the forces analysis is Moesta's alone. No Ulwick outcome statements.
- **Journey model: loyalty loop, not a funnel.** McKinsey loyalty loop (Court et al. 2009). The squad's loop is trigger → open → act → bond → re-trigger (PSN presence, WA rally, month-end montage). Journey maps without an owner are theater (Watermark 2023). So §Journey names the owner (Moiz), the basis (brief plus code audit, no interviews) and the cadence (after each /app release).
- **IA structure: hub-and-spoke with a flat global nav.** Squad is the hub, and every destination is one level deep (Rosenfeld/Morville structures). The organization scheme is task/topic hybrid.
- **The sidebar keeps the locked research order** (Squad, Clips, Slap, WhatsApp, Giveaway, Watch, Huddle, AI Coach, Ask AI; footer Settings and Admin). Portal/"Link PSN" joins the footer utility group. I did not reorder: the research "Navigation model (locked)" pins it, and reordering would override a pinned seam.
- **The mobile tab bar stays locked** (Squad · Watch · Clips · More), placed in the thumb zone (Fitts 1954; bottom tab bar over top nav on phones, usability bridge table). The More sheet keeps the research order and adds Portal. It is grouped into "Squad" (6) and "Account" (3) to cut decision time (Hick–Hyman 1952).
- **One PSN-link flow.** Portal (`/app/portal`) is the single link wizard, and it uses `/api/psn/link`. Settings → PSN shows status and claim, and hands off to Portal for linking/relinking. This follows Nielsen #4 (consistency) and removes the duplicate inline flow. Legacy `/portal` stays untouched.
- **Settings becomes a destination with tab sub-routes, not a modal.** This follows Nielsen #3 (user control: deep links, Back works). The admin-only bits move to Admin: the Users tab and the PSN all-accounts list.
- **Admin collects ops.** It gets service health (from legacy Clips), `/status`, `/api/video-jobs`, users and PSN accounts. Task-local admin controls stay in context: giveaway admin on Giveaway, and the reels "Everyone's" scope on Clips. Admin links to them (Nielsen #6 recognition over recall).
- **Gesture-only → visible equivalent** for swipe, long-press, drag and the orb press menu. This follows WCAG 2.2 SC 2.5.7 Dragging Movements and 2.5.1 Pointer Gestures, plus Norman on signifiers (1988/2013). Gestures stay as accelerators (Nielsen #7 flexibility).
- **Watch/Huddle mini-bar extends to Huddle.** The legacy bar is Watch-only. This follows the plan constraint "mini-bar persists across routes" and Nielsen #1 (visibility of system status: you are still in a call).
- No existing tool (`palette.mjs`, `prototype`) applies to this phase.

## Recommendation

BUILD

## Appendix: Production validation (post-write)

`/tmp/p1/check.py` ran over JOURNEY.md:

- **Inventory:** 185 rows (G 12, SQ 7, CB 12, CL 32, SL 20, WA 15, GW 14, WP 23, HU 8, CO 11, AI 7, ST 11, PO 5, AD 8), 185 unique IDs, 0 duplicates. Dispositions: KEEP 163 / MOVE 13 / EXCLUDE 9. 0 rows lack a disposition, 0 EXCLUDE rows lack a reason, and 0 rows lack an endpoint cell.
- **Fetch map:** all 104 row IDs referenced by the fetch→row map exist in §Inventory. All 10 panel IDs are named in §Inventory headings.
- **Handlers:** all 113 distinct inline handler heads (`onclick` / `onchange` / `oninput`) map to rows, 0 unmapped. Delegated `data-a` / `data-act` / `data-*` actions (reels list, Studio, orb menu, reaction tray) are covered by CL-07…CL-25, WP-09 and WP-12.
- **IA:** 12 reachability rows, 0 missing placements. Sidebar max 1 click. Mobile: 3 destinations in the tab bar (1 tap), 9 in More (2 taps), max 2. All 12 nav labels appear in both the sidebar diagram and the tab bar + More diagram.
- **Sections present:** §Inventory, §Job, §Journey, §IA.

Handler → row map: `$`→AI-04; `addPasskeyFromSettings`→ST-02; `adminResetPassword`→ST-10; `adminResetSubmit`→ST-10; `aiChip`→AI-02; `aiImgClear`→AI-04; `aiImgPicked`→AI-04; `askClear`→AI-05; `askSend`→AI-04; `changePassword`→ST-03; `claimPsn`→ST-05; `closeSettings`→ST-01; `clSheet`→CL-26; `coachClearFilters`→CO-09; `coachFbComment`→CO-10; `coachFbRate`→CO-10; `coachFbSubmit`→CO-10; `coachFbTag`→CO-10; `coachSetDetail`→CO-02; `coachSetGame`→CO-09; `coachSetMode`→CO-02; `coachSetPlayer`→CO-09; `coachSetQ`→CO-09; `coachSetScope`→CO-01; `coachSetSort`→CO-09; `coachToggle`→CO-10; `connectMattermost`→ST-08; `copyMcpCfg`→ST-09; `deletePasskey`→ST-02; `disconnectMattermost`→ST-08; `document`→WA-14; `event`→WP-23; `exitOrganize`→CB-07; `factAdd`→AI-06; `factDel`→AI-06; `factRender`→AI-06; `fire`→CB-01,CB-02; `gwAddEntry`→GW-09; `gwClose`→GW-11; `gwCreate`→GW-07; `gwDrawAndReveal`→GW-11; `gwPublish`→GW-11; `gwRedraw`→GW-11; `gwRemoveEntry`→GW-09; `gwResetAndSeed`→GW-12; `gwUpdate`→GW-08; `huddleAiSend`→HU-05; `huddleJoin`→HU-01; `huddleLeave`→HU-04; `huddleMeetingNotes`→HU-07; `huddleToggleAi`→HU-02; `huddleToggleBlur`→HU-04; `huddleToggleCam`→HU-04; `huddleToggleLayout`→HU-02; `huddleToggleMic`→HU-04; `huddleToggleShare`→HU-04; `huddleToggleTranscript`→HU-06; `if`→ST-01,CL-26; `linkPsn`→ST-06; `loadCoach`→CO-11; `loadMcpStatus`→ST-09; `loadUpload`→CL-28; `openCustom`→CB-05; `psnAdvance`→ST-06; `psnPasteClipboard`→ST-06; `rally`→SQ-01; `revokeMcp`→ST-09; `sendQuick`→CB-10; `setBoardPage`→CB-04; `slapH`→SL-09; `slapRec`→SL-10; `switchTab`→ST-01; `tab`→G-02; `this`→ST-10; `toggleBoard`→CB-08; `toggleBoardFs`→CB-09; `toggleNav`→G-02; `togglePsnRelink`→ST-04; `upSend`→CL-26; `upWithdraw`→CL-27; `waDoImport`→WA-14; `waReload`→WA-01; `waSetRange`→WA-01; `wpApplyMicDevice`→WP-10; `wpApplyOutDevice`→WP-10; `wpEditNickname`→WP-17; `wpFlipCam`→WP-13; `wpFsClose`→WP-13; `wpFscSend`→WP-15; `wpFsOpen`→WP-13; `wpHistForget`→WP-19; `wpHistLoad`→WP-19; `wpHistOpen`→WP-19; `wpHistRename`→WP-19; `wpHistResume`→WP-19; `wpHistView`→WP-19; `wpMiniGoWatch`→G-08; `wpRally`→WP-18; `wpRxToggleTray`→WP-09; `wpSendChat`→WP-16; `wpSetCamVol`→WP-07; `wpSetPlayerVol`→WP-07; `wpSetVideo`→WP-04; `wpToggleCam`→WP-10; `wpToggleCamsMute`→WP-07; `wpToggleMute`→WP-10,G-08; `wpToggleOverlay`→WP-14; `wpTogglePlayerMute`→WP-07; `wpToggleStageFs`→WP-07; `wpToggleVideo`→WP-10; `wpUnblock`→WP-03; `wpUserSync`→WP-06; `wpUserTogglePlay`→WP-07

## Deviations from the mock (structure reference)

- Portal/"Link PSN" was added to the sidebar footer group and to the More sheet's Account group. The mock had 11 sidebar items and no Portal, which DW-1.2 requires.
- The sidebar and tab bar get distinct landmark labels, "Primary" and "Tab bar" (mock-review Minor carry-over; applied at the IA level).

## Open questions for the owner (carried to Phase 2)

- **O-1 Roast bot.** Should `/roast/start|stop|status|once` surface in Admin (AD-07)? If declined, the fallback is EXCLUDE, since there is no legacy UI.
- **O-2 Clip resend (CL-30).** Should it be available to all members (the endpoint is not admin-gated) or only in the admin view? The endpoint is not idempotent, so Phase 2 must specify a confirm step either way.
