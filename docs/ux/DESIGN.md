# Design

Tokens live in `frontend/src/styles/tokens.css`; global foundations in `global.css`. Both
are short on purpose — the thing being escaped is the legacy dashboard's 1,050 lines of
global CSS.

## What was wrong with the old look

Not that it was ugly. It was built as a splash page and then asked to be somewhere people
sit and read a table of who is online.

* **Neon as surface colour.** `#ff2fd6`, `#22e6ff`, `#9d5cff`, gold, lime and cyan all
  appeared as structural colour on one screen, plus gradient text and glowing borders.
  Nothing was emphasised because everything was.
* **760px in a 1440px window.** Roughly half the viewport was empty on every screen.
* **The Chat Board was always there.** ~350px parked at the bottom of every screen,
  including ones where it made no sense, and sitting on top of the Ask AI composer. The
  legacy code even had a workaround: `loadAsk()` force-collapsed the board because
  otherwise it covered the ask box.
* **A dropdown for primary navigation**, so no screen showed you where you were or what
  else existed.
* **Operator detail first.** The Clips screen opened with a table of service versions and
  ping times.
* **No type scale.** Hierarchy came from weight and colour, not size.

## Colour

Four neutral dark surfaces carry the layout. One accent carries action. Everything else in
the palette means something specific.

```
--color-surface-base  #08060f   the page
--color-surface-1     #100c1c   cards, the sidebar
--color-surface-2     #181327   raised: inputs, hovered rows
--color-surface-3     #221a35   popovers, dialogs, active states
```

Anything that needs to sit above something else moves one step up the ramp. It does not get
a glow or a new colour.

Two magentas, not one, because the same hue cannot do both jobs:

```
--color-accent        #cf2aa8   a filled surface — its label sits on top of it
--color-accent-text   #ff9ce6   accent-coloured text — it sits on a dark surface
```

The accent started at the brand's `#e838bd`. That measures **3.66:1** against white, below
the 4.5:1 that WCAG 1.4.3 requires, and axe flagged it on every screen with a primary
button. It is darkened until white passes. Hover goes *darker* still rather than brighter,
which is the only direction that improves contrast here.

State colours are reserved and each means one thing — `--color-live` is online or
connected, `--color-warn` is a caution or stale data, `--color-danger` is destructive or
failed. They are never used decoratively, and colour is never the only signal: the presence
dot always sits beside the word "Online" or a last-seen time.

### Measured contrast

Computed from `tokens.css` by `node tests/browser/contrast.mjs`, which fails if any pair is
short. These are measurements, not estimates — two of them were wrong when first written by
hand, which is why the script exists.

| Pair | Ratio | Needs |
|---|---|---|
| body text on the page | 18.04:1 | 4.5 |
| body text on a card | 17.25:1 | 4.5 |
| body text on a raised surface | 16.21:1 | 4.5 |
| body text in a dialog | 14.85:1 | 4.5 |
| secondary text on the page | 9.18:1 | 4.5 |
| secondary text on a card | 8.77:1 | 4.5 |
| secondary text on a raised surface | 8.25:1 | 4.5 |
| labels and timestamps on the page | 5.56:1 | 4.5 |
| labels and timestamps on a card | 5.32:1 | 4.5 |
| labels on a raised surface | 5.00:1 | 4.5 |
| accent text on the page | 10.69:1 | 4.5 |
| accent text on a card | 10.22:1 | 4.5 |
| accent text on the selected nav tint | 9.26:1 | 4.5 |
| label on a primary button | 4.62:1 | 4.5 |
| label on a hovered primary button | 5.75:1 | 4.5 |
| live/online text on a card | 12.62:1 | 4.5 |
| warning text on a card | 13.34:1 | 4.5 |
| danger text on a card | 8.82:1 | 4.5 |
| info text on a card | 11.54:1 | 4.5 |
| the focus ring against the page | 10.69:1 | 3 |
| the focus ring against a card | 10.22:1 | 3 |
| the online dot against a card | 10.01:1 | 3 |
| the accent bar against a card | 4.17:1 | 3 |
| the accent bar against a raised surface | 3.59:1 | 3 |

`--color-fg-subtle` at 5.00:1 on a raised surface is deliberately the quietest step used
for text. Anything quieter than that is decoration and must not be the only thing carrying
information.

## Typography

System stack: nothing to download, correct on every platform, and the legacy build already
depended on it for body text. Orbitron survives only for the wordmark and for numerals in
stat tiles, where fixed width actually helps.

| Token | Size | Used for |
|---|---|---|
| `--text-2xs` | 11px | badge text only |
| `--text-xs` | 12px | timestamps, captions |
| `--text-sm` | 14px | secondary text |
| `--text-base` | 16px | body |
| `--text-lg` | 18px | card headings |
| `--text-xl` | 22px | section headings |
| `--text-2xl` | 28px | page title |
| `--text-3xl` | 36px | large numerals |

**Use `text-sm`, not `text-[var(--text-sm)]`.** Tailwind cannot tell a length from a colour
inside `var()`, so the arbitrary form compiles to `color: var(--text-sm)` — the font size
vanishes *and* the invalid value makes `color` fall back to `inherit`, silently overriding
whatever colour the component set. This was live across the whole app before the axe scan
caught it. Tailwind generates the named utilities from the `@theme` tokens, so there is no
reason to reach for the arbitrary form.

## Layout

```
--content-width       1200px   ordinary screens
--content-width-wide  1440px   media grids (Clips)
--content-width-read   760px   conversation and forms (Ask AI, Settings, Giveaways)
--sidebar-width         244px
--mobile-nav-height      60px
--tap-target             44px
```

Width is a per-screen decision. The 760px measure survives where it belongs — a long line
of prose or a form is hard to read wide — but it is no longer imposed on a table of seven
people in a 1440px window.

`--tap-target` is 44px as a **product comfort target**, not a WCAG minimum. WCAG 2.2's
2.5.8 asks for 24px; 44px is what actually feels right under a thumb.

Safe-area insets are resolved once into `--safe-top/bottom/left/right` and every fixed
element adds them rather than guessing. That is what keeps a composer or a Leave button off
the home indicator.

## Navigation

**Desktop:** a persistent sidebar. It shows where you are and what else exists, which a
dropdown cannot.

**Mobile:** a bottom bar of Home · Watch · Clips · More, with More opening a sheet that
lists Huddle, Music, WhatsApp, Giveaways, Settings and Admin by name. Nothing is reachable
only by a gesture — the legacy personal board was behind an undiscoverable horizontal
swipe, and it is a labelled tab now.

That ordering is the execution plan's starting assumption, not a finding. There is no usage
data behind it. Revisit it once there is.

Routes marked "classic" (Watch, Huddle) are tagged in the nav, so it is visible before you
click that they hand off to the old interface.

## Patterns

Every screen composes the same small set. The point is that no screen gets to invent its
own answer to "what does a failure look like here".

| Pattern | Where | Rule it enforces |
|---|---|---|
| `SkeletonRows` / `SkeletonTiles` | loading | Shaped like the content, and the *right height* — a placeholder of the wrong geometry is a layout shift with extra steps. |
| `EmptyState` | no results | Explains why it is empty and offers the next action. Never looks like an error. |
| `ErrorState` / `SectionError` | failure | Never a dead end. Retry that retries; no Retry on a 403, because it would fail again; `Retry-After` surfaced on a 429. |
| `StaleNotice` | a failed refresh | Keeps the data already on screen and labels it, rather than blanking a working page. |
| `Freshness` | any polled data | "Updated 2m ago", so nobody has to guess. |
| `Button` with `pending` | any write | Disables and sets `aria-busy` — but the caller still guards the mutation, because a disabled button is not proof of one request. |
| `ConfirmDialog` | anything irreversible | The confirm label says what happens — "Draw the winner", never "OK". |
| `Modal` / `Drawer` | overlays | Radix: focus trapped and restored, Escape, `aria-modal`, background inert, and a required accessible name. |

### Why Radix rather than hand-rolled overlays

The requirement list for a dialog — trap focus, restore it to the trigger, Escape, make the
background inert, label it, hide it from the accessibility tree while closed — is a list of
things that are each easy and collectively never finished correctly by hand. The legacy
settings modal is a `div` with a click handler and none of them.

## Motion

`--dur-fast` 120ms, `--dur-base` 180ms, `--dur-slow` 260ms, one easing curve. Short enough
to read as a response rather than an animation. `prefers-reduced-motion: reduce` collapses
all of it globally — every transition here is an enhancement, never information.

## Decisions taken without asking

| Decision | Why |
|---|---|
| Settings is a route, not a modal | It is a page's worth of content, it deep-links, and Back does the obvious thing. |
| Service health moved to `/app/admin` | Members got infrastructure first when they wanted to watch a clip. |
| Creating a board button no longer fires it | The legacy version posted to a real group immediately with no way to decline. Two intentions, two actions. |
| Clips shows no player | There is no endpoint that serves the bytes. Saying so beats six broken `<video>` elements. |
| No auto-reveal on the giveaway screen | Rendering must not mutate. The cost is documented in `INVENTORY.md` as a blocker rather than hidden. |
| Watch and Huddle hand off | Cannot be verified without a camera, a microphone and a second participant. |
| Assistant replies render as plain text | Model output. Rendering it as HTML is how an injection gets in. |
| `StrictMode` stays on | Its double-invoked effects are the cheapest way to catch the un-cleaned subscription that becomes two microphones in a call. |

## Screenshots

`docs/ux/screenshots/before-legacy/` and `docs/ux/screenshots/after-app/`, same fixtures,
viewports, locale and timezone, animations frozen. Regenerate with
`tests/browser/shots.mjs`.

| Screen | Before | After |
|---|---|---|
| Home, desktop | `before-legacy/desktop-home.png` | `after-app/desktop-home.png` |
| Home, phone | `before-legacy/mobile-home.png` | `after-app/mobile-home.png` |
| Clips, desktop | `before-legacy/desktop-clips.png` | `after-app/desktop-clips.png` |
| WhatsApp, desktop | `before-legacy/desktop-whatsapp.png` | `after-app/desktop-whatsapp.png` |
| Music, Giveaways, Ask AI | same directories, `*-music`, `*-giveaways`, `*-ai` | |

Emoji render as empty boxes in these images because the host Chromium has no emoji font.
It affects both sides equally so the comparison holds, but it is an artefact of the capture,
not the app.
