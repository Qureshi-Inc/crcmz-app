# Media session ownership

Empty on purpose.

This is where the Watch Party and Huddle session owners belong, and they are not built. See
`docs/ux/STATUS.md` blocker 1: verifying them needs a camera, a microphone, a second
participant and a phone to background, and shipping the highest-risk code in this migration
unverified is worse than the honest handoff that `/app/watch` and `/app/huddle` do today.

The shape it has to take, so whoever picks this up does not start from the wrong place:

* **Above the router, not inside a route.** A route renders *controls for* a session. It
  must not create or destroy one by mounting and unmounting, or navigating between pages
  ends the call.
* **Explicit states:** idle, joining, connected, reconnecting, failed, leaving. Not a pair
  of booleans.
* **One owner per resource** — subscriptions, timers, tracks, media elements, sockets. Each
  with a teardown that actually runs.
* **Survive `StrictMode`'s double-invoked effects** without opening two sessions. That is
  deliberately left on (see `main.tsx`) because it is the cheapest way to catch the
  un-cleaned subscription that becomes two microphones in a call.
* **A persistent dock** showing room name, connection state, mute, Return and Leave, so an
  active session is visible from every screen.
* **Leave, logout, or a permanent access failure** must stop capture tracks, unsubscribe,
  disconnect, clear retry timers and drop stale participant state.
* **Bounded reconnect** with an explicit Retry, and truthful rejoin behaviour after a reload
  or an OS suspension — including a user action when autoplay policy requires one.
* **Keep the backend's identity mapping.** Watch tickets are ES256-signed by this app
  (`watch.py`); participant identity comes from `iss` + `sub`. Do not invent a second
  identity.

Do not combine this with an SDK major upgrade. Pin and document the versions that work.
