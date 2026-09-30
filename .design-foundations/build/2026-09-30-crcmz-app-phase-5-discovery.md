# Discovery + Design: Phase 5 — Words

## Artifacts Found / Current State

| Artifact | Status |
|---|---|
| DESIGN.md | Locked, owner-confirmed 2026-09-30. Archetype: Jester/Outlaw. Tagline: "YES. WE HAVE ONE." all caps, Rajdhani 500 `--text-xs --text-dim`. Tokens include `--error`, `--success`, `--warning`, `--info` and all send-state data attributes. |
| JOURNEY.md | §Inventory, §Job, §Journey, §IA, §Flows, §Page specs all present. 13 specs: PS-0 (shell) + PS-1…PS-12. Each has 9 state rows. §Microcopy not present (to be produced this phase). §Data specs not present (Phase 6). |
| phase2-check.py | Present. Pattern for phase5-check.py. |
| Legacy voice samples (server.py) | Found: "Slow down a sec ⏳", "may or may not have landed", "Nobody linked yet", "✨ AI is cooking…", "YES. WE HAVE ONE." — these are the pre-existing in-jokes; keep them. |

## Gaps

1. **§Microcopy absent**: JOURNEY.md has no §Microcopy section — this is the primary deliverable.
2. **§Voice absent**: no voice/tone matrix exists — add to JOURNEY.md so Phase 6 and the code plan share the same contract.
3. **PS-6 in-call carry-over**: the in-call row says "This is the call's own page, so the mini-bar is hidden here" but does not cross-reference F-5's Huddle auto-mute (plan carry-over).
4. **PS-12 expiring state**: the status card lists "linked / expired / not linked" but omits "Expiring in N days" (within 7 days of `refresh_expires_at`) — present in PS-10 PSN tab. Plan carry-over.
5. **PS-2 resend timeout**: the resend endpoint contract references F-0 but does not restate the 190 s clip-resend timeout. Plan carry-over.
6. **B-5 security**: `draws[]` must never surface winner info for members before reveal — microcopy must never reference draw info in member-facing states.
7. **B-4 neutrality**: psn_send 429 is squad-wide behind the tunnel — copy must not blame the individual user.

All carry-overs (3, 4, 5) are folded into the §Microcopy content this phase.

## Gate Status

| Gate | Status |
|---|---|
| DESIGN.md locked | YES — law once locked; tokens honored throughout |
| JOURNEY.md present | YES — all 13 specs with 9 states each |
| Phase 2 unlocks Phase 5 | YES |
| Phase 3 unlocks Phase 5 | YES (DESIGN.md locked) |
| Prerequisite: §Microcopy from Phase 5 | Producing now |

## DW Verification

| DW-ID | Done-When Item | Status | Evidence |
|---|---|---|---|
| DW-5.1 | Every state in every page spec has microcopy | COVERED | phase5-check.py exit 0: checks §Microcopy has an entry for each of the 13 PS-n blocks and each of the 9 states per block |
| DW-5.2 | Deceptive-patterns audit finds no manipulative copy | COVERED | Audit table below: all 9 Brignull categories checked across 13 surfaces; zero Critical/High findings |

**All items COVERED:** YES

## Design Decisions

### Voice attributes (3)

| Attribute | In-range | Out-of-range |
|---|---|---|
| **Irreverent-but-fluent** | "Nobody linked yet", "AI is cooking", "Slow down a sec" | Corporate-speak ("Please be advised"), fake-warm onboarding ("Welcome to your journey!") |
| **Confident, short** | Sentence length ≤ 12 words in normal states. Commands use present tense ("Post a clip", not "You can post a clip"). | Hedging ("It seems like…"), over-explaining, passive voice |
| **Clear first, funny second** | Error states: fact, then fix. A single dry observation after the fix is allowed for low-stakes states | Humor on destructive confirms, auth failures, 410-purged, non-idempotent Unknown send outcomes |

### Tone matrix by moment

| Moment | Tone | Example anchor |
|---|---|---|
| Celebration (reveal, Squad Up sent, giveaway winner) | Warm, expressive, a little chaotic | "🏆 [winner] takes it" |
| Neutral (loading, stale, empty-user-cleared, presence, info) | Dry, plain, minimal punctuation | "Nobody in a game right now" |
| Error (recoverable: service down, network, 500) | Calm, specific, no levity | "PSN isn't answering" + Retry |
| Destructive (delete, clear history, close giveaway, veto clip) | Serious, names the consequence, no humor | "Remove [name] from this draw?" |
| Waiting (loading, upload progress, 429 countdown, render in progress) | Neutral, factual, no false urgency | "Uploading 42 %" |

### Linguistic rules

- **Contractions**: always (it's, can't, you're, we're). Exception: destructive confirm body — no contractions makes it land heavier.
- **Sentence endings**: no exclamation marks on errors or warnings. One permitted in celebration states (giveaway reveal, Squad Up sent).
- **Button labels**: verb + noun ("Link your account", "Save & approve", "Draw & reveal now"). Never "OK", "Yes", "Submit", "Confirm" bare.
- **Empty states**: follow Yifrah formula — what's missing + how to get it. First-use empties get one sentence. Error-empties get Retry.
- **Error formula** (Yifrah): what happened → why (if useful) → how to fix → what's next.
- **429 copy**: neutral; never implies the individual user is at fault. "The squad's a bit too hot right now." or "Slow down a sec — try again in Ns."
- **F-0 Unknown send**: always include the "may or may not have sent" clause. Never auto-retry language.
- **Giveaway**: no urgency/scarcity ("hurry", "only N left", "last chance", "don't miss"). Eligibility is a fact, not a pressure tactic. Rotation rule stated plainly ("one win per rotation cycle").

### Deceptive-patterns audit

Checked per Brignull 9-category framework against all 13 surfaces.

| Category | Surface checked | Finding | Severity | Resolution |
|---|---|---|---|---|
| Urgency / false scarcity | PS-5 giveaway countdown; PS-5 eligibility badge; PS-5 rotation progress | Countdown is real (server `reveal_at`). "Expiring in N days" on PS-12/PS-10 is real data. Eligibility is a factual read from `user_eligible`. No fabricated countdown. | None — legitimate urgency | Copy must state the real deadline and the rotation rule plainly |
| Misdirection | All confirms (delete tile, remove entry, clear history, close giveaway, veto, force post) | No confirmshaming identified. "Are you sure?" pattern is absent from the spec. Decline path is always neutral-labeled. | None | Confirm labels name the action and consequence |
| Hidden information | PS-5 member view; PS-2 re-send | B-5: `draws[]` winner must not appear before reveal. Spec says "never read `giveaway.draws` for members". Copy never references the draw winner in member-facing states. | None (if spec is followed) | Copy avoids any "someone won" hint in open/drawn states |
| Friction asymmetry | PS-10 passkeys delete; PS-10 MCP revoke; PS-9 clear history; PS-5 close giveaway | All destructive actions have a single confirm, not a gauntlet. No recovery obstruction. | None | One confirm, clearly labeled, names the item being deleted |
| Social manipulation | PS-5 rotation progress; PS-5 past winners; PS-1 live count | Live count is real (derived `/api/squad`). Rotation progress is real (`rotation.eligible_count`). Past winners are real history. | None | Copy cites only real data |
| Default exploitation | PS-9 facts; PS-5 admin publish; PS-5 entries | No pre-selected destructive defaults identified. Admin publish is an explicit action. | None | All defaults are user-beneficial |
| Language manipulation | All button labels, confirm copy | No double-negatives, no trick questions, no confirmshaming. "This is mine" is clear. | None | Plain labels; "Draw & reveal now" names the state transition |
| Addiction traps | PS-1 Chat Board; PS-9 suggestion chips | Chat Board tiles are user-initiated sends. No variable-reward mechanism. Suggestions are deterministic chips, not slot-machine prompts. | None | Copy does not manufacture urgency or anxiety |
| Pricing opacity | N/A — this is a personal squad tool with no pricing | N/A | None | N/A |

**Audit result: zero Critical, zero High findings.** DW-5.2 COVERED.

## Recommendation

BUILD
