Project: CRCMZ app · Repository: Qureshi-Inc/crcmz-app

Prepared September 20, 2026. This is a plan for the coding AI with repository and runtime access. No application changes or deployment have been performed as part of preparing this handoff.

1. Mission and ownership. Take responsibility for upgrading CRCMZ into a coherent, dependable web application. Keep the existing product capabilities and integrations, improve their presentation and interaction behavior, and make future frontend work maintainable. Execute this plan through implementation, verification, and a reviewable release. An audit or a frontend scaffold alone does not satisfy the task.

Make routine implementation and design decisions autonomously. Follow the repository's instructions, respect unrelated work, and use the existing authorized development and deployment workflow. Ask only when missing access or a consequential unresolved product decision blocks progress. A blocked integration should not prevent work on independent features. Record the blocker and continue.

Work in reversible increments on a dedicated branch. Keep a progress tracker with the current commit, next action, verification evidence, and unresolved risks. Do not repeat a failed approach with the same inputs without new evidence. After two equivalent failures, diagnose and change the approach. Bound commands and connection attempts with timeouts. Never convert a failed or unavailable check into a passing result.

2. Evidence and limits. This plan is based on the supplied file Pasted text(20260920-115206).txt, which contains the existing Python server and embedded dashboard. The reviewed snapshot has approximately 11,400 lines. Its dashboard string contains approximately 1,050 CSS lines and 3,939 JavaScript lines. It also imports several existing backend modules; the application is not literally contained in one file.

The live repository and deployed authenticated UI were not inspected during this review. Full browser execution was unavailable. Initialization-order errors and the quick-send selector problem were reproduced using extracted JavaScript functions in isolation. Revalidate all findings against the current repository before changing code.

Finding in supplied snapshot

Implementation requirement

Startup deep-link restoration calls loadSlap, loadWa, and loadGiveaway before their let guards initialize

Fix startup ordering; verify direct entry, refresh, and return from login for each destination.

sendQuick() selects the first .qsend, which belongs to Ask AI

Give the message composer its own pending state and control reference; prevent duplicate submissions through click and Enter.

Navigation replaces history and has no popstate handling

Implement normal client routing with Back/Forward, deep links, focus, and scroll restoration.

Loaded flags are set before successful requests and are not reset on failure in some loaders

Model loading/error/data independently and provide a working Retry action.

A fixed Chat Board consumes space across all screens

Make it a compact launcher and a deliberate drawer with reliable keyboard and safe-area behavior.

The Clips screen starts with service diagnostics

Prioritize clips and montages; place detailed operational information in an authorized administration view.

Large global script, many HTML-string updates, independent polling loops

Introduce feature components, explicit state ownership, shared request handling, and lifecycle cleanup.

Settings modal lacks explicit dialog semantics and focus management in this file

Use accessible dialog behavior or a routed settings page; verify keyboard and screen-reader operation.

Session signing falls back to dev-insecure; the auth middleware bypasses login for a different Host header

Require a production secret and replace host-based trust with explicit authenticated machine access. Public exploitability depends on infrastructure not supplied here.

Startup creates background polling/processing tasks inside the web process

Preserve a single owner for these jobs; do not multiply jobs by adding web workers during the frontend migration.

3. Target architecture. Keep FastAPI and the existing Python services. Introduce a React + TypeScript frontend built with Vite, React Router for navigation, Tailwind CSS and shadcn/ui for shared visual components, and TanStack Query for server data. Prefer compatible stable versions, check their documentation, and commit the dependency lockfile. Avoid unrelated upgrades during migration.

React supports incremental integration into existing applications. Vite can build frontend assets for an existing backend to serve, so this design can remain one repository and one deployable application on the existing domain. React integration guidance, Vite backend integration.

Use the following proposed organization, adapting names to the actual repository without mass-renaming established modules:

Proposed location

Responsibility

server.py

Compatibility ASGI entry point and small application assembly layer.

backend/routers/

Feature routes, preserving existing paths and methods.

backend/auth/

Session handling, browser authorization, and machine authorization.

Existing Python service/data modules

PSN, WhatsApp, clips, assistant, watch, giveaway, persistence, and other existing business logic.

frontend/src/app/

Router, shell, authentication state, query client, and application providers.

frontend/src/components/ui/

Shared controls and accessible primitives.

frontend/src/features/

Home/Squad, clips, music, WhatsApp, giveaways, AI, soundboard, watch, huddle, settings, and admin.

frontend/src/lib/api/

Shared HTTP handling, response types, and feature clients.

frontend/src/media/

Persistent Watch/Huddle session ownership and transport adapters.

frontend/src/styles/

Design tokens, global foundations, and limited shared styles.

frontend/tests/

Focused component and browser tests for important behavior.

docs/ux/

Inventory, decisions, feature parity, screenshots, validation, and release instructions.

Split backend routes gradually using APIRouter, preserving dependency and authorization behavior. Avoid circular imports by putting shared configuration and dependencies outside the entry point. Keep existing import and container entry points working while extracting modules. FastAPI application structure.

Keep server data in the query cache, forms and temporary UI state near their components, shareable filters in the URL, and long-lived media connections in application-level owners. Do not move every value into a global store. Install shared UI primitives as needed and customize them into CRCMZ's design system. shadcn/ui with Vite.

4. Routing and compatibility. Use /app as the new frontend namespace after verifying that it is free in the current repository. Keep its URLs stable through rollout. Initially leave the current default interface available; make the new interface selectable for testing. Implement a tested /legacy route or equivalent fallback before switching the default.

Existing view selector

Proposed canonical frontend URL

Purpose

?p=squad

/app

Squad home, presence, activity, and useful actions.

?p=pipeline

/app/clips

Clips and montages.

?p=slap

/app/music

Slapshare music and related community activity.

?p=wa

/app/community/whatsapp

WhatsApp insights and permitted import/export.

?p=giveaway

/app/community/giveaways

Giveaways and eligible actions.

?p=watch

/app/watch

Watch Party.

?p=huddle

/app/huddle

LiveKit Huddle.

?p=ai

/app/ai

Persistent squad AI conversation.

Current account modal

/app/settings

Profile, connections, passkeys, password, and MCP access.

Current admin controls

/app/admin

Authorized user and operational management.

Use React Router with the appropriate /app base path and Vite asset configuration. A plain declarative client router is sufficient unless the existing code needs a more advanced mode. React Router installation.

Inventory every existing HTTP route before implementing frontend fallbacks. In particular, preserve /clips and /clips/{message_uid:path} as their existing API routes; do not replace them with an HTML page. Preserve /api/*, /v2/*, /auth/*, /oauth/*, /mcp, /portal*, /roast/*, /send, /messages, /status, health endpoints, and well-known endpoints as applicable to the current source.

Limit SPA fallback to the frontend namespace and intended navigation requests. Missing JavaScript, media, and API resources must retain correct 404/error responses rather than receive index.html with status 200. Register specific assets and backend handlers before a frontend fallback.

Map old ?p= links, /dashboard, and /watch to the appropriate experience according to rollout state. URL fragments such as #watch need a small client compatibility handler because the server cannot read a fragment. Use an allowlist of valid destinations. Preserve validated internal return paths through login and prevent open redirects. Unknown frontend routes must show a useful not-found view.

Test route refresh, bookmarks, browser Back/Forward, opening a link in another tab, authentication return, and filters encoded in query parameters. Treat switching between legacy and new documents as a full navigation: it may end a live media session. Offer the switch when idle or clearly explain that consequence.

5. Product design direction. Make CRCMZ a readable, welcoming place for the squad to gather. Retain the name, brand assets, informal voice, and useful personality. Default to the existing dark appearance. Use neutral dark surfaces and one primary accent, with additional color for meaningful states. Keep decorative neon or display typography limited to small brand moments.

Use a readable system or bundled sans-serif body font, approximately 16px body text and 14px secondary text, with a coherent heading scale. Define spacing, typography, color, border, radius, elevation, motion, and overlay tokens. Use measured contrast and visible focus states. Standardize buttons, fields, menus, tabs, badges, skeletons, empty states, dialogs, sheets, and notifications.

Use a desktop sidebar and a compact mobile navigation bar. Start mobile with Home, Watch, Clips, and More; the More view exposes Huddle, Music, Community, AI, and Settings clearly. Treat this ordering as an initial design assumption and adjust it if actual usage shows a different priority. Never make a feature available only through an undiscoverable gesture.

Give ordinary pages roughly 1120–1280px usable desktop content width, with wider media layouts and narrower readable conversation/form columns where useful. Adapt the layout fluidly. Remove the universal 760px constraint. Make Home visually prioritize who is online, what is happening, and how to join. Place detailed analytics and rankings further into their sections.

Use a compact activity dock for active Watch/Huddle sessions and a separate Chat Board launcher. Define one layout policy for mobile navigation, media status, drawers, notifications, and the software keyboard. They must never cover a composer, a Leave button, or another required control. Persist sensible user preferences without storing sensitive credentials or cross-user conversation data.

Preserve a user's scroll position when appropriate, avoid rebuilding an entire conversation on each poll, and keep focus stable during background updates. Use short action labels and useful error copy. Display operation success only when supported by a server acknowledgment.

6. Shared interaction and request contracts. Implement one tested API layer that handles timeouts, cancellation, HTTP errors, JSON and non-JSON responses, empty responses, and the backend's existing detail/error formats. Generate types from OpenAPI where schemas are accurate; define and validate responses explicitly where schemas are incomplete. A TypeScript assertion is not runtime validation.

Situation

Required behavior

Initial load

A stable placeholder matching the final layout; no indefinite spinner without recovery.

Background refresh

Keep usable previous data visible and identify stale data if refresh fails.

Empty result

Explain the empty state and offer a relevant next action.

401/session expired

Preserve appropriate drafts, explain the need to sign in, and return to the intended page. Do not silently replay writes.

403

Explain that the action is unavailable for this account; do not present it as a network failure.

429

Respect Retry-After and show when another attempt is allowed.

Network failure during a write

Say whether failure is known or success is uncertain; do not blindly resend a potentially completed message.

A secondary integration fails

Keep unaffected sections usable and show recovery for the failed section.

Navigation/filter changes

Cancel superseded reads or ignore stale results using keys tied to the current route, user, and filters.

Logout/account change

Close protected sessions and clear the previous user's cached data and drafts as appropriate.

Configure query freshness, refetch-on-focus, polling, retries, and garbage collection deliberately. Do not rely on library defaults to match the application's needs. TanStack Query treats data as stale by default and has automatic refetch/retry behavior that needs consideration here. TanStack Query defaults.

Start visible Squad presence refresh near its existing 30-second cadence and Hype near 60 seconds. Keep assistant polling tied to a pending server job. Refresh clip status only where needed. Suspend unnecessary polling for hidden/unmounted views; active media transport must remain connected when an ordinary page is hidden. Avoid overlapping requests and unbounded retry loops. Reuse existing real-time transports; add new ones only for a measured need.

Disable the correct submit control and guard the mutation itself while pending. Apply the same protection to Enter and pointer input. Do not automatically retry non-idempotent sends, draw/reveal operations, or other side effects. If server idempotency is needed, add it as an explicit compatible backend change with persistent deduplication; a button being disabled is not proof of exactly-once delivery.

7. Feature requirements and parity. Build an inventory from the actual source. The following requirements are a minimum, not permission to omit a capability that is absent from this list.

Feature

Required user experience and behavior

Home / Squad

Presence, current games, relevant activity, existing ranks/trophies and Hype remain available. Show data freshness and a useful unavailable state. Surface Watch/Huddle join actions only when backed by real state.

Chat Board / Soundboard

Preserve shared and personal boards, create/delete, ordering, collapse/fullscreen functionality where applicable, and sending identities. Provide explicit board selection and an accessible alternative to drag/long-press. Show pending, success, rate limiting, and uncertain delivery correctly.

Clips / Montages

Put playable clips, thumbnails, sender, time, duration, filters, and latest montage first where the backend supports them. Preserve resend and processing information with existing permissions. Investigate missing media endpoints; do not fabricate a gallery or claim playback parity without real media access.

Music / Slapshare

Preserve the library/activity, contributors, rankings, and existing insight sections. Load the overview first; let secondary widgets fail independently. Preserve outbound actions and existing access rules.

WhatsApp

Preserve date ranges, custom range validation, statistics, awards, activity, member views, exports, and authorized history import. Keep import permissions and size/type limits. Prevent older range responses from replacing newer selections.

Giveaways

Preserve user visibility and the exact create/edit/publish/lock/draw/reveal/close/redraw/entry rules found in the backend. Keep destructive actions clear and prevent repeated mutations. Component mounting or refetching must not accidentally trigger a draw.

Ask AI

Preserve stored conversations, pending jobs across refresh/phone lock, image attachment, facts and fact permissions, clear-chat behavior, and appropriate suggestion chips. Preserve drafts on errors and provide explicit retry/resend decisions. Do not invent streaming or percentage progress if the backend does not support it.

Watch Party

Preserve room identity, signed tickets, participant identity/nicknames, playback synchronization, extraction/proxy behavior, chat, cameras, microphone controls, and the existing cross-page mini-player behavior.

Huddle

Preserve join preview, devices, mic/camera, screen share, grid/spotlight, supported blur, transcription, AI notes, and Leave. Handle permission denial, missing devices, autoplay restrictions, and reconnection visibly.

Account and sign-in

Preserve Zitadel login and callback, passkeys, password settings, PSN link/claim/relink, Mattermost connect/unlink, MCP access/revocation, and logout. Make setup steps understandable and retain existing eligibility rules.

Administration

Preserve authorized user management and operational tools. Server permissions remain authoritative. Present technical pipeline diagnostics here while giving members concise service-impact messages.

Audit the existing giveaway auto-reveal behavior. If scheduled action currently depends on an admin opening the page, preserve its intended timing through an idempotent backend job before removing the frontend trigger. Test with a fake clock and test data; do not silently delete scheduled behavior or redraw a real giveaway during migration.

8. Media lifecycle requirements. Watch and Huddle are the highest-risk frontend migrations. Build their session owners above the changing route content. A route should render controls for a session rather than implicitly create or destroy the session by appearing or disappearing.

Use explicit states such as idle, joining, connected, reconnecting, failed, and leaving. Own subscriptions, timers, tracks, audio/video elements, and sockets deliberately. Handle development effect re-runs without duplicate sessions. Preserve the established user and participant identity mapping from the backend.

Navigating between pages inside the new app must preserve an intentionally active call, microphone state, playback session, and participant count. Show a persistent dock with room name, connection state, mute, Return, and Leave. Define behavior for switching between Watch and Huddle: preserve confirmed supported behavior and prevent accidental duplicate microphone publishing or self-echo.

Leave, logout, or a permanent access failure must stop capture tracks, unsubscribe listeners, disconnect the intended session, clear retry timers, and remove stale participant state. Use a bounded reconnect policy with an explicit Retry action. A full browser reload or mobile OS suspension can interrupt media; implement truthful rejoin/resume behavior and show a user action when autoplay requires it.

Test navigation during a call, repeated join/leave, permission denial, device removal, network interruption, background/foreground, screen-share end, and logout. Browser automation covers part of this; camera, microphone, playback, and mobile suspension also need realistic integration checks. Do not claim mobile background reliability based on desktop screenshots.

9. Production backend work associated with this migration. Keep these changes small, separately reviewable, and covered by behavior tests.

Require a nonempty production session secret and eliminate production fallback to a known development value. Preserve the existing valid secret during rollout unless rotation is an intentional operation.

Replace Host-header-based authentication bypass with explicit machine credentials or another verified internal authentication mechanism. Inventory Stream Deck, bridge, health, and other callers first; migrate them before removing their old access path. An allowed Host header can be an additional check, not proof of identity.

Preserve secure cookie behavior and validate internal redirect targets. Audit CSRF/origin handling for cookie-authenticated writes; machine bearer routes and OAuth callbacks need their own appropriate verification.

Replace unsafe HTML-string interpolation of user-supplied values. Use escaped template output and safe JSON serialization during legacy operation, and ordinary text rendering in React. Do not reintroduce injection through raw HTML or URLs.

Pin and bundle frontend SDKs when migrating their features. Document the working media SDK versions; do not combine an untested major upgrade with the migration.

Check current background-task ownership before changing process counts. Retain a single designated owner or introduce a tested worker/job lock before scaling. Rate limits and in-memory job state are not automatically shared across workers.

Move optional external-service initialization out of import-time failure paths where practical. An unavailable PSN or music service should produce a degraded feature state, while mandatory security configuration should fail closed.

Add request/error identifiers to relevant logs without recording credentials, message content, or private tokens. Reuse existing monitoring facilities before adding another service.

Do not treat component extraction as a complete security audit. Record unresolved production issues with their actual exposure, severity, and evidence.

10. Execution phases and completion gates. Follow this order. Finish and verify a coherent batch before broadening it. Maintain docs/ux/STATUS.md and a feature-parity table throughout.

Phase

Concrete work

Gate before advancing

0 — Baseline

Read current instructions and deployment config; record commit; inventory routes/features/auth/external callers; run existing checks; capture representative current screens; document performance and failures.

A reproducible baseline, route contract, feature inventory, and isolated test setup exist. Missing access is identified.

1 — Correct known defects

Reproduce and fix startup/deep-link ordering, wrong send button, duplicate-submit handling, loader recovery, and related navigation failures in the still-served implementation as needed. Address confirmed critical auth/config risks with caller compatibility.

Targeted regression checks pass. The current interface remains usable.

2 — Foundation

Add frontend build, /app routing, static hosting, session/bootstrap API if needed, shared requests/query configuration, error boundaries, and the legacy fallback. Create design tokens and a component reference page available only to development/test.

Production build works; auth return and route refresh work; legacy API requests retain their methods, response types, and authorization.

3 — Design reference

Implement the shared shell, Home/Squad, Chat Board drawer, and AI composer layout with fixture states and then real API integration. Review at desktop and mobile sizes and refine before propagation.

The design is readable and coherent; real data and actions work; overlays and keyboard do not block controls.

4 — Standard features

Migrate Clips, Music, WhatsApp, Giveaways, full AI/facts, and Account/Admin flows one feature at a time. Keep the parity tracker current.

Each feature passes its workflow, permission, failure/recovery, and visual checks before its old route is retired.

5 — Media

Migrate Watch and Huddle into the persistent session architecture; integrate the activity dock and explicit cleanup.

Active sessions survive in-app navigation; join/leave/reconnect and device checks pass; no duplicate capture or participants.

6 — Quality and packaging

Finish accessibility and responsive review, measure performance, run relevant regression checks, build the production image, and exercise rollback.

Release candidate meets the acceptance matrix; remaining limitations are explicit.

7 — Controlled rollout

Enable the new UI for configured testers, observe representative workflows, then switch the default through the existing authorized release process.

Core workflows work against real integrations in the approved test context; no unresolved critical/high regression; rollback remains available.

8 — Retirement

After the observation window and verified parity, remove obsolete dashboard code and unused assets, retain compatibility redirects, and document future feature development.

Final build/tests pass; old links work; release and rollback documentation matches the deployed artifact.

A fixture-only screen is not integrated. A build passing is not visual verification. A screenshot is not proof that a workflow succeeds. Mark each feature as inventoried, implemented, integrated, verified, and migrated only when its evidence exists.

11. Accessibility, responsiveness, and performance acceptance. Target WCAG 2.2 AA for the migrated experience. Use semantic controls, associated labels, meaningful accessible names, visible focus, logical tab order, restrained live announcements, and appropriate contrast. Dialogs must trap and restore focus, support Escape where appropriate, and prevent interaction with the background. Provide alternatives for dragging and gesture-only actions. Respect reduced motion. Automated checks do not establish complete conformance. WCAG 2.2 reference.

Use approximately 44px touch targets for common controls as a product comfort target; do not describe 44px as the WCAG AA minimum. Validate layouts at 360, 390, 768, 1024, and 1440px widths, at 200% zoom, and in narrow reflow. Essential controls must remain reachable with a mobile keyboard, browser chrome, safe-area insets, and active media dock. Deliberately scrollable charts or tables should not cause the entire page to overflow.

Load media SDKs and heavy feature code when needed. Cache fingerprinted static assets while making the application entry document refresh appropriately. Ensure private API data is not shared through a CDN cache. Reserve image/video space to reduce layout shifts. Keep an initial-load and request-count budget based on measured baseline data. Optimize observed problems rather than adding speculative complexity.

Aim for field Core Web Vitals of LCP at or below 2.5 seconds, INP at or below 200ms, and CLS at or below 0.1 at the 75th percentile, assessed separately for mobile and desktop. Record repeatable lab conditions and field sample limits. A local Lighthouse run does not prove field INP or production performance. Core Web Vitals definitions and thresholds.

12. Verification matrix. Use the existing backend test framework, focused frontend behavior tests, and Playwright for representative browser workflows. Use mocks or dedicated test accounts/rooms for writes; do not send test messages to real PSN/WhatsApp groups or mutate real giveaways merely to validate the UI.

Check

Required evidence

Build, typing, lint, existing relevant tests

Exact commands, exit results, and tested commit. Fix regressions; identify unrelated baseline failures accurately.

Route and API compatibility

Contract checks for protected/public/machine routes, methods, statuses, content types, and frontend fallback boundaries.

Login and settings

Login, passkey where supported, expiry, return destination, logout, and relevant account actions verified.

Navigation

Every migrated page works on direct entry, refresh, and Back/Forward; old query/hash links resolve appropriately.

Quick messages

Repeated click/Enter while pending produces one request; AI controls are unaffected; failures preserve draft text.

Loading/recovery

Slow response, failed response, malformed response, empty data, offline, expired session, and rate-limit examples are exercised.

Data ownership

Filters cannot show responses from an older selection; logout/account change does not show the previous user's private cache.

AI persistence

Submit a test question, navigate away, return/reload, and verify existing server-side pending/completed state is recovered.

Feature parity

Every inventoried capability is mapped to a verified replacement, compatible legacy path, or explicitly unresolved blocker.

Watch/Huddle

Join, navigate away/back, mute, screen share where supported, reconnect, leave, and logout with cleanup evidence.

Permissions

Member/admin/machine behavior is checked at the API as well as in the UI.

Accessibility

Automated findings resolved, plus keyboard/focus, labels, contrast, reduced motion, and representative screen-reader checks.

Visual quality

Comparable before/after screenshots with consistent viewport, state, and test data; human or visual inspection of the rendered result.

Browser coverage

Chromium, Firefox, and WebKit where available; actual Safari/iOS and Android media checks where available. List any untested claims.

Performance

Baseline versus candidate under comparable conditions, initial assets, requests, polling behavior, and documented field-data limits.

Deployment/rollback

Production image starts with intended config, health works, assets load, callbacks work, and the previous release can be restored.

Write focused regression tests for these behaviors. Avoid tests that merely repeat a component's implementation or snapshot every cosmetic detail. Do not regenerate failing snapshots blindly. Once a risk is resolved, avoid repeating unrelated suites without a reason.

Define critical defects as exposure/data loss, destructive unintended actions, or an unusable core product; high defects as a broken core workflow, authorization regression, or unreliable essential media behavior. Both classes block general cutover. Minor visual issues may be tracked with a concrete follow-up if core use is unaffected. State blocked or untested areas honestly.

13. Release, operations, and rollback. Use the repository's existing Docker/Coolify or other verified deployment arrangement. Build the frontend in a build stage and include its production output in the runtime artifact. A development server is not the production serving process. Keep the public origin and existing callback registrations stable wherever possible.

Add a simple configuration or account-cohort mechanism to choose the default frontend. Its value must never grant additional API permissions. Avoid switching someone from the legacy document during an active session. Maintain a known-good previous image and a tested route fallback.

Before rollout, verify existing backup coverage for persistent data and the ability to restore the previous release. Prefer no schema changes for this UI migration. If a necessary change affects stored data, make it backward-compatible and document its separate rollback constraints.

During the initial rollout, monitor login failures, API errors, frontend exceptions, unexpected request growth, media join/reconnect failures, and duplicate side effects. Use a minimum 24-hour observation window covering representative use before removing the legacy implementation. If traffic is insufficient, perform approved integration checks and explicitly retain the field-validation limitation and rollback option.

Rollback on critical/high regressions. Restore the previous default interface or release, verify a minimal core workflow, preserve logs, and fix the cause in a new candidate. Avoid reverting an entire image to reintroduce a fixed authentication vulnerability; keep necessary compatible security fixes available in the rollback target. Do not delete user data, alter DNS, or replace working integrations as part of cosmetic recovery.

If deployment access or release authority is absent, finish the tested candidate and exact rollout/rollback instructions. Report that narrow blocker without claiming the app has been deployed. Otherwise use the already authorized release workflow after the gates pass; do not invent extra approval rounds for routine work.

14. Required final deliverables. Produce the implemented frontend, appropriately modular backend, a working production build, and the following concise artifacts in the repository:

docs/ux/STATUS.md: current status, commit, remaining work, and how to resume.

docs/ux/INVENTORY.md: screens, important workflows, integrations, user roles, and feature parity.

docs/ux/ROUTES.md: original contracts, new frontend routes, compatibility mapping, and auth classification.

docs/ux/DESIGN.md: visual tokens, reusable patterns, navigation decisions, and a few representative screenshots.

docs/ux/VALIDATION.md: checks actually performed, evidence, performance comparisons, and precise limitations.

docs/ux/RELEASE.md: build, configuration, deployment, default-UI switch, observation, and rollback instructions.

Use existing equivalent documentation files if they already serve these purposes. Keep secrets, real private chat contents, and access tokens out of screenshots and documentation.

Completion means users can find and use the existing features in a coherent interface; important actions handle pending/failure/recovery; media survives in-app navigation; APIs and authentication retain their contracts; the new code has clear ownership; and a tested release and rollback path exist. Distinguish implemented, locally verified, integration verified, and deployed status in the final report.

Begin with Phase 0, revalidate the snapshot findings against the current code, and proceed through every unblocked phase. Keep updating the tracker so another coding session can continue without repeating completed work.
