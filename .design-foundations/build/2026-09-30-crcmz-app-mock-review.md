# Design Review: Phase MOCK - CRCMZ App Squad (home)

## Rendered Evidence (Step 0)
- Screenshots: `squad-1440.png`, `squad-375.png`, `squad-375-sheet-open.png` (all in `/home/opti3/services/streamdeck/crcmz-app/.design-foundations/build/`), read and critiqued as pixels.
- Surface: the Squad (home) page, wireframe fidelity. It uses greyscale tokens, no DESIGN.md is locked, and the page labels itself with a visible "WIREFRAME" banner. Three views were reviewed: desktop 3-column (sidebar, main, Chat Board aside), mobile with the bottom sheet collapsed, and mobile with the sheet open.
- DESIGN.md / JOURNEY.md: neither exists at the project root, so there was no token or page-spec contract to check against. Only the mock's own `:root` tokens were checked.

## Assessment B — Deterministic Detector
- Command: `node /home/opti3/.claude/plugins/cache/rtd/design-for-ai/4.2.0/scripts/detect.mjs /home/opti3/services/streamdeck/crcmz-app/.design-foundations/build/squad.html > /home/opti3/services/streamdeck/crcmz-app/.design-foundations/build/detect.json`
- Exit: 0 (ran)
- Findings: 11, all `nested-cards` (high). They hit `.logo`, `.icon-btn`, `.meter`, 7x `.avatar` and `.tabs`.
- Opened only after Assessment A findings were frozen: YES

## Triage
- Baseline (always-on): visual (design-dna + checklists + ai-tells distinctiveness) and usability (Nielsen 10, severity 0-4).
- Dispatched: none beyond the baseline. The surface has number tiles and a hype meter, but they are single KPI values, not charts. So `data-viz` got only a light touch inside the visual baseline and no full load.
- Not applicable: `content-design` (the copy is mostly placeholder/bracket labels at wireframe fidelity), `journey` (one page, no sequence), `behavioral`/`deceptive-patterns` (no conversion mechanics).
- Deferred: none.

## Cross-Pillar Findings (ONE ranked report)
| Severity | Pillar | Problem (in the rendered pixels) | Principle | Fix |
|----------|--------|----------------------------------|-----------|-----|
| Major | usability | At 375px, the collapsed Chat Board peek (~120px) plus the tab bar (64px) take about 23% of the 800px viewport. Above the fold, the "Who's on" list, the page's core content, shows only 1.5 rows. Nothing is lost: `main` has `padding-bottom: 220px`, so every row can be scrolled to. But the primary job ("who is on right now") is pushed below the fold by chrome. | Nielsen #8 aesthetic and minimalist design; visibility of primary content (information scent) | Shrink the collapsed peek to handle + composer only, or drop the descriptive "Chat Board — tap or swipe up…" line once learned. Or move the hype card below "Who's on" on mobile. |
| Minor | usability / visual | The composer input border (`--border` #bdbdbd) against the board surface #f5f5f5 is about 1.7:1. The white input fill against #f5f5f5 is about 1.1:1. The field boundary is below the 3:1 non-text contrast minimum. The same token is used for stat-tile and tab-group outlines on white (about 1.9:1). | WCAG 2.2 SC 1.4.11 non-text contrast (3:1 for component boundaries) | Use `--border-strong` (#9e9e9e is about 2.7:1, still short) or a darker token about #767676 (4.5:1) for input and interactive outlines. Keep #bdbdbd only for decorative dividers. |
| Minor | content / usability | The composer placeholder truncates to "Send a quick message to the" at both 375 and 1440, so the hint is cut mid-phrase. | Nielsen #6 recognition over recall; truncation hides the affordance meaning | Shorten it to "Message the squad…". |
| Minor | usability | The open mobile sheet covers the page with no scrim, and the content behind it stays visually "live". It is ambiguous whether the page behind can be interacted with. | Nielsen #1 visibility of system status (modal state) | Add a light scrim when the sheet is open, and tap the scrim to collapse. |
| Minor | visual / data | The hype meter shows 68% fill with no visible scale or max. "137 messages today" does not say what "full" means (the max of 200 exists only in `aria-valuemax`). | Tufte, data-ink ratio / graphical integrity: an encoding without a reference point cannot be read | Add a visible end label or threshold tick (e.g. "200 = max hype") once the metric is defined. |
| Minor | usability (a11y) | Both `<nav>` landmarks are `aria-label="Main"`. They are mutually exclusive via `display:none`, so this does no harm now. The handle has `aria-controls="board"` while sitting inside `#board`. | WAI-ARIA landmark uniqueness; Nielsen #4 consistency | Label them "Primary" and "Tab bar", and point `aria-controls` at the collapsible inner region. |
| Minor | usability | Desktop sidebar links are 40px tall. That is fine for a pointer but just under the `--tap` 44px token the mock defines for itself. | Fitts's law; internal token consistency (Nielsen #4) | Use `min-height: var(--tap)` for consistency. |
| Note | detector | `nested-cards` x11. Evidence (verbatim, representative): "<div class=\"avatar\"> is a card inside a card ancestor"; "<div class=\"logo\"> is a card inside a card ancestor"; "<div class=\"meter\"> is a card inside a card ancestor"; "<div class=\"tabs\"> is a card inside a card ancestor"; "<button class=\"icon-btn\"> is a card inside a card ancestor". Register justification: none of these are cards. They are bordered primitives (avatar circles, a progress-meter track, a segmented control, an icon button, a logo placeholder), and wireframe convention outlines every element. The pixels show no card-in-card stacking. The stat tiles and the list container are sibling boxes, not nested. | ai-tells.md nested-cards (detector); resolved via the severity model as register-justified | No action at wireframe. In the styled pass, make sure avatars and meters carry no card-style border + radius + surface combination. |
| Note | visual (distinctiveness) | There is no nameable aesthetic direction on the pixels. It is greyscale system-ui throughout. This is the declared fidelity: the banner and the HTML comment state that the "neon arcade" identity is not applied and that no DESIGN.md exists. The direction is nameable ("neon arcade"), and the `[neon: cyan/magenta/lime/violet]` slots show where it lands. Some structural choices are non-generic: a persistent soundboard Chat Board as a third column / bottom sheet, and the product voice "YES. WE HAVE ONE." | ai-tells.md CHECKER mode, applied at wireframe register | Not blocking for a wireframe checkpoint. The styled mock MUST be re-reviewed for distinctiveness, and a greyscale-generic styled pass would fail. |

Positives observed, used as evidence for DW-MOCK.2:
- Clear responsive restructure: sidebar becomes a 4-tab bar with "More", and the right aside becomes a bottom sheet.
- Online/offline status is not carried by color alone. There is a dot plus an "Online" / "Last seen" label, and offline rows are dimmed (WCAG 1.4.1).
- Consistent 2-column soundboard grid with 64px targets.
- The current page is marked with `aria-current` and a filled state.
- Semantic landmarks: nav/header/main/aside/section with labelled h2s; the tablist and meter carry ARIA roles.

## Requirement Fulfillment
### DW-MOCK.1
PREMISE:  "the mock renders a viewable surface for the named page(s) — the Squad (home) page at 375px and 1440px."
EVIDENCE: `squad-1440.png` renders the full desktop Squad page: sidebar nav, "Squad" h1 with the "4 of 7 online" status, hype + 3 stat tiles, 7-row "Who's on" list, and the Chat Board aside with tabs, an 8-button soundboard and a composer. `squad-375.png` renders the mobile Squad page: sticky header, stacked tiles, list, collapsed sheet and tab bar. `squad-375-sheet-open.png` shows the sheet's expanded state. There are no broken layouts, overflow, or clipped regions beyond intentional ellipsis.
VERDICT:  PASS

### DW-MOCK.2
PREMISE:  "text/interactive contrast and applied tokens hold on the rendered pixels (styled), or wireframe structure is sound (wireframe)."
EVIDENCE: The fidelity is wireframe (banner, HTML comment, greyscale tokens), so the wireframe clause applies. Structure is sound: a clear hierarchy (h1, then section h2s, then row names), the same information set at both breakpoints with appropriate re-layout, 44px `--tap` token on mobile controls, and semantic landmarks. Text contrast holds as a bonus: #212121/#fff is about 16:1, #616161/#fff about 6.2:1, #616161/#f5f5f5 about 5.7:1, and #fff/#424242 about 10:1. The weaknesses are the Major fold-crowding issue at 375 and the Minor non-text border contrast. They are polish and density issues, not structural unsoundness.
VERDICT:  PASS

**All requirements met:** YES

## Notes (non-blocking)
- No DESIGN.md/JOURNEY.md exists, so token adherence was checked only against the mock's own `:root`, which it applies consistently (no stray hex outside the tokens).
- Distinctiveness is deferred to the styled pass by declared fidelity. It is a hard gate there.
- Detector `nested-cards` hits are false positives at this register (see the table).
- Mobile keeps the full game line inside `.who` while desktop moves it into its own column. The duplicate DOM text is hidden with `display:none`, so screen readers do not hear it twice.
- Chat Board soundboard buttons carry placeholder `[neon: …]` sublabels. Make sure the final buttons do not rely on hue alone to tell the sounds apart.

**Verdict: PASS**
