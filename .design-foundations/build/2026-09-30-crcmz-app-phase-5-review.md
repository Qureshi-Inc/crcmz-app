# Design Review: Phase 5 — Voice & Microcopy

**Date:** 2026-09-30
**Worktree:** `.claude/worktrees/crcmz-app-design`
**Reviewer stance:** Independent. Did not produce this spec.

---

## Rendered Evidence (Step 0)

- Screenshot: none — no rendered artifact for this phase (spec-level review only)
- Surface: JOURNEY.md §Voice and §Microcopy (MC-PS-0 through MC-PS-12), cross-referenced against §Page specs PS-0 through PS-12

---

## Assessment B — Deterministic Detector

- Command: `node scripts/detect.mjs` — not run
- Exit: 3 N/A (no rendered HTML artifact)
- Findings: N/A — no rendered artifact
- Opened only after Assessment A findings were frozen: YES (not applicable — no file to open)

**Checker run (phase5-check.py):**

```
python3 .design-foundations/build/phase5-check.py JOURNEY.md
```

Output (abridged):
```
§Microcopy blocks found: ['MC-PS-0' ... 'MC-PS-12']
DW-5.1: MC-PS-0 through MC-PS-12: states 9/9  OK (all 13 blocks)
DW-5.2a: banned button labels: OK — no banned labels
DW-5.2b: urgency/scarcity in Giveaway (MC-PS-5): OK — no urgency/scarcity phrases
§Voice section: OK
§Microcopy blocks: 13/13
PASS
```

Checker negative test (`--mutate`): confirmed — dropping one state row from MC-PS-1 produced `states 8/9 FAIL`. The checker is sensitive to missing states.

---

## Triage

- Baseline (always-on): usability (button/label operability)
- Dispatched: **content-design** (all copy is microcopy — voice, errors, empty states, CTAs, confirmations); **deceptive-patterns** (giveaway mechanics, confirmations, rotation copy)
- Not applicable: data-viz, journey, behavioral (no new conversion or funnel mechanics), design-dna/checklists (no rendered surface)
- Deferred: none

---

## Cross-Pillar Findings (ONE ranked report)

| Severity | Pillar | Problem | Principle | Fix |
|----------|--------|---------|-----------|-----|
| Major | content-design | MC-PS-2 re-send confirm: "Clip re-sends are not idempotent — it will appear again even if it was already sent. Timeout is 190 s." The phrase "not idempotent" is developer jargon; "Timeout is 190 s" is an implementation parameter. Both appear in a modal the admin reads before confirming a destructive-adjacent action. The plain-English clause "it will appear again even if it was already sent" already carries the necessary meaning. Requirements explicitly list "timeouts" as implementation detail not for user copy. | Metts & Welfle (*Writing Is Designing*, 2019): every word in a UI is a design decision, and technical vocabulary not shared by the reader creates friction, not clarity. Richards: content design starts with the user's need, not the system's internal model. | Drop "not idempotent — " entirely. Replace "Timeout is 190 s" with "The send can take up to 3 minutes." Revised copy: "Re-send '{title}' to the Goopers group? It will appear again even if it was already sent. The send can take up to 3 minutes." |
| Minor | content-design | MC-PS-12 Step ③ instruction: "Copy the `` `npsso` `` value and paste it here." The backtick-formatted token `` `npsso` `` is code/markdown notation in a UI copy string. Unless the template is markdown-rendered, this appears as literal backtick characters to the user. | Redish (*Letting Go of the Words*, 2007): use the user's vocabulary, not internal terminology. Code formatting is developer documentation style, not UI instruction style. | Replace with: "Copy the NPSSO value and paste it here." The textarea label "NPSSO token" already anchors the term; backtick formatting is redundant and may render literally. |
| Minor | content-design | MC-PS-11 (Admin) Users 502/503: "Zitadel didn't answer" — the internal identity-provider brand name appears in user-visible error copy. Even admin users may not know Zitadel is the auth backend. | Richards: start with user need — the admin needs to know what to do, not what vendor failed. Nielsen #9 (error recovery): errors should describe the problem in user terms. | Replace with: "Sign-in service didn't answer" [Retry]. If the admin genuinely needs the vendor name for support escalation, append it in parentheses: "Sign-in service didn't answer (Zitadel)." |
| Minor | content-design | MC-PS-4 (WhatsApp) forbidden state: "You're not allowed to import — ask Moiz." A specific personal name is hardcoded in a UI string. The Admin panel (PS-11) uses role-based language ("Admins only") consistently. This is inconsistent and brittle — the right person to ask is the role, not the individual. | Podmajersky (*Strategic Writing for UX*, 2019): terminology agreement across product surfaces. Nielsen #4: consistency and standards — same concept should use same language across the product. | Replace with: "You're not allowed to import — ask an admin." |

---

## Requirement Fulfillment

### DW-5.1

```
PREMISE:  every state in every page spec has microcopy
EVIDENCE: phase5-check.py confirms 13/13 MC-PS blocks present (MC-PS-0 through
          MC-PS-12), each with 9/9 states (loading, empty, error, stale, 429,
          signed-out, forbidden, 410-purged, in-call). Spot-checks of 4 blocks:
          MC-PS-1 (Squad): all 9 states — loading (skeleton, badge hidden),
            empty (three sub-cases with copy), error (two error surfaces + silent
            hype), stale (header timestamp), 429 (countdown copy, neutral framing),
            signed-out (banner + tile 401 toast), forbidden (N/A), 410-purged (N/A),
            in-call (call chip in handle row).
          MC-PS-2 (Clips): all 9 states — loading (Studio + render-in-progress),
            empty (reels, month-0, uploads, filter-no-results), error (6 error
            surfaces with specific copy), stale (header timestamp), 429 (N/A),
            signed-out (resume logic), forbidden (PSN-link gate + admin gate),
            410-purged (player replaced + "Media cleared after the 14-day retention"),
            in-call (muted players + unmute button).
          MC-PS-5 (Giveaway): all 9 states — stale state specifically covers
            reveal-overdue with "The reveal is on its way." (neutral, no mutation
            implication). Admin tools cover lifecycle states explicitly.
          MC-PS-9 (Ask AI): all 9 states — error state names the AI offline reason;
            429 shows countdown with draft kept; stale state shows pending-bubble
            copy. Negative test (--mutate) verified checker sensitivity.
VERDICT:  PASS
```

### DW-5.2

```
PREMISE:  deceptive-patterns audit finds no manipulative copy
EVIDENCE: Checker confirmed: no banned button labels ([OK], [Yes], [Submit],
          [Confirm]) anywhere in §Microcopy. No urgency/scarcity phrases (hurry,
          "only N left", "last chance", "don't miss") in MC-PS-5 (Giveaway).

          Manual deceptive-patterns audit against all 9 Brignull categories:

          1. Urgency & false scarcity: Giveaway copy shows a real reveal countdown
             ("Reveal in {n} hours and {n} minutes") sourced from reveal_at — not a
             client-resettable timer. No "hurry", no stock claims. CLEAR.
          2. Misdirection / confirmshaming: decline options in confirms are plain
             "Cancel" (the correct neutral form per microcopy-patterns.md). No
             self-deprecating decline framing anywhere. CLEAR.
          3. Hidden information: Giveaway rotation rule is exposed ("Everyone wins
             once before anyone wins twice.") on hover/tap of the eligibility badge.
             Eligibility states are honest even when user is ineligible. CLEAR.
          4. Friction asymmetry: No asymmetric cancel/sign-up flows. MCP revoke,
             giveaway close, passkey delete all have one-step confirms with plain
             Cancel escape. CLEAR.
          5. Social manipulation: No fake social proof. "Cycle {n} · {eligible_count}
             of {total_members} still eligible" shows real counts. CLEAR.
          6–9. (Sneaking, Forced action, Disguised ads, Nagging): not applicable
             to this product surface; no ads, no auto-enrolment, no persistent
             pop-ups. CLEAR.

          Giveaway rotation rule copy is fair: "One win per rotation cycle" and
          "Everyone wins once before anyone wins twice" state the mechanic plainly
          and without pressure.
VERDICT:  PASS
```

---

## Edge Case Verification

### Edge case 1 — PSN sends not idempotent

```
PREMISE:  A transport failure must tell the user it may or may not have sent,
          and must not auto-retry.
EVIDENCE: MC-F0 Unknown state (fires on network/timeout/500/502):
          Button label: "Unknown"
          Toast: "The send may or may not have landed. Keep the draft so nothing is lost."
          — Explicitly contains "may or may not have landed" ✓
          — Directs user to keep the draft (implicit: do not retry automatically) ✓
          — No auto-retry language anywhere in MC-F0 ✓

          The re-send confirm (MC-PS-2) is a separate scenario: an admin
          deliberately re-sending a clip (not a transport failure). Its copy
          "it will appear again even if it was already sent" correctly warns that
          this action is not idempotent when the admin chooses to fire it. This
          is distinct from the edge case (which concerns transport failures).
VERDICT:  PASS
```

### Edge case 2 — Rendering never mutates

```
PREMISE:  The giveaway reveal copy must not imply the page triggers the reveal.
EVIDENCE: MC-PS-5 stale state: "The reveal is on its way." — This is a
          neutral status observation. It describes an async job in progress;
          no implication that the page loading caused or will cause the reveal.
          
          Member view Drawn state: "{title} · 🎁 {prize} · Winner reveal in"
          — Shows a countdown to a future reveal time set by the admin, not
          by the page load.
          
          Member view Revealed state: "🏆 {winner_name} · 🎁 {prize}"
          — Displays the outcome; no copy that implies viewing triggered it.
          
          Admin actions "Draw & reveal now" and "Reveal now" are explicit
          user-triggered actions with confirm dialogs. The copy "Draw a winner
          and reveal immediately" correctly attributes the action to the admin,
          not to page rendering.

          No member-facing copy implies the page itself triggers a draw or reveal.
VERDICT:  PASS
```

---

## Voice Quality Assessment

The §Voice section (JOURNEY.md lines 1497–1545) is a complete language system (Podmajersky): voice attributes with in-range and out-of-range expressions, a tone matrix by moment type, explicit do/don't pairs, and linguistic rules covering contractions, active voice, sentence length, exclamation mark budget, and the 429 / Unknown / giveaway special cases.

The copy in §Microcopy carries this voice. Specific evidence:

**Voice-marked copy (sample):**
- "Nobody linked yet" — dry, specific, no hedging ✓
- "PSN isn't answering" — casual, direct; not "An unexpected error occurred" ✓
- "✨ AI is cooking…" — in-joke explicitly preserved in spec ("legacy in-joke; keep") ✓
- "Sign in to keep up" / "Sign in to build it" — imperative, zero corporate fluff ✓
- "Slow down a sec — try again in {n}s." — "sec" is the voice token; 429 is neutral per spec ✓
- "It knows the squad — clips, scores, vibes. It can look things up but never acts." — concise, specific, no buzzwords ✓
- "Everyone wins once before anyone wins twice." — plain statement of a fair rule ✓
- "The send may or may not have landed. Keep the draft so nothing is lost." — appropriately serious for an ambiguous outcome; no corporate hedging ✓

**Tone matrix adherence:**
- Error states: calm, specific, no levity where required ("Huddle isn't set up on this server.", "Couldn't connect to the call")
- Destructive confirms: no contractions in body copy where the spec mandates them removed ("Draw a winner and reveal immediately. This cannot be undone.") ✓
- Celebration: one exclamation mark used judiciously ("You won! 🏆") ✓
- 429 neutral framing: "Slow down a sec — try again in {n}s." — no fault implied ✓

The copy is not generic. The product-specific vocabulary (Squad, Huddle, Watch Party, PSN, reels, clips, the Mac at home) and the irreverent register are consistent with the stated brand voice. No AI-default copy patterns detected ("Welcome to...", "Your all-in-one solution", etc.).

---

## Notes (non-blocking)

**Pixel-level evidence:** No screenshot available — this is a spec-level artifact only. Voice quality and deceptive-pattern findings are derived from the spec text. Implementation-layer rendering of these strings (e.g. whether backticks render literally) is unverified until a rendered surface exists.

**MC-PS-9 error, "it runs on the Mac at home":** This surfaces the infrastructure detail that the AI runs on a local machine. For a 10-friend private product where the voice is "chaotic, proud to be weird", this is likely intentional character — the group knows the setup. Flagged as a note rather than a finding because the audience context justifies it and the voice spec does not prohibit it. If the product scales or the infrastructure changes, this copy would need updating.

**MC-PS-4 "ask Moiz" in forbidden:** Also appears in the Admin tools shortcut "WhatsApp import" (PS-11), which routes to the same import capability. The role-based "Admins only" language in Admin forbidden copy (PS-11) and "ask an admin" would be the consistent form. Escalated to Minor finding rather than Note because PS-11 already uses "Admins only" as the consistent pattern.

**MC-F0 block:** Checker does not cover MC-F0 (send outcome toasts) because it is not a PS-numbered block — it is a cross-cutting flow spec. Manual verification confirms it covers all 5 send states (Sending, Sent, Not sent 400-range, Not sent 503, Slow down 429, Unknown) with distinct copy for each. The "Slow down · {n}s" button label and "Slow down a sec" toast are voice-consistent and state-specific. No gap found.

---

## Issues (if FAIL)

Not applicable — verdict is PASS.

---

**All requirements met:** YES (DW-5.1 PASS, DW-5.2 PASS, both edge cases PASS)

**Verdict: PASS**

Findings ranked by severity:
- **Major (1):** implementation details in MC-PS-2 re-send confirm ("not idempotent", "Timeout is 190 s")
- **Minor (3):** backtick notation in MC-PS-12 instruction; "Zitadel" backend name in MC-PS-11 error; hardcoded personal name in MC-PS-4 forbidden copy
- **Notes (2):** "Mac at home" infrastructure detail; "ask Moiz" consistency note (escalated to Minor above)
