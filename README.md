<p align="center"><img src="android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png" width="96" alt="CRCMZ"></p>

<h1 align="center">CRCMZ App</h1>

<p align="center"><b>The squad platform for Professional Goopers</b> — one place for who's on, clips, music, movie nights and calls.</p>

<p align="center">
  <a href="https://app.crcmz.me/app"><img alt="app.crcmz.me" src="https://img.shields.io/badge/app.crcmz.me-open-ff2fd6?style=for-the-badge"></a>
  <a href="https://github.com/Qureshi-Inc/crcmz-app/releases/latest"><img alt="Android" src="https://img.shields.io/github/v/release/Qureshi-Inc/crcmz-app?filter=android-*&label=Android&logo=android&style=for-the-badge&color=3ddc84"></a>
  <a href="#iphone-testflight"><img alt="iPhone" src="https://img.shields.io/badge/iPhone-TestFlight-0d96f6?logo=apple&style=for-the-badge"></a>
</p>

---

## Get it

| | Where | How |
|---|---|---|
| 🌐 **Web** | **[app.crcmz.me/app](https://app.crcmz.me/app)** | Sign in with your CRCMZ account. On a phone, *Add to Home Screen* works too. |
| 🤖 **Android** | **[Latest release](https://github.com/Qureshi-Inc/crcmz-app/releases/latest)** | Download the `.apk`, open it, allow "install unknown apps", sign in. |
| 🍎 **iPhone** | **TestFlight** (invite only) | See below. |

### iPhone (TestFlight)

1. Look for the email from Apple: *"… has invited you to test CRCMZ"*.
2. Install **[TestFlight](https://apps.apple.com/app/testflight/id899247664)** from the App Store.
3. Tap **View in TestFlight** in the email, or open TestFlight → **Redeem** and type the code from the email.
4. Install CRCMZ, allow notifications, sign in.

No email? Reach out to **InterestingSoup** to get added to the **CRCMZ Squad** group. In the app, **More → Get the app** has the same links.

---

## Status

Live status of every part of CRCMZ: **[status.crcmz.me](https://status.crcmz.me)**.

| Surface | State |
|---|---|
| Web app (`app.crcmz.me`) | 🟢 Live |
| Android app | 🟢 Released on [GitHub Releases](https://github.com/Qureshi-Inc/crcmz-app/releases) |
| iPhone app | 🟡 Beta on TestFlight (invite only) |
| MCP server | 🟢 Live |

---

## What it does

| Area | What it is |
|---|---|
| Squad | Who's online and in what game, ranks, hype meter, the Chat Board |
| Clips | PSN clips in one place: reels, the Studio editor, the monthly montage |
| Slap | The squad's own music library: daily New finds, charts, thumbs, Listen Together; share a song from Spotify or Apple Music and it's added |
| Watch | A movie library and the Watch Party: video in sync for everyone, with a camera call |
| Huddle | Voice and video calls with picture in picture, a live transcript, an AI helper and meeting notes |
| Ask AI | An assistant that knows the squad's data and remembers it, in the app, WhatsApp and PSN |
| Notifications | Web Push and native alerts on Android and iPhone; Huddle and Watch Party rings like a call |
| Giveaway | Entries, countdown and the draw |
| MCP server | Plug your own AI into the squad: every assistant tool over MCP |

---

## Phone apps

Both phone apps are web views around `app.crcmz.me/app` with native parts where the web
can't keep up: the tab bar, calls with picture in picture, the music player (lock screen,
CarPlay / Android Auto), notifications and call rings, and Share → CRCMZ. A website update
reaches both apps; only native changes need a new build. See `ios/README.md` and
`android/README.md`.

---

## Built with

Python (FastAPI) and SQLite on the server; React + TypeScript (Vite) for the interface;
Swift (iOS) and Kotlin (Android); LiveKit for calls; Jellyfin for music and movies;
Zitadel for sign-in; a local LLM for the AI. It runs self-hosted in Docker.

---

## Developing

```bash
cd frontend
npm ci
npm run dev         # component work; API calls proxy to CRCMZ_BACKEND
npm run build       # tsc then vite; the Dockerfile runs this in a build stage
```

Two traps, both of which were live bugs:

* Use `text-sm`, never `text-[var(--text-sm)]`: Tailwind cannot tell a length from a
  colour inside `var()`, so the arbitrary form compiles to `color:` and silently removes
  the font size *and* the text colour.
* `to()` in `app/routes.ts` returns **router-relative** paths. `basename` is `/app`, so
  returning `/app/clips` gives `href="/app/app/clips"`.

New features follow one rule: every data store gets a read tool in `assistant.py`, which
makes it available to the AI and over MCP; `tests/test_mcp_coverage.py` enforces it.

---

## Running tests

```bash
tests/run-all.sh                          # every Python suite, inside the app image
tests/run-all.sh test_auth_gate           # one suite
cd frontend && node tests/smoke.mjs       # the web app in a real browser (needs `npx vite --port 5199`)
```

Run the Python suites through `tests/run-all.sh`, not on the host: it runs them in the app
image with a throwaway data directory and no network. Every test fakes the outside world, so
nothing is ever sent to a real PSN, WhatsApp or Mattermost group.
