import asyncio
import os
import json
import logging
from pathlib import Path
from fastapi import FastAPI, HTTPException, Form, Request, File, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse, Response
from pydantic import BaseModel
from psnawp_api import PSNAWP

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Suppress per-request access logs for health-check endpoints — Coolify/Traefik
# polls these every few seconds and the noise drowns out real log lines.
class _NoHealthFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return "/health" not in msg and "/v2/health" not in msg

for _uvicorn_logger in ("uvicorn.access", "uvicorn"):
    logging.getLogger(_uvicorn_logger).addFilter(_NoHealthFilter())

NPSSO_TOKEN = os.environ.get("NPSSO_TOKEN")
GROUP_ID = os.environ.get("GROUP_ID")
GROUP_NAME = os.environ.get("GROUP_NAME", "crcmz-mod")
# Auto-Squad: a separate PSN group (everyone except wolfie/IG_Juicy) that the
# "Squad Up" Stream Deck button rallies. Created 2026-08-15; overridable via env.
SQUAD_GROUP_ID = os.environ.get("SQUAD_GROUP_ID", "213250d833ccce334b651e2ee15e365c97468e02-869")
SQUAD_GROUP_NAME = os.environ.get("SQUAD_GROUP_NAME", "The Squad")

if not NPSSO_TOKEN:
    raise RuntimeError("NPSSO_TOKEN environment variable is required")
if not GROUP_ID:
    raise RuntimeError("GROUP_ID environment variable is required")

try:
    psnawp = PSNAWP(NPSSO_TOKEN)
    client = psnawp.me()
    logger.info(f"Authenticated as: {client.online_id}")
    group = psnawp.group(group_id=GROUP_ID)
    logger.info(f"Connected to group: {GROUP_ID}")
except Exception as _psnawp_err:
    logger.warning(f"psnawp init failed (legacy /send+/messages disabled): {_psnawp_err}")
    psnawp = None
    client = None
    group = None

app = FastAPI(title="PSN Messenger")


# --- Rate limiting -----------------------------------------------------------
# Protects friends' PSN accounts from any brute-force/spam pattern. Every action
# that results in a PSN write (group messages, roasts) passes through a shared
# token-bucket-ish window limiter keyed by action group. Well under anything
# Sony would flag, and it stops a mashed button or a script from flooding.
import threading as _threading
import time as _time

_rl_lock = _threading.Lock()
_rl_hits: dict[str, list[float]] = {}

# key -> (max_calls, per_seconds)
_RL_LIMITS = {
    "psn_send": (8, 60.0),      # group messages (soundboard, squad, /v2/send)
    "roast": (5, 60.0),         # roast triggers
    "custom_add": (6, 60.0),    # AI-flavored custom button creation (also Bedrock cost)
    "watch_join": (30, 60.0),   # Watch Ticket issuance (one per tab + reconnects)
    "watch_extract": (5, 60.0),  # yt-dlp URL extraction (subprocess, keep tight)
}


def _rate_limit(key: str, actor: str = "") -> None:
    """Raise HTTP 429 if `key` exceeded its window. Sliding-window counter.

    Pass `actor` (user_id or client IP) to scope the limit per-user so one
    person cannot exhaust the quota for everyone else.
    """
    limit = _RL_LIMITS.get(key)
    if not limit:
        return
    max_calls, window = limit
    now = _time.time()
    bucket = f"{key}:{actor}" if actor else key
    with _rl_lock:
        hits = [t for t in _rl_hits.get(bucket, []) if now - t < window]
        if len(hits) >= max_calls:
            retry = round(window - (now - hits[0]), 1)
            raise HTTPException(
                status_code=429,
                detail=f"Slow down — try again in {retry}s.",
                headers={"Retry-After": str(int(retry) + 1)},
            )
        hits.append(now)
        _rl_hits[bucket] = hits


import re as _re


class _DirectAuth:
    """Minimal duck-type of PSNAuth that holds a pre-fetched access token.
    PSNMessenger only reads auth.access_token, so this is all we need.
    """
    def __init__(self, token: str):
        self._token = token

    @property
    def access_token(self) -> str:
        return self._token


class MessageRequest(BaseModel):
    message: str


@app.get("/.well-known/webauthn")
def webauthn_related_origins():
    """Declare auth.crcmz.me as a related origin so passkeys registered there work here."""
    issuer_origin = ZITADEL_ISSUER.rstrip("/")
    return JSONResponse({"origins": [issuer_origin]})


@app.get("/health")
def health():
    return {"status": "ok"}


_FAVICON_PATH = Path(__file__).parent / "favicon.png"
_LOGO_PATH         = Path(__file__).parent / "crcmz-logo.png"
_FOOTER_AVATAR_PATH = Path(__file__).parent / "footer-avatar.png"

@app.get("/favicon.png", include_in_schema=False)
def favicon():
    if _FAVICON_PATH.exists():
        return Response(_FAVICON_PATH.read_bytes(), media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
    return Response(status_code=404)

@app.get("/crcmz-logo.png", include_in_schema=False)
def crcmz_logo():
    if _LOGO_PATH.exists():
        return Response(_LOGO_PATH.read_bytes(), media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
    return Response(status_code=404)

@app.get("/footer-avatar.png", include_in_schema=False)
def footer_avatar():
    if _FOOTER_AVATAR_PATH.exists():
        return Response(_FOOTER_AVATAR_PATH.read_bytes(), media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
    return Response(status_code=404)


@app.post("/send")
def send_message(req: MessageRequest):
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    if group is None:
        raise HTTPException(status_code=503, detail="Legacy PSN client unavailable")
    try:
        group.send_message(req.message.strip())
        logger.info(f"Message sent: {req.message[:50]}")
        return {"status": "sent", "message": req.message.strip()}
    except Exception as e:
        logger.error(f"Failed to send message: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/messages")
def get_messages(limit: int = 5):
    if group is None:
        raise HTTPException(status_code=503, detail="Legacy PSN client unavailable")
    try:
        conversation = group.get_conversation(limit)
        messages = []
        for msg in conversation:
            messages.append({
                "sender": str(msg.get("senderOnlineId", "unknown")),
                "body": str(msg.get("body", "")),
                "timestamp": str(msg.get("eventIndex", "")),
            })
        return {"messages": messages}
    except Exception as e:
        logger.error(f"Failed to get messages: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# === V2 routes: PSN API with auto-refresh tokens ===

try:
    from psn_auth import PSNAuth
    from psn_messaging import PSNMessenger

    psn_auth = PSNAuth(NPSSO_TOKEN)
    psn_messenger = PSNMessenger(psn_auth, GROUP_ID, GROUP_NAME)
    logger.info("v2: PSN auth initialized with token persistence")
    _v2_available = True
except Exception as e:
    logger.warning(f"v2: PSN auth failed to initialize: {e}")
    _v2_available = False


@app.get("/v2/health")
def v2_health():
    if not _v2_available:
        raise HTTPException(status_code=503, detail="v2 auth not initialized")
    return {"status": "ok", "version": "v2"}


@app.post("/v2/send")
def v2_send_message(req: MessageRequest, request: Request):
    _rate_limit("psn_send", request.client.host)
    if not _v2_available:
        raise HTTPException(status_code=503, detail="v2 auth not initialized")
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    try:
        # Try to send as the logged-in user's PSN account; always fall back to
        # the server (crcmz-mod) account if anything goes wrong.
        success = False
        try:
            session = _get_session(request)
            if session:
                user_token = portal_mod.get_fresh_access_token(session.get("sub", ""))
                if user_token:
                    user_messenger = PSNMessenger(_DirectAuth(user_token), SQUAD_GROUP_ID)
                    success = user_messenger.send_message(req.message.strip())
        except Exception as ue:
            logger.warning("v2: user-token send failed (%s), falling back to server account", ue)
        if not success:
            success = _squad_messenger.send_message(req.message.strip())
        if success:
            return {"status": "sent", "message": req.message.strip(), "version": "v2"}
        raise HTTPException(status_code=500, detail="Failed to send message")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"v2: Send failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v2/messages")
def v2_get_messages(limit: int = 5):
    if not _v2_available:
        raise HTTPException(status_code=503, detail="v2 auth not initialized")
    try:
        messages = psn_messenger.get_messages(limit)
        return {"messages": messages, "version": "v2"}
    except Exception as e:
        logger.error(f"v2: Get messages failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v2/messages/raw")
def v2_get_messages_raw(limit: int = 10):
    """Debug: return the raw PSN API response to inspect field names."""
    if not _v2_available:
        raise HTTPException(status_code=503, detail="v2 auth not initialized")
    try:
        return psn_messenger.get_messages_raw(limit)
    except Exception as e:
        logger.error(f"v2: get_messages_raw failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# === Auto-Squad: rally the squad group (everyone except wolfie/IG_Juicy) ===

# A separate messenger bound to the squad group, reusing the same auth.
try:
    _squad_messenger = PSNMessenger(psn_auth, SQUAD_GROUP_ID, SQUAD_GROUP_NAME) if _v2_available else None
except Exception as e:  # noqa: BLE001
    logger.warning(f"squad: messenger init failed: {e}")
    _squad_messenger = None


class SquadRequest(BaseModel):
    message: str | None = None


@app.post("/v2/squad")
def v2_squad(request: Request, req: SquadRequest | None = None):
    """Post a 'squad up' rally message to the dedicated squad group."""
    _rate_limit("psn_send", request.client.host)
    if _squad_messenger is None:
        raise HTTPException(status_code=503, detail="squad messenger not initialized")
    text = (req.message.strip() if (req and req.message) else "") or \
        "🎮🔥 SQUAD UP! Who's hopping on? 🕹️💥"
    try:
        if _squad_messenger.send_message(text):
            logger.info(f"squad: sent -> {text[:60]}")
            return {"status": "sent", "group": SQUAD_GROUP_ID, "message": text}
        raise HTTPException(status_code=500, detail="Failed to send squad message")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.error(f"squad: send failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# === Roast Bot routes ===

import roast_bot


@app.post("/roast/start")
async def roast_start():
    if roast_bot.is_running():
        return {"status": "already running"}
    if not roast_bot.start():
        return {"status": "disabled", "message": "Auto-roast is turned off."}
    return {"status": "started", "message": "Roast bot activated 🔥"}


@app.post("/roast/stop")
async def roast_stop():
    if not roast_bot.is_running():
        return {"status": "already stopped"}
    roast_bot.stop()
    return {"status": "stopped", "message": "Roast bot deactivated"}


@app.post("/roast/once")
async def roast_once(request: Request):
    """Send one roast immediately."""
    _rate_limit("roast", request.client.host)
    try:
        roast = roast_bot.generate_single_roast()
        roast_bot.send_roast(roast)
        return {"status": "sent", "roast": roast}
    except Exception as e:
        logger.error(f"Roast once failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/roast/status")
def roast_status():
    return {"running": roast_bot.is_running()}


# === Self-service PSN linking portal ===
#
# Flow for a friend (one time, then never again):
#   1. Open /portal, enter the shared passcode.
#   2. Tap "Sign in to PlayStation" -> Sony login page (new tab).
#   3. Tap "Get my token" -> Sony's ssocookie page shows {"npsso":"..."}.
#   4. Copy it, paste back here, Link. We validate + save their tokens per
#      user and auto-refresh forever after (see portal.py / psn_auth.py).

import portal as portal_mod



def _portal_page(error: str = "", ok: str = "") -> str:
    """Render the single-page portal wizard (only reached once unlocked)."""
    from portal import NPSSO_TOKEN_URL, PSN_LOGIN_URL, mattermost_usernames

    # On success we replace the whole wizard with a celebration screen.
    if ok:
        return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Linked!</title>
<style>
  :root {{ color-scheme:dark; }}
  * {{ box-sizing:border-box; }}
  html,body {{ margin:0; }}
  body {{ font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color:#eaf0ff; min-height:100dvh; display:flex; align-items:center;
    justify-content:center; padding:24px; background:#070b18; position:relative;
    overflow:hidden; }}
  body::before {{ content:""; position:fixed; inset:-30%; z-index:-1;
    background:
      radial-gradient(45% 45% at 30% 25%, rgba(46,230,160,.35), transparent 60%),
      radial-gradient(45% 45% at 75% 30%, rgba(0,163,255,.32), transparent 60%),
      radial-gradient(50% 45% at 55% 90%, rgba(124,92,255,.28), transparent 62%);
    filter:blur(30px); animation:drift 16s ease-in-out infinite alternate; }}
  @keyframes drift {{ to {{ transform:translate3d(4%,3%,0) scale(1.12); }} }}
  .card {{ width:100%; max-width:440px; text-align:center;
    background:rgba(23,31,54,.72); border:1px solid rgba(120,140,190,.2);
    border-radius:24px; padding:38px 28px 30px;
    box-shadow:0 30px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
    backdrop-filter:blur(22px); -webkit-backdrop-filter:blur(22px);
    animation:rise .55s cubic-bezier(.2,.8,.2,1) both; }}
  @keyframes rise {{ from {{ opacity:0; transform:translateY(18px) scale(.97); }} }}
  .ring {{ width:96px; height:96px; margin:0 auto 20px; border-radius:50%;
    display:grid; place-items:center; font-size:46px;
    background:radial-gradient(circle at 50% 40%,rgba(46,230,160,.4),rgba(0,179,255,.12));
    box-shadow:0 0 0 4px rgba(46,230,160,.4), 0 16px 50px rgba(46,230,160,.4);
    animation:pop .6s cubic-bezier(.2,1.5,.4,1) both; }}
  @keyframes pop {{ from {{ transform:scale(.3); opacity:0; }} }}
  h1 {{ font-size:24px; margin:0 0 8px; }}
  p {{ color:#9fb0d4; font-size:14.5px; line-height:1.6; margin:0 0 8px; }}
  .who {{ color:#9dffd6; font-weight:700; }}
  .btns {{ margin-top:24px; }}
  a.btn {{ display:block; text-decoration:none; padding:14px; border-radius:14px;
    font-size:15px; font-weight:700; margin-top:11px; }}
  .go {{ background:linear-gradient(135deg,#12d18e,#00b3ff); color:#04210f;
    box-shadow:0 12px 30px rgba(18,209,142,.4); }}
  .ghost {{ background:rgba(255,255,255,.06); color:#dfeaff;
    border:1px solid rgba(140,160,255,.24); }}
</style></head>
<body><div class="card">
  <div class="ring">✓</div>
  <h1>You're all set! 🎉</h1>
  <p><span class="who">{ok}</span></p>
  <p>Your PlayStation is linked. You never have to do this again — it stays
     connected automatically.</p>
  <div class="btns">
    <a class="btn go" href="/dashboard">🎮 See the Squad dashboard</a>
    <a class="btn ghost" href="/portal">Link another account</a>
  </div>
</div></body></html>"""

    banner = ""
    if error:
        banner = f'<div class="msg err">⚠️ {error}</div>'
    # "Who are you?" dropdown of Mattermost users, so each link ties to a person
    # (like the Apple Music re-link page). Falls back to a text field if the
    # user list can't be fetched.
    names = mattermost_usernames()
    if names:
        opts = '<option value="" disabled selected>Select your name…</option>' + "".join(
            f'<option value="{n}">{n}</option>' for n in names
        )
        who_input = f'<select name="mm_username" id="mm" required>{opts}</select>'
    else:
        who_input = (
            '<input name="mm_username" id="mm" '
            'placeholder="your mattermost username" required>'
        )

    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Link your PlayStation</title>
<style>
  :root {{
    color-scheme: dark;
    --bg:#070b18; --card:rgba(23,31,54,.72); --line:rgba(120,140,190,.18);
    --txt:#eaf0ff; --dim:#9fb0d4; --psn:#0070d1; --psn2:#00a3ff;
    --ok:#2ee6a0; --err:#ff6b8b; --accent:#7c5cff;
  }}
  * {{ box-sizing:border-box; -webkit-tap-highlight-color:transparent; }}
  html,body {{ margin:0; }}
  body {{ font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color:var(--txt); min-height:100dvh; padding:24px 16px 48px;
    background:var(--bg); overflow-x:hidden; position:relative;
    display:flex; align-items:center; justify-content:center; }}
  /* animated aurora backdrop */
  body::before, body::after {{ content:""; position:fixed; inset:-30% -10%; z-index:-2;
    background:
      radial-gradient(45% 45% at 20% 18%, rgba(0,112,209,.42), transparent 60%),
      radial-gradient(40% 40% at 82% 22%, rgba(124,92,255,.38), transparent 60%),
      radial-gradient(50% 45% at 55% 92%, rgba(0,163,255,.30), transparent 62%);
    filter:blur(28px); animation:drift 18s ease-in-out infinite alternate; }}
  body::after {{ animation-duration:24s; animation-direction:alternate-reverse; opacity:.7; }}
  @keyframes drift {{ from {{ transform:translate3d(-3%,-2%,0) scale(1); }}
    to {{ transform:translate3d(4%,3%,0) scale(1.12); }} }}
  /* subtle star grain */
  .grain {{ position:fixed; inset:0; z-index:-1; opacity:.05; pointer-events:none;
    background-image:radial-gradient(#fff 1px, transparent 1px);
    background-size:26px 26px; }}

  .card {{ width:100%; max-width:460px; background:var(--card);
    border:1px solid var(--line); border-radius:24px; padding:26px 24px 24px;
    box-shadow:0 30px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
    backdrop-filter:blur(22px) saturate(140%);
    -webkit-backdrop-filter:blur(22px) saturate(140%);
    animation:rise .6s cubic-bezier(.2,.8,.2,1) both; }}
  @keyframes rise {{ from {{ opacity:0; transform:translateY(18px) scale(.98); }} }}

  .brand {{ display:flex; align-items:center; gap:12px; margin-bottom:4px; }}
  .logo {{ width:46px; height:46px; border-radius:14px; flex:none;
    display:grid; place-items:center; font-size:24px;
    background:linear-gradient(135deg,var(--psn),var(--accent));
    box-shadow:0 8px 24px rgba(0,112,209,.5); }}
  h1 {{ font-size:21px; margin:0; letter-spacing:.2px; }}
  .tag {{ color:var(--dim); font-size:13px; margin:2px 0 0; }}
  .lead {{ color:var(--dim); font-size:13.5px; line-height:1.55; margin:16px 0 20px; }}

  /* progress rail */
  .rail {{ display:flex; align-items:center; gap:6px; margin:0 0 22px; }}
  .pip {{ flex:1; height:5px; border-radius:99px; background:rgba(255,255,255,.09);
    overflow:hidden; }}
  .pip > i {{ display:block; height:100%; width:0;
    background:linear-gradient(90deg,var(--psn2),var(--accent));
    transition:width .4s ease; }}
  .pip.done > i {{ width:100%; }}

  .step {{ border:1px solid var(--line); border-radius:18px; padding:16px;
    margin-bottom:14px; background:rgba(255,255,255,.025);
    transition:opacity .35s, filter .35s, transform .35s; }}
  .step.locked {{ opacity:.4; filter:grayscale(.5); pointer-events:none; }}
  .step.locked .step-head h2::after {{ content:" 🔒"; font-size:12px; }}
  .step-head {{ display:flex; gap:13px; align-items:flex-start; }}
  .badge {{ width:34px; height:34px; border-radius:11px; flex:none; display:grid;
    place-items:center; font-size:16px; font-weight:800;
    background:linear-gradient(135deg,rgba(0,112,209,.9),rgba(124,92,255,.9));
    color:#fff; box-shadow:0 4px 14px rgba(0,112,209,.4); }}
  .step-head h2 {{ font-size:15.5px; margin:2px 0 3px; }}
  .step-head p {{ font-size:12.5px; color:var(--dim); margin:0; line-height:1.5; }}

  a.btn, button.btn {{ display:flex; align-items:center; justify-content:center; gap:8px;
    width:100%; text-align:center; text-decoration:none; padding:14px;
    border-radius:14px; font-size:15px; font-weight:700; border:none;
    cursor:pointer; margin-top:13px; transition:transform .07s, filter .15s, box-shadow .15s; }}
  a.btn:active, button.btn:active {{ transform:scale(.975); }}
  .btn.psn {{ color:#fff; background:linear-gradient(135deg,var(--psn),var(--psn2));
    box-shadow:0 10px 26px rgba(0,112,209,.45); }}
  .btn.psn:hover {{ box-shadow:0 12px 32px rgba(0,112,209,.6); }}
  .btn.token {{ color:#dfeaff; background:rgba(255,255,255,.06);
    border:1px solid rgba(140,160,255,.28); }}
  .btn.token:hover {{ background:rgba(255,255,255,.11); }}
  .btn.go {{ background:linear-gradient(135deg,var(--accent),var(--psn));
    color:#fff; width:auto; padding:13px 20px; margin:0; white-space:nowrap; }}
  .btn.link {{ background:linear-gradient(135deg,#12d18e,#00b3ff); color:#04210f;
    font-size:16px; box-shadow:0 12px 30px rgba(18,209,142,.4); }}
  .btn.link:hover {{ box-shadow:0 14px 36px rgba(18,209,142,.55); }}
  .btn.paste {{ background:rgba(255,255,255,.06);
    border:1px solid rgba(140,160,255,.24); color:#dfeaff; }}
  .btn.ghost {{ background:transparent; border:1px solid var(--line); color:var(--dim);
    font-weight:600; }}

  label {{ display:block; font-size:12px; color:var(--dim); margin:15px 0 7px;
    font-weight:600; letter-spacing:.3px; }}
  input, textarea, select {{ width:100%; padding:13px 14px; border-radius:13px;
    border:1px solid rgba(140,160,255,.22); background:rgba(6,11,24,.6);
    color:var(--txt); font-size:15px; transition:border .15s, box-shadow .15s;
    -webkit-appearance:none; appearance:none; }}
  select {{ background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%239fb0d4' stroke-width='2'><path d='M2 4l5 5 5-5'/></svg>");
    background-repeat:no-repeat; background-position:right 14px center; padding-right:38px; }}
  input:focus, textarea:focus, select:focus {{ outline:none;
    border-color:var(--psn2); box-shadow:0 0 0 3px rgba(0,163,255,.22); }}
  textarea {{ min-height:78px; resize:vertical; font-family:ui-monospace,SFMono-Regular,monospace;
    font-size:13px; line-height:1.5; }}
  .pass-row {{ display:flex; gap:10px; align-items:stretch; margin-top:14px; }}
  .pass-row input {{ flex:1; font-size:18px; letter-spacing:3px; text-align:center; }}

  .msg {{ padding:13px 15px; border-radius:14px; font-size:13.5px; margin-bottom:18px;
    display:flex; gap:10px; align-items:center; line-height:1.45;
    animation:rise .4s ease both; }}
  .msg.ok {{ background:rgba(46,230,160,.12); border:1px solid rgba(46,230,160,.4);
    color:#9dffd6; }}
  .msg.err {{ background:rgba(255,107,139,.12); border:1px solid rgba(255,107,139,.4);
    color:#ffc0cd; }}
  .err-inline {{ color:var(--err); font-size:12.5px; margin-top:8px; min-height:0; }}
  .hint {{ font-size:11.5px; color:#7d8ab0; margin-top:7px; line-height:1.5; }}
  code {{ background:rgba(255,255,255,.08); padding:1px 6px; border-radius:6px;
    font-size:12px; color:#cfe0ff; }}
  .foot {{ text-align:center; margin-top:18px; }}
  .foot a {{ color:#7fb2ff; font-size:12.5px; text-decoration:none; }}

  /* success celebration */
  .done-hero {{ text-align:center; padding:10px 0 4px; }}
  .done-hero .ring {{ width:82px; height:82px; margin:0 auto 14px; border-radius:50%;
    display:grid; place-items:center; font-size:38px;
    background:radial-gradient(circle at 50% 40%,rgba(46,230,160,.35),rgba(0,179,255,.12));
    box-shadow:0 0 0 3px rgba(46,230,160,.4), 0 12px 40px rgba(46,230,160,.35);
    animation:pop .5s cubic-bezier(.2,1.4,.4,1) both; }}
  @keyframes pop {{ from {{ transform:scale(.4); opacity:0; }} }}
</style></head>
<body>
<div class="grain"></div>
<div class="card">
  <div class="brand">
    <div class="logo" style="background-image:url('/footer-avatar.png');background-size:90%;background-position:center center;background-repeat:no-repeat;"></div>
    <div><h1>Link your PlayStation</h1>
      <p class="tag">One quick setup — then never again.</p></div>
  </div>

  {banner}

  <div id="flow">
    <p class="lead">Connect your PSN account so the squad can see when you're
      online and rally you into games. Takes about 30 seconds.</p>

    <div class="rail" id="rail">
      <div class="pip" id="p0"><i></i></div>
      <div class="pip" id="p1"><i></i></div>
      <div class="pip" id="p2"><i></i></div>
      <div class="pip" id="p3"><i></i></div>
    </div>

    <form method="post" action="/portal/link" id="f">
      <section class="step" id="s1">
        <div class="step-head">
          <span class="badge">1</span>
          <div><h2>Sign in to PlayStation</h2>
            <p>Log into your PSN account in the new tab, then come back here.</p></div>
        </div>
        <a class="btn psn" href="{PSN_LOGIN_URL}" target="_blank" rel="noopener"
           onclick="mark(1)">🎮 Open PlayStation login ↗</a>
      </section>

      <section class="step" id="s2">
        <div class="step-head">
          <span class="badge">2</span>
          <div><h2>Grab your token</h2>
            <p>Opens a Sony page showing <code>{{"npsso":"…"}}</code>. Select all &amp; copy it.</p></div>
        </div>
        <a class="btn token" href="{NPSSO_TOKEN_URL}" target="_blank" rel="noopener"
           onclick="mark(2)">🔑 Open my token page ↗</a>
      </section>

      <section class="step" id="s3">
        <div class="step-head">
          <span class="badge">3</span>
          <div><h2>Paste &amp; link</h2>
            <p>Tell us who you are, paste the token, and you're done.</p></div>
        </div>
        <label>Who are you?</label>
        {who_input}
        <label>Your token</label>
        <textarea name="npsso" id="npsso" oninput="mark(3)"
          placeholder='{{"npsso":"…"}} — paste the whole thing, we sort it out'></textarea>
        <div class="hint">💡 Don't worry about being precise — paste whatever the token page showed.</div>
        <button type="button" class="btn paste" onclick="pasteToken()">📋 Paste from clipboard</button>
        <button type="submit" class="btn link">🔗 Link my account</button>
      </section>
    </form>

    <div class="foot"><a href="/dashboard">← Back to the Squad dashboard</a></div>
  </div>
</div>

<script>
  function setPip(i){{ const p=document.getElementById('p'+i); if(p) p.classList.add('done'); }}
  function mark(n){{ setPip(n); }}
  setPip(0);  // unlocked to reach this page

  async function pasteToken(){{
    try {{
      const t = await navigator.clipboard.readText();
      if(t){{ const box=document.getElementById('npsso'); box.value=t.trim();
        mark(3); box.focus(); }}
    }} catch(e) {{ document.getElementById('npsso').focus(); }}
  }}
</script>
</body></html>"""


# ── Zitadel OIDC auth ────────────────────────────────────────────────────────
#
# Authorization-code + PKCE flow. No client secret needed.
# Required env vars: ZITADEL_CLIENT_ID, SESSION_SECRET
# Redirect URI to register in Zitadel: https://app.crcmz.me/auth/callback

import hashlib as _hashlib, base64 as _base64, secrets as _secrets
from urllib.parse import urlencode as _urlencode
from itsdangerous import URLSafeTimedSerializer as _USTS, BadSignature, SignatureExpired

ZITADEL_ISSUER        = os.environ.get("ZITADEL_ISSUER", "https://auth.crcmz.me")
ZITADEL_CLIENT_ID     = os.environ.get("ZITADEL_CLIENT_ID", "")
ZITADEL_SERVICE_TOKEN = os.environ.get("ZITADEL_SERVICE_TOKEN", "")
SESSION_SECRET        = os.environ.get("SESSION_SECRET", "")

# WhatsApp import authorization — BOTH conditions must hold
WHATSAPP_IMPORT_ALLOWED_ROLE = os.environ.get("WHATSAPP_IMPORT_ALLOWED_ROLE", "IAM Owner Viewer")
WA_INGEST_SECRET             = os.environ.get("WA_INGEST_SECRET", "")
WA_NAME_ALIASES              = os.environ.get("WA_NAME_ALIASES", "")

_SESSION_COOKIE    = "psn_session"
_OIDC_STATE_COOKIE = "psn_oidc_state"
_SESSION_MAX_AGE   = 60 * 60 * 24 * 30  # 30 days
_OIDC_CONFIG_CACHE: dict = {}

# The only public hostname; bare IPs from the tailnet/LAN bypass auth.
_PUBLIC_HOST = os.environ.get("PORTAL_PUBLIC_HOST", "app.crcmz.me")
# Paths that must be reachable before authentication.
_OPEN_PATHS = {"/health", "/v2/health", "/auth/login", "/auth/callback",
               "/auth/logout", "/auth/passkey/begin", "/auth/passkey/complete",
               "/.well-known/webauthn",
               # Public key material only — WatchParty fetches this to verify
               # Watch Tickets. Never contains a private key.
               "/api/watch/jwks.json"}


def _signer() -> _USTS:
    return _USTS(SESSION_SECRET or "dev-insecure", salt="psn-session")


def _state_signer() -> _USTS:
    return _USTS(SESSION_SECRET or "dev-insecure", salt="psn-oidc-state")


def _get_session(request: Request) -> dict | None:
    val = request.cookies.get(_SESSION_COOKIE)
    if not val:
        return None
    try:
        return _signer().loads(val, max_age=_SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None


def _make_session(sub: str, email: str = "", name: str = "",
                  preferred_username: str = "") -> dict:
    """Build the signed session payload.

    ``iss`` + ``sub`` is the permanent identity (see watch.py); the name claims
    are cached here so Watch Party doesn't have to re-query Zitadel on every
    ticket. Sessions minted before these fields existed still work — the Watch
    resolver falls back to a Zitadel lookup.
    """
    session = {"sub": sub, "email": email, "iss": ZITADEL_ISSUER.rstrip("/")}
    if name:
        session["name"] = name
    if preferred_username:
        session["preferred_username"] = preferred_username
    return session


def _pkce() -> tuple[str, str]:
    verifier = _base64.urlsafe_b64encode(_secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = _base64.urlsafe_b64encode(
        _hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


async def _oidc_cfg() -> dict:
    global _OIDC_CONFIG_CACHE
    if _OIDC_CONFIG_CACHE:
        return _OIDC_CONFIG_CACHE
    import httpx as _hx
    async with _hx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{ZITADEL_ISSUER}/.well-known/openid-configuration")
        r.raise_for_status()
        _OIDC_CONFIG_CACHE = r.json()
    return _OIDC_CONFIG_CACHE


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    path = request.url.path
    if path in _OPEN_PATHS:
        return await call_next(request)

    # Tailscale/LAN direct-IP hits (Stream Deck, etc.) bypass auth entirely.
    host = (request.headers.get("host") or "").split(":")[0]
    if host != _PUBLIC_HOST:
        return await call_next(request)

    if _get_session(request):
        return await call_next(request)

    accept = request.headers.get("accept", "")
    if request.method == "GET" and "text/html" in accept:
        next_url = request.url.path
        if request.url.query:
            next_url += "?" + request.url.query
        return RedirectResponse(url=f"/auth/login?next={next_url}", status_code=302)
    return JSONResponse({"detail": "authentication required"}, status_code=401)


def _login_page(error: str = "", next: str = "/") -> str:
    err_html = f'<div class="msg err">⚠️ {error}</div>' if error else ""
    safe_next = next if next.startswith("/") else "/"
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Sign in · CRCMZ APP</title>
<style>
  :root {{ color-scheme:dark; }}
  * {{ box-sizing:border-box; -webkit-tap-highlight-color:transparent; }}
  html,body {{ margin:0; }}
  body {{ font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color:#f3ecff; min-height:100dvh; display:flex; align-items:center;
    justify-content:center; padding:24px 16px; background:#05030f;
    position:relative; overflow:hidden; }}
  body::before {{ content:""; position:fixed; inset:-30% -10%; z-index:-1;
    background:
      radial-gradient(38% 40% at 18% 12%, rgba(255,47,214,.34), transparent 60%),
      radial-gradient(40% 40% at 84% 18%, rgba(34,230,255,.30), transparent 60%),
      radial-gradient(46% 42% at 55% 96%, rgba(157,92,255,.28), transparent 62%);
    filter:blur(34px); animation:drift 22s ease-in-out infinite alternate; }}
  @keyframes drift {{ to {{ transform:translate3d(4%,3%,0) scale(1.12); }} }}
  .card {{ width:100%; max-width:400px; background:rgba(18,10,38,.76);
    border:1px solid rgba(255,60,200,.24); border-radius:24px; padding:32px 28px 28px;
    box-shadow:0 30px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06);
    backdrop-filter:blur(22px); -webkit-backdrop-filter:blur(22px);
    animation:rise .5s cubic-bezier(.2,.8,.2,1) both; }}
  @keyframes rise {{ from {{ opacity:0; transform:translateY(18px) scale(.97); }} }}
  .brand {{ display:flex; align-items:center; gap:13px; margin-bottom:26px; }}
  .logo {{ width:50px; height:50px; border-radius:14px; flex:none; display:grid;
    place-items:center; font-size:26px;
    background:linear-gradient(135deg,#ff2fd6,#9d5cff);
    box-shadow:0 0 22px rgba(255,47,214,.6), 0 0 44px rgba(157,92,255,.3);
    border:1px solid rgba(255,255,255,.15); }}
  h1 {{ font-size:22px; margin:0; font-weight:800; letter-spacing:.5px;
    background:linear-gradient(90deg,#22e6ff,#ff2fd6);
    -webkit-background-clip:text; background-clip:text; color:transparent; }}
  .sub {{ color:#9d8fc4; font-size:12px; margin:3px 0 0; letter-spacing:1px;
    text-transform:uppercase; }}
  label {{ display:block; font-size:11.5px; color:#9d8fc4; margin:18px 0 7px;
    font-weight:700; letter-spacing:.4px; text-transform:uppercase; }}
  input {{ width:100%; padding:14px; border-radius:13px;
    border:1px solid rgba(140,160,255,.22); background:rgba(6,4,18,.7);
    color:#f3ecff; font-size:15px; -webkit-appearance:none; appearance:none;
    transition:border .15s, box-shadow .15s; }}
  input:focus {{ outline:none; border-color:#22e6ff;
    box-shadow:0 0 0 3px rgba(34,230,255,.18); }}
  .btn {{ display:flex; align-items:center; justify-content:center; width:100%;
    margin-top:24px; padding:15px; border-radius:14px; border:none;
    font-size:15.5px; font-weight:800; cursor:pointer; letter-spacing:.5px;
    background:linear-gradient(135deg,#ff2fd6,#9d5cff); color:#fff;
    box-shadow:0 10px 28px rgba(255,47,214,.45);
    transition:filter .15s, transform .07s; }}
  .btn:hover {{ filter:brightness(1.12); }}
  .btn:active {{ transform:scale(.975); }}
  .btn:disabled {{ opacity:.55; cursor:default; }}
  .divider {{ display:flex; align-items:center; gap:10px; margin:18px 0 4px;
    color:#6a5d8a; font-size:12px; font-weight:600; letter-spacing:.5px; }}
  .divider::before,.divider::after {{ content:""; flex:1; height:1px;
    background:rgba(255,255,255,.08); }}
  .btn-passkey {{ display:flex; align-items:center; justify-content:center; gap:9px;
    width:100%; margin-top:12px; padding:14px; border-radius:14px;
    border:1px solid rgba(34,230,255,.4); background:rgba(34,230,255,.07);
    color:#22e6ff; font-size:15px; font-weight:700; cursor:pointer;
    transition:background .15s, transform .07s; letter-spacing:.3px; }}
  .btn-passkey:hover {{ background:rgba(34,230,255,.14); }}
  .btn-passkey:active {{ transform:scale(.975); }}
  .btn-passkey:disabled {{ opacity:.5; cursor:default; }}
  .msg {{ padding:13px 15px; border-radius:13px; font-size:13.5px;
    margin-bottom:6px; display:flex; gap:10px; align-items:center; line-height:1.45; }}
  .err {{ background:rgba(255,107,139,.12); border:1px solid rgba(255,107,139,.4);
    color:#ffc0cd; }}
</style></head>
<body><div class="card">
  <div class="brand">
    <div class="logo" style="background-image:url('/footer-avatar.png');background-size:90%;background-position:center center;background-repeat:no-repeat;"></div>
    <div><h1>CRCMZ APP</h1><p class="sub">Yes. We have one.</p></div>
  </div>
  {err_html}
  <form method="post" action="/auth/login?next={safe_next}" id="f">
    <label for="em">Email or username</label>
    <input type="text" name="email" id="em" autocomplete="username webauthn"
      placeholder="Email or username" inputmode="email">
    <label for="pw">Password</label>
    <input type="password" name="pw" id="pw" required autocomplete="current-password"
      placeholder="Your password">
    <button type="submit" class="btn" id="btn">Sign in →</button>
  </form>
  <div class="divider">or</div>
  <button class="btn-passkey" id="pkBtn" onclick="passkeyLogin()">🔑 Sign in with Passkey</button>
  <div id="errmsg"></div>
</div>
<script>
  const params = new URLSearchParams(location.search);
  const nextUrl = params.get('next') || '/';

  document.getElementById('f').addEventListener('submit', () => {{
    const b = document.getElementById('btn');
    b.disabled = true; b.textContent = 'Signing in…';
  }});

  function showErr(msg) {{
    const el = document.getElementById('errmsg');
    el.innerHTML = '<div class="msg err" style="margin-top:12px">⚠️ '+msg+'</div>';
  }}

  function b64url(buf) {{
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  }}
  function fromB64url(s) {{
    const pad = '='.repeat((4-s.length%4)%4);
    const b64 = (s+pad).replace(/-/g,'+').replace(/_/g,'/');
    return Uint8Array.from(atob(b64),c=>c.charCodeAt(0)).buffer;
  }}

  // Shared: send assertion to server and redirect on success.
  async function _completePasskey(sessionId, cred) {{
    const assertion = {{
      id: cred.id, rawId: b64url(cred.rawId), type: cred.type,
      response: {{
        clientDataJSON:    b64url(cred.response.clientDataJSON),
        authenticatorData: b64url(cred.response.authenticatorData),
        signature:         b64url(cred.response.signature),
        userHandle: cred.response.userHandle ? b64url(cred.response.userHandle) : null,
      }},
    }};
    const cr = await fetch('/auth/passkey/complete?next='+encodeURIComponent(nextUrl),{{
      method:'POST', headers:{{'Content-Type':'application/json'}},
      body: JSON.stringify({{sessionId, assertion}})
    }});
    if (!cr.ok) {{ showErr((await cr.json()).error || 'Passkey verification failed.'); return false; }}
    const {{next}} = await cr.json();
    window.location.href = next;
    return true;
  }}

  // Fetch a challenge from the server and decode it.
  // silent=true suppresses the visible error (used by conditional background flow).
  async function _beginPasskey(identifier, silent=false) {{
    const br = await fetch('/auth/passkey/begin',{{
      method:'POST', headers:{{'Content-Type':'application/json'}},
      body: JSON.stringify(identifier ? {{identifier}} : {{}})
    }});
    if (!br.ok) {{
      if (!silent) showErr((await br.json()).error || 'Could not start passkey flow.');
      return null;
    }}
    const {{sessionId, options}} = await br.json();
    options.challenge = fromB64url(options.challenge);
    if (options.allowCredentials)
      options.allowCredentials = options.allowCredentials.map(c=>
        ({{...c, id: fromB64url(c.id)}}));
    return {{sessionId, options}};
  }}

  // Conditional UI: starts silently on page load. The browser shows the passkey
  // as an autocomplete suggestion in the email field — user just taps it, no
  // button press needed. Aborted if the user clicks the explicit button instead.
  let _conditionalAbort = null;
  async function _startConditional() {{
    if (!window.PublicKeyCredential) return;
    const supported = await PublicKeyCredential.isConditionalMediationAvailable?.() ?? false;
    if (!supported) return;
    const began = await _beginPasskey('', true);  // silent — no error shown on page load
    if (!began) return;
    _conditionalAbort = new AbortController();
    try {{
      const cred = await navigator.credentials.get({{
        publicKey: began.options,
        mediation: 'conditional',
        signal: _conditionalAbort.signal,
      }});
      await _completePasskey(began.sessionId, cred);
    }} catch(e) {{
      // AbortError = user clicked the explicit button instead; anything else is unexpected.
      if (e.name !== 'AbortError' && e.name !== 'NotAllowedError')
        console.warn('conditional passkey error:', e);
    }}
  }}
  _startConditional();

  // Explicit button: abort any pending conditional request, then show the picker.
  async function passkeyLogin() {{
    if (!window.PublicKeyCredential) {{ showErr('Passkeys not supported in this browser.'); return; }}
    if (_conditionalAbort) {{ _conditionalAbort.abort(); _conditionalAbort = null; }}
    const identifier = document.getElementById('em').value.trim();
    if (!identifier) {{ document.getElementById('em').focus(); showErr('Enter your email first, then tap the passkey button.'); return; }}
    const btn = document.getElementById('pkBtn');
    btn.disabled = true; btn.textContent = '🔑 Waiting for passkey…';
    try {{
      const began = await _beginPasskey(identifier);
      if (!began) return;
      const cred = await navigator.credentials.get({{publicKey: began.options}});
      await _completePasskey(began.sessionId, cred);
    }} catch(e) {{
      if (e.name !== 'NotAllowedError') showErr('Passkey error: '+e.message);
    }} finally {{
      btn.disabled = false; btn.textContent = '🔑 Sign in with Passkey';
    }}
  }}
</script>
</body></html>"""


@app.get("/auth/login")
async def auth_login(request: Request, next: str = "/"):
    # Custom embedded form when service token is configured.
    if ZITADEL_SERVICE_TOKEN:
        return HTMLResponse(_login_page(next=next))
    # Fallback: PKCE redirect to Zitadel Login V2.
    if not ZITADEL_CLIENT_ID:
        return HTMLResponse("<h1>ZITADEL_CLIENT_ID not configured</h1>", status_code=503)
    try:
        cfg = await _oidc_cfg()
    except Exception as e:
        return HTMLResponse(f"<h1>Auth service unavailable: {e}</h1>", status_code=503)
    verifier, challenge = _pkce()
    state = _secrets.token_urlsafe(16)
    signed_state = _state_signer().dumps({"state": state, "verifier": verifier, "next": next[:200]})
    params = _urlencode({
        "client_id": ZITADEL_CLIENT_ID,
        "redirect_uri": f"https://{_PUBLIC_HOST}/auth/callback",
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    resp = RedirectResponse(url=f"{cfg['authorization_endpoint']}?{params}", status_code=302)
    resp.set_cookie(_OIDC_STATE_COOKIE, signed_state, httponly=True, samesite="lax",
                    secure=True, max_age=600, path="/")
    return resp


@app.post("/auth/login")
async def auth_login_submit(request: Request, next: str = "/"):
    form = await request.form()
    email    = (form.get("email") or "").strip()
    password = (form.get("pw")    or "").strip()

    if not email or not password:
        return HTMLResponse(_login_page(error="Email and password are required.", next=next), status_code=400)
    if not ZITADEL_SERVICE_TOKEN:
        return HTMLResponse(_login_page(error="Auth service not configured.", next=next), status_code=503)

    import httpx as _hx

    async def _resolve_login_name(identifier: str) -> str:
        """If identifier looks like an email and direct lookup fails, search by email."""
        if "@" not in identifier:
            return identifier
        try:
            async with _hx.AsyncClient(timeout=10) as c:
                sr = await c.post(
                    f"{ZITADEL_ISSUER}/management/v1/users/_search",
                    json={"queries": [{"emailQuery": {"emailAddress": identifier,
                                                      "method": "TEXT_QUERY_METHOD_EQUALS"}}]},
                    headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
                )
            if sr.status_code == 200:
                results = sr.json().get("result", [])
                if results:
                    return results[0].get("preferredLoginName", identifier)
        except Exception:
            pass
        return identifier

    try:
        login_name = await _resolve_login_name(email)
        async with _hx.AsyncClient(timeout=15) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/v2/sessions",
                json={"checks": {
                    "user":     {"loginName": login_name},
                    "password": {"password": password},
                }},
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code not in (200, 201):
            logger.warning("auth: session create %s for %s (loginName=%s)", r.status_code, email, login_name)
            return HTMLResponse(_login_page(error="Invalid email or password.", next=next), status_code=401)

        session_id = r.json().get("sessionId", "")
        async with _hx.AsyncClient(timeout=10) as c:
            sr = await c.get(
                f"{ZITADEL_ISSUER}/v2/sessions/{session_id}",
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        user_f = sr.json().get("session", {}).get("factors", {}).get("user", {})
        sub        = user_f.get("id", "")
        user_email = user_f.get("loginName", email)
        disp_name  = user_f.get("displayName", "")
        login_name = user_f.get("loginName", "")
    except Exception as e:
        logger.error("auth: login error: %s", e)
        return HTMLResponse(_login_page(error="Auth service unavailable.", next=next), status_code=503)

    if not sub:
        return HTMLResponse(_login_page(error="Invalid email or password.", next=next), status_code=401)

    safe_next = next if next.startswith("/") else "/"
    session = _make_session(sub, user_email, name=disp_name, preferred_username=login_name)
    resp = RedirectResponse(url=safe_next, status_code=302)
    resp.set_cookie(_SESSION_COOKIE, _signer().dumps(session), httponly=True,
                    samesite="lax", secure=True, max_age=_SESSION_MAX_AGE, path="/")
    return resp


@app.get("/auth/callback")
async def auth_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    if error or not code:
        return RedirectResponse(url="/auth/login", status_code=302)

    signed_state = request.cookies.get(_OIDC_STATE_COOKIE)
    if not signed_state:
        return RedirectResponse(url="/auth/login", status_code=302)
    try:
        sp = _state_signer().loads(signed_state, max_age=600)
    except (BadSignature, SignatureExpired):
        return RedirectResponse(url="/auth/login", status_code=302)
    if sp.get("state") != state:
        return RedirectResponse(url="/auth/login", status_code=302)

    try:
        cfg = await _oidc_cfg()
        import httpx as _hx
        async with _hx.AsyncClient(timeout=15) as c:
            tr = await c.post(cfg["token_endpoint"], data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": f"https://{_PUBLIC_HOST}/auth/callback",
                "client_id": ZITADEL_CLIENT_ID,
                "code_verifier": sp["verifier"],
            })
        if tr.status_code != 200:
            logger.error("oidc: token exchange failed %s: %s", tr.status_code, tr.text[:200])
            return RedirectResponse(url="/auth/login", status_code=302)

        access_token = tr.json().get("access_token", "")
        async with _hx.AsyncClient(timeout=10) as c:
            ur = await c.get(cfg["userinfo_endpoint"],
                             headers={"Authorization": f"Bearer {access_token}"})
        if ur.status_code != 200:
            logger.error("oidc: userinfo failed %s", ur.status_code)
            return RedirectResponse(url="/auth/login", status_code=302)
        userinfo = ur.json()
    except Exception as e:
        logger.error("oidc: callback error: %s", e)
        return RedirectResponse(url="/auth/login", status_code=302)

    next_url = sp.get("next") or "/"
    if not next_url.startswith("/"):
        next_url = "/"
    # Zitadel's own userinfo response is the authoritative source for the
    # profile claims. Cache the display-name claims for Watch Party; note
    # preferred_username is a *login name* (e.g. moiz@crcmz), not a PSN id.
    session = _make_session(
        userinfo.get("sub") or "",
        userinfo.get("email", ""),
        name=userinfo.get("name", ""),
        preferred_username=userinfo.get("preferred_username", ""),
    )
    if userinfo.get("iss"):
        session["iss"] = str(userinfo["iss"]).rstrip("/")

    resp = RedirectResponse(url=next_url, status_code=302)
    resp.set_cookie(_SESSION_COOKIE, _signer().dumps(session), httponly=True, samesite="lax",
                    secure=True, max_age=_SESSION_MAX_AGE, path="/")
    resp.delete_cookie(_OIDC_STATE_COOKIE, path="/")
    return resp


@app.post("/auth/passkey/begin")
async def passkey_begin(request: Request):
    """Step 1: ask Zitadel for a WebAuthn challenge.

    With identifier: user-specific flow — allowCredentials is scoped to that account.
    Without identifier: usernameless/discoverable flow — browser shows OS passkey picker,
    no email entry required.
    """
    if not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"error": "not configured"}, status_code=503)
    body = await request.json()
    identifier = (body.get("identifier") or "").strip()

    import httpx as _hx

    domain = ZITADEL_ISSUER.replace("https://", "").replace("http://", "").rstrip("/")
    webauthn_challenge = {
        "domain": domain,
        "userVerificationRequirement": "USER_VERIFICATION_REQUIREMENT_REQUIRED",
    }

    if identifier:
        # Resolve email → loginName if needed.
        login_name = identifier
        if "@" in identifier:
            try:
                async with _hx.AsyncClient(timeout=10) as c:
                    sr = await c.post(
                        f"{ZITADEL_ISSUER}/management/v1/users/_search",
                        json={"queries": [{"emailQuery": {"emailAddress": identifier,
                                                          "method": "TEXT_QUERY_METHOD_EQUALS"}}]},
                        headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
                    )
                if sr.status_code == 200:
                    results = sr.json().get("result", [])
                    if results:
                        login_name = results[0].get("preferredLoginName", identifier)
            except Exception:
                pass
        session_body = {
            "checks": {"user": {"loginName": login_name}},
            "challenges": {"webAuthN": webauthn_challenge},
        }
    else:
        # Usernameless: no user check → empty allowCredentials → OS passkey picker.
        session_body = {"challenges": {"webAuthN": webauthn_challenge}}

    try:
        async with _hx.AsyncClient(timeout=15) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/v2/sessions",
                json=session_body,
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code not in (200, 201):
            logger.warning("passkey/begin: %s body=%s", r.status_code, r.text[:200])
            return JSONResponse({"error": "could not start passkey flow"}, status_code=404)
        data = r.json()
        raw = data.get("challenges", {}).get("webAuthN", {}).get("publicKeyCredentialRequestOptions")
        if not raw:
            return JSONResponse({"error": "no webauthn challenge returned"}, status_code=500)
        options = raw.get("publicKey") or raw
        return JSONResponse({"sessionId": data["sessionId"], "options": options})
    except Exception as e:
        logger.error("passkey/begin error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)


@app.post("/auth/passkey/complete")
async def passkey_complete(request: Request, next: str = "/"):
    """Step 2: verify the WebAuthn assertion with Zitadel, set session cookie."""
    if not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"error": "not configured"}, status_code=503)
    body = await request.json()
    session_id = (body.get("sessionId") or "").strip()
    assertion  = body.get("assertion")
    if not session_id or not assertion:
        return JSONResponse({"error": "sessionId and assertion required"}, status_code=400)

    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=15) as c:
            r = await c.patch(
                f"{ZITADEL_ISSUER}/v2/sessions/{session_id}",
                json={"checks": {"webAuthN": {"credentialAssertionData": assertion}}},
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code not in (200, 201):
            logger.warning("passkey/complete: %s for session %s: %s", r.status_code, session_id, r.text[:200])
            return JSONResponse({"error": "passkey verification failed"}, status_code=401)

        async with _hx.AsyncClient(timeout=10) as c:
            sr = await c.get(
                f"{ZITADEL_ISSUER}/v2/sessions/{session_id}",
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        user_f     = sr.json().get("session", {}).get("factors", {}).get("user", {})
        sub        = user_f.get("id", "")
        user_email = user_f.get("loginName", "")
        disp_name  = user_f.get("displayName", "")
    except Exception as e:
        logger.error("passkey/complete error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)

    if not sub:
        return JSONResponse({"error": "session invalid"}, status_code=401)

    safe_next = next if next.startswith("/") else "/"
    session = _make_session(sub, user_email, name=disp_name, preferred_username=user_email)
    resp = JSONResponse({"ok": True, "next": safe_next})
    resp.set_cookie(_SESSION_COOKIE, _signer().dumps(session), httponly=True,
                    samesite="lax", secure=True, max_age=_SESSION_MAX_AGE, path="/")
    return resp


@app.post("/auth/passkey/register/begin")
async def passkey_register_begin(request: Request):
    """Start passkey registration for the logged-in user."""
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    if not user_id or not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"error": "not configured"}, status_code=503)

    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=15) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/v2/users/{user_id}/passkeys",
                json={"returnCode": {}},
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code not in (200, 201):
            logger.warning("passkey/register/begin: %s %s", r.status_code, r.text[:200])
            return JSONResponse({"error": "failed to initiate"}, status_code=500)
        d = r.json()
        passkey_id = d.get("passkeyId", "")
        # Zitadel wraps creation options as {"publicKey": {...}} — unwrap so the
        # browser's navigator.credentials.create({publicKey: options}) gets the
        # right shape directly.
        wrapper = d.get("publicKeyCredentialCreationOptions") or {}
        options = wrapper.get("publicKey") or wrapper
        if not options:
            return JSONResponse({"error": "no creation options returned"}, status_code=500)
        return JSONResponse({"passkeyId": passkey_id, "options": options})
    except Exception as e:
        logger.error("passkey/register/begin error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)


@app.post("/auth/passkey/register/complete")
async def passkey_register_complete(request: Request):
    """Verify and store the new passkey credential."""
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    body = await request.json()
    passkey_id = body.get("passkeyId", "")
    credential = body.get("credential")
    passkey_name = (body.get("passkeyName") or "My passkey")[:200]
    if not user_id or not passkey_id or not credential:
        return JSONResponse({"error": "missing fields"}, status_code=400)

    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=15) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/v2/users/{user_id}/passkeys/{passkey_id}",
                json={"passkeyName": passkey_name, "publicKeyCredential": credential},
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code not in (200, 201):
            logger.warning("passkey/register/complete: %s %s", r.status_code, r.text[:200])
            return JSONResponse({"error": "registration failed"}, status_code=400)
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.error("passkey/register/complete error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)


@app.get("/auth/settings/passkeys")
async def settings_list_passkeys(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    if not user_id or not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"passkeys": []})

    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/zitadel.user.v2.UserService/ListPasskeys",
                json={"userId": user_id},
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code not in (200, 201):
            logger.warning("settings/passkeys list: %s %s", r.status_code, r.text[:200])
            return JSONResponse({"passkeys": []})
        data = r.json()
        passkeys = [
            {"id": pk.get("id"), "name": pk.get("name") or "Passkey"}
            for pk in data.get("result", [])
            if pk.get("state") != "AUTH_FACTOR_STATE_NOT_READY"
        ]
        return JSONResponse({"passkeys": passkeys})
    except Exception as e:
        logger.error("settings/passkeys list error: %s", e)
        return JSONResponse({"passkeys": []})


@app.delete("/auth/settings/passkeys/{passkey_id}")
async def settings_delete_passkey(passkey_id: str, request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    if not user_id or not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"error": "not configured"}, status_code=503)

    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=10) as c:
            r = await c.delete(
                f"{ZITADEL_ISSUER}/v2/users/{user_id}/passkeys/{passkey_id}",
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code not in (200, 201, 204):
            logger.warning("settings/passkeys delete: %s %s", r.status_code, r.text[:200])
            return JSONResponse({"error": "failed to delete"}, status_code=400)
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.error("settings/passkeys delete error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)


@app.post("/auth/settings/password")
async def settings_change_password(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    if not user_id or not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"error": "not configured"}, status_code=503)
    body = await request.json()
    current = body.get("currentPassword", "")
    new_pw = body.get("newPassword", "")
    if not current or not new_pw:
        return JSONResponse({"error": "missing fields"}, status_code=400)

    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/zitadel.user.v2.UserService/SetPassword",
                json={
                    "userId": user_id,
                    "currentPassword": current,
                    "newPassword": {"password": new_pw, "changeRequired": False},
                },
                headers={
                    "Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}",
                    "Connect-Protocol-Version": "1",
                },
            )
        if r.status_code not in (200, 201):
            d = r.json()
            msg = d.get("message", "")
            if "invalid" in msg.lower() or "incorrect" in msg.lower() or r.status_code in (400, 401):
                user_msg = "Current password is incorrect." if "invalid" in msg.lower() else msg or "Failed to update password."
                return JSONResponse({"error": user_msg}, status_code=400)
            logger.warning("settings/password: %s %s", r.status_code, r.text[:200])
            return JSONResponse({"error": "Failed to update password."}, status_code=400)
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.error("settings/password error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)


@app.get("/api/admin/check")
async def admin_check(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"admin": False})
    is_admin = await _is_iam_admin(session.get("sub", ""))
    return JSONResponse({"admin": is_admin})


@app.get("/api/admin/users")
async def admin_list_users(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    if not await _is_iam_admin(session.get("sub", "")):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"error": "not configured"}, status_code=503)
    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/management/v1/users/_search",
                json={"queries": [{"typeQuery": {"type": "TYPE_HUMAN"}}], "pageSize": 200},
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code != 200:
            logger.warning("admin/users list: %s %s", r.status_code, r.text[:200])
            return JSONResponse({"error": "upstream error"}, status_code=502)
        raw = r.json().get("result", [])
        users = []
        for u in raw:
            human = u.get("human") or {}
            profile = human.get("profile") or {}
            email_obj = human.get("email") or {}
            display = (
                profile.get("displayName")
                or f"{profile.get('firstName','')} {profile.get('lastName','')}".strip()
                or u.get("userName", "")
            )
            users.append({
                "userId": u.get("userId", ""),
                "userName": u.get("userName", ""),
                "displayName": display,
                "email": email_obj.get("email", ""),
                "state": u.get("state", ""),
            })
        return JSONResponse({"users": users})
    except Exception as e:
        logger.error("admin/users list error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)


@app.post("/api/admin/users/{user_id}/reset-password")
async def admin_reset_password(user_id: str, request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    if not await _is_iam_admin(session.get("sub", "")):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not ZITADEL_SERVICE_TOKEN:
        return JSONResponse({"error": "not configured"}, status_code=503)
    body = await request.json()
    new_pw = (body.get("newPassword") or "").strip()
    if len(new_pw) < 8:
        return JSONResponse({"error": "Password must be at least 8 characters."}, status_code=400)
    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/zitadel.user.v2.UserService/SetPassword",
                json={
                    "userId": user_id,
                    "newPassword": {"password": new_pw, "changeRequired": True},
                },
                headers={
                    "Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}",
                    "Connect-Protocol-Version": "1",
                },
            )
        if r.status_code not in (200, 201):
            d = r.json()
            msg = d.get("message", "") or "Failed to reset password."
            logger.warning("admin/reset-password: %s %s", r.status_code, r.text[:200])
            return JSONResponse({"error": msg}, status_code=400)
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.error("admin/reset-password error: %s", e)
        return JSONResponse({"error": "service unavailable"}, status_code=503)


_admin_cache: dict[str, tuple[bool, float]] = {}  # user_id → (is_admin, expires_ts)


async def _is_iam_admin(user_id: str) -> bool:
    """Check if user has any IAM role in Zitadel. Result cached for 5 minutes."""
    import time as _time
    now = _time.time()
    cached = _admin_cache.get(user_id)
    if cached and cached[1] > now:
        return cached[0]
    result = False
    if ZITADEL_SERVICE_TOKEN:
        import httpx as _hx
        try:
            async with _hx.AsyncClient(timeout=8) as c:
                r = await c.post(
                    f"{ZITADEL_ISSUER}/admin/v1/members/_search",
                    json={"queries": [{"userIdQuery": {"userId": user_id}}]},
                    headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
                )
            if r.status_code == 200:
                result = bool(r.json().get("result"))
        except Exception as e:
            logger.warning("admin check failed for %s: %s", user_id, e)
    _admin_cache[user_id] = (result, now + 300)
    return result


_import_auth_cache: dict[str, tuple[bool, float]] = {}


async def _is_whatsapp_importer(session: dict) -> bool:
    """True iff session user has the required Zitadel role. Result cached for 5 minutes."""
    sub = session.get("sub", "")
    if not sub or not WHATSAPP_IMPORT_ALLOWED_ROLE or not ZITADEL_SERVICE_TOKEN:
        return False
    import time as _t
    now = _t.time()
    cached = _import_auth_cache.get(sub)
    if cached and cached[1] > now:
        return cached[0]

    def _norm(r: str) -> str:
        return r.strip().upper().replace(" ", "_").replace("-", "_")

    allowed_norm = _norm(WHATSAPP_IMPORT_ALLOWED_ROLE)
    result = False
    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=8) as c:
            r = await c.post(
                f"{ZITADEL_ISSUER}/admin/v1/members/_search",
                json={"queries": [{"userIdQuery": {"userId": sub}}]},
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code == 200:
            for member in r.json().get("result", []):
                for role in member.get("roles", []):
                    if _norm(role) == allowed_norm:
                        result = True
                        break
    except Exception as exc:
        logger.warning("whatsapp importer check failed for %s: %s", sub, exc)
    _import_auth_cache[sub] = (result, now + 300)
    return result


# ── WhatsApp Analytics API ─────────────────────────────────────────────────────

def _wa_params(request: Request) -> tuple[str, str, str]:
    """Extract (range, start, end) query params."""
    q = request.query_params
    return q.get("range", "all_time"), q.get("start", ""), q.get("end", "")


@app.get("/api/whatsapp/stats")
def wa_stats(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.stats(rng, s, e))


@app.get("/api/whatsapp/activity")
def wa_activity(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.activity(rng, s, e))


@app.get("/api/whatsapp/heatmap")
def wa_heatmap(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.heatmap(rng, s, e))


@app.get("/api/whatsapp/words")
def wa_words(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.words(rng, s, e))


@app.get("/api/whatsapp/emojis")
def wa_emojis(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.emojis(rng, s, e))


@app.get("/api/whatsapp/response-times")
def wa_response_times(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.response_times(rng, s, e))


@app.get("/api/whatsapp/members")
def wa_members(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.members(rng, s, e))


@app.get("/api/whatsapp/awards")
def wa_awards(request: Request):
    rng, s, e = _wa_params(request)
    return JSONResponse(_wa.awards(rng, s, e))


@app.get("/api/whatsapp/can-import")
async def wa_can_import(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"can_import": False})
    return JSONResponse({"can_import": await _is_whatsapp_importer(session)})


@app.get("/api/whatsapp/export")
async def wa_export(request: Request):
    session = _get_session(request)
    if not session:
        raise HTTPException(status_code=401, detail="authentication required")
    rng, s, e = _wa_params(request)
    try:
        data = await asyncio.to_thread(_wa.export_xlsx, rng, s, e)
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="whatsapp_analytics_{rng}.xlsx"'},
    )


@app.post("/api/whatsapp/import")
async def wa_import(
    request: Request,
    file: UploadFile = File(...),
    group_jid: str = Form(default=""),
):
    """Import a WhatsApp export. Requires WHATSAPP_IMPORT_ALLOWED_ROLE."""
    session = _get_session(request)
    if not session:
        raise HTTPException(status_code=401, detail="authentication required")
    if not await _is_whatsapp_importer(session):
        raise HTTPException(status_code=403, detail="not authorized to import WhatsApp history")

    fname = file.filename or "export.txt"
    ext = fname.rsplit(".", 1)[-1].lower()
    if ext not in ("txt", "zip"):
        raise HTTPException(status_code=400, detail="only .txt and .zip exports supported")

    content = await file.read()
    if len(content) > _wa.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file too large (max 50 MB)")

    try:
        result = await asyncio.to_thread(
            _wa.import_messages, content, fname,
            group_jid or WA_GOOPERS_JID or "",
            session["sub"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return JSONResponse(result)


@app.post("/api/whatsapp/ingest")
async def wa_ingest(request: Request):
    """Receive a single live message from the Baileys bridge (internal use)."""
    secret = request.headers.get("x-ingest-secret", "")
    if WA_INGEST_SECRET and secret != WA_INGEST_SECRET:
        raise HTTPException(status_code=403, detail="invalid ingest secret")
    body = await request.json()
    # Support batch or single message
    msgs = body if isinstance(body, list) else [body]
    inserted = 0
    for msg in msgs:
        if msg.get("type") == "reaction":
            if await asyncio.to_thread(_wa.ingest_baileys_reaction, msg):
                inserted += 1
        else:
            if await asyncio.to_thread(_wa.ingest_baileys_message, msg):
                inserted += 1
    return JSONResponse({"inserted": inserted, "received": len(msgs)})


def _portal_members() -> list[dict]:
    users = portal_mod.list_users()
    # Deduplicate by account_id — same PSN account linked under two different files
    # (e.g. old mm-keyed file + new z-<id>.json) would otherwise appear twice in draws.
    seen: dict[str, dict] = {}  # account_id (or zitadel_id as fallback) -> entry
    for u in users:
        if not u.get("zitadel_user_id"):
            continue
        display = u.get("online_id") or u.get("mm_username") or u["zitadel_user_id"]
        entry = {"id": u["zitadel_user_id"], "display": display}
        dedup_key = str(u.get("account_id") or u["zitadel_user_id"])
        if dedup_key not in seen:
            seen[dedup_key] = entry
    return list(seen.values())


@app.get("/api/giveaway")
async def giveaway_get(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    is_admin = await _is_iam_admin(user_id)
    all_members = await asyncio.to_thread(_portal_members)
    g = await asyncio.to_thread(_giveaway.get_active_giveaway)
    rotation = await asyncio.to_thread(_giveaway.get_rotation_state, all_members)
    user_eligible = False
    user_won_this_cycle = False
    if g:
        user_eligible = any(e["member_id"] == user_id for e in (g.get("entries") or []))
        user_won_this_cycle = any(m["member_id"] == user_id for m in rotation.get("won_members", []))
        if not is_admin and g.get("status") == "drawn":
            g["active_draw"] = None
    return JSONResponse({
        "giveaway": g,
        "rotation": {**rotation, "all_members": all_members},
        "is_admin": is_admin,
        "user_eligible": user_eligible,
        "user_won_this_cycle": user_won_this_cycle,
    })


@app.get("/api/giveaway/history")
async def giveaway_history(request: Request):
    if not _get_session(request):
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    hist = await asyncio.to_thread(_giveaway.list_past_giveaways, 20)
    return JSONResponse(hist)


@app.post("/api/giveaway")
async def giveaway_create(request: Request):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    body = await request.json()
    reveal_at = body.get("reveal_at")
    result = await asyncio.to_thread(
        _giveaway.create_giveaway,
        body.get("title", ""),
        body.get("prize", ""),
        body.get("draw_at", reveal_at),  # draw_at = reveal_at unless explicitly separate
        reveal_at,
    )
    return JSONResponse(result)


@app.put("/api/giveaway/{gid}")
async def giveaway_update(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    body = await request.json()
    reveal_at = body.get("reveal_at")
    updates = {k: body[k] for k in ("title", "prize") if k in body}
    if "reveal_at" in body:
        updates["reveal_at"] = reveal_at
        updates["draw_at"] = body.get("draw_at", reveal_at)
    result = await asyncio.to_thread(_giveaway.update_giveaway, gid, **updates)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.post("/api/giveaway/{gid}/publish")
async def giveaway_publish(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    all_members = await asyncio.to_thread(_portal_members)
    result = await asyncio.to_thread(_giveaway.publish_giveaway, gid, all_members)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.post("/api/giveaway/{gid}/lock")
async def giveaway_lock(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    result = await asyncio.to_thread(_giveaway.lock_giveaway, gid)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.post("/api/giveaway/{gid}/draw")
async def giveaway_draw(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    result = await asyncio.to_thread(_giveaway.draw_winner, gid)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.post("/api/giveaway/{gid}/reveal")
async def giveaway_reveal(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    result = await asyncio.to_thread(_giveaway.reveal_winner, gid)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.post("/api/giveaway/{gid}/draw-and-reveal")
async def giveaway_draw_and_reveal(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    # Draw if not already drawn
    g = await asyncio.to_thread(_giveaway.get_giveaway, gid)
    if not g:
        raise HTTPException(status_code=404, detail="not found")
    if g["status"] in ("open", "locked"):
        r = await asyncio.to_thread(_giveaway.draw_winner, gid)
        if r and "error" in r:
            raise HTTPException(status_code=400, detail=r["error"])
    # Reveal
    r2 = await asyncio.to_thread(_giveaway.reveal_winner, gid)
    if r2 and "error" in r2:
        raise HTTPException(status_code=400, detail=r2["error"])
    return JSONResponse({"status": "revealed"})


@app.post("/api/giveaway/{gid}/close")
async def giveaway_close(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    all_members = await asyncio.to_thread(_portal_members)
    result = await asyncio.to_thread(_giveaway.close_giveaway, gid, all_members)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.post("/api/giveaway/{gid}/redraw")
async def giveaway_redraw(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    body = await request.json()
    reason = body.get("reason", "admin redraw")
    result = await asyncio.to_thread(_giveaway.invalidate_and_redraw, gid, reason)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.post("/api/giveaway/{gid}/entries")
async def giveaway_add_entry(request: Request, gid: int):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    body = await request.json()
    result = await asyncio.to_thread(
        _giveaway.add_entry, gid, body["member_id"], body["display_name"]
    )
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)


@app.delete("/api/giveaway/{gid}/entries/{member_id}")
async def giveaway_remove_entry(request: Request, gid: int, member_id: str):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    result = await asyncio.to_thread(_giveaway.remove_entry, gid, member_id)
    if result and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return JSONResponse(result)

@app.post("/api/giveaway/admin/reset-and-seed")
async def giveaway_admin_reset(request: Request):
    session = _get_session(request)
    if not session or not await _is_iam_admin(session.get("sub", "")):
        raise HTTPException(status_code=403, detail="admin only")
    body = await request.json()
    query = (body.get("winner_query") or "").strip().lower()
    if not query:
        raise HTTPException(status_code=400, detail="winner_query required")
    members = await asyncio.to_thread(_portal_members)
    matches = [m for m in members if query in m["display"].lower()]
    if not matches:
        return JSONResponse({"error": "no_match", "all_members": members}, status_code=404)
    if len(matches) > 1:
        return JSONResponse({"error": "ambiguous", "matches": matches}, status_code=409)
    winner = matches[0]
    title = (body.get("title") or "").strip()
    prize = (body.get("prize") or "").strip()
    await asyncio.to_thread(_giveaway.reset_all)
    result = await asyncio.to_thread(
        _giveaway.add_past_winner, winner["id"], winner["display"], 1, title, prize
    )
    return JSONResponse({"status": "ok", "seeded_winner": winner, "add_result": result})


# ── Watch Party ──────────────────────────────────────────────────────────────
#
# This app is the authentication broker for our self-hosted WatchParty fork.
# The browser never asserts who it is: it asks for a 60-second signed Watch
# Ticket here, then presents that ticket in the Socket.IO handshake. WatchParty
# verifies the signature and takes the display name from the ticket.
#
# See watch.py for the identity/ticket rules and the WatchParty fork's
# server/utils/watchTicket.ts for the verifying half.

import watch as watch_mod

# Extra browser origins allowed to POST /api/watch/join (dev only).
WATCH_EXTRA_ORIGINS = [
    o.strip().rstrip("/")
    for o in os.environ.get("WATCH_EXTRA_ORIGINS", "").split(",")
    if o.strip()
]
# Optional gate: only people who linked a PSN account may join.
WATCH_REQUIRE_PSN_LINK = os.environ.get("WATCH_REQUIRE_PSN_LINK", "").lower() in ("1", "true", "yes")

_ZITADEL_PROFILE_CACHE: dict[str, tuple[float, dict]] = {}
_ZITADEL_PROFILE_TTL = 300.0


async def _zitadel_profile(sub: str) -> dict:
    """Name claims for a Zitadel user, for sessions that predate caching them.

    We deliberately do not persist user access tokens, so the profile lookup
    goes through the management API with the service token instead of hitting
    UserInfo with the user's token. Same claims, no token storage.
    """
    if not sub or not ZITADEL_SERVICE_TOKEN:
        return {}
    cached = _ZITADEL_PROFILE_CACHE.get(sub)
    if cached and _time.time() - cached[0] < _ZITADEL_PROFILE_TTL:
        return cached[1]
    profile: dict = {}
    try:
        import httpx as _hx
        async with _hx.AsyncClient(timeout=8) as c:
            r = await c.get(
                f"{ZITADEL_ISSUER}/v2/users/{sub}",
                headers={"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}"},
            )
        if r.status_code == 200:
            user = r.json().get("user", {}) or {}
            human = user.get("human", {}) or {}
            prof = human.get("profile", {}) or {}
            given = prof.get("givenName", "")
            family = prof.get("familyName", "")
            profile = {
                "name": prof.get("displayName") or " ".join(p for p in (given, family) if p),
                "preferred_username": user.get("preferredLoginName", ""),
            }
        else:
            logger.warning("watch: zitadel profile lookup %s for %s", r.status_code, sub[:8])
    except Exception as e:  # noqa: BLE001 — a missing name is not fatal
        logger.warning("watch: zitadel profile lookup failed: %s", e)
    if profile:
        _ZITADEL_PROFILE_CACHE[sub] = (_time.time(), profile)
    return profile


async def _watch_viewer(request: Request) -> dict | None:
    """Resolve the authenticated viewer, or None when there is no PSN session.

    Returns the internal AuthenticatedViewer shape plus the bits the UI needs.
    The Zitadel subject stays server-side; only ``viewerId`` leaves this box.
    """
    session = _get_session(request)
    if not session:
        return None
    sub = (session.get("sub") or "").strip()
    if not sub:
        return None
    issuer = (session.get("iss") or ZITADEL_ISSUER).rstrip("/")

    name = session.get("name", "")
    preferred = session.get("preferred_username", "")
    if not name and not preferred:
        # Legacy session cookie (sub + email only) — ask Zitadel once.
        prof = await _zitadel_profile(sub)
        name = prof.get("name", "")
        preferred = prof.get("preferred_username", "") or session.get("email", "")

    nickname = await asyncio.to_thread(watch_mod.get_nickname, sub)
    psn_record = await asyncio.to_thread(portal_mod.find_by_zitadel_id, sub)
    psn_online_id = (psn_record or {}).get("online_id") or ""

    return {
        "viewerId": watch_mod.viewer_id(issuer, sub),
        "zitadelIssuer": issuer,
        "zitadelSubject": sub,
        "displayName": watch_mod.resolve_display_name(
            nickname=nickname,
            psn_online_id=psn_online_id,
            zitadel_name=name,
            preferred_username=preferred,
        ),
        "nickname": nickname,
        "psnOnlineId": psn_online_id,
    }


def _watch_same_origin(request: Request) -> bool:
    """Stand-in for a CSRF token: the app has no CSRF middleware, and the
    session cookie is SameSite=Lax, so a cross-site POST can't carry it. We
    still verify Origin/Referer and only accept JSON.
    """
    host = (request.headers.get("host") or "").split(",")[0].strip()
    allowed = {f"https://{_PUBLIC_HOST}"} | set(WATCH_EXTRA_ORIGINS)
    if host:
        allowed |= {f"https://{host}", f"http://{host}"}

    origin = (request.headers.get("origin") or "").rstrip("/")
    if origin:
        return origin in allowed
    referer = request.headers.get("referer") or ""
    return any(referer.startswith(a + "/") or referer == a for a in allowed)


@app.get("/api/watch/jwks.json")
async def watch_jwks():
    """Public verification key for Watch Tickets (no private material)."""
    try:
        keys = await asyncio.to_thread(watch_mod.jwks)
    except watch_mod.WatchConfigError as e:
        logger.error("watch: jwks unavailable: %s", e)
        return JSONResponse({"detail": "watch party not configured"}, status_code=503)
    return JSONResponse(keys, headers={"Cache-Control": "public, max-age=300"})


@app.get("/api/watch/config")
async def watch_config(request: Request):
    """Everything the /watch page needs, including the resolved viewer name."""
    viewer = await _watch_viewer(request)
    if not viewer:
        return JSONResponse({"detail": "authentication required"}, status_code=401)
    cfg = watch_mod.client_config()
    cfg["viewer"] = {
        "id": viewer["viewerId"],
        "name": viewer["displayName"],
        "nickname": viewer["nickname"],
        "psnOnlineId": viewer["psnOnlineId"],
    }
    return JSONResponse(cfg, headers={"Cache-Control": "no-store"})


@app.post("/api/watch/join")
async def watch_join(request: Request):
    """Mint a short-lived Watch Ticket for the authenticated viewer.

    400 invalid room · 401 not authenticated · 403 not allowed in room ·
    429 rate limited · 503 signing key missing.
    """
    if not _watch_same_origin(request):
        return JSONResponse({"detail": "cross-origin request rejected"},
                            status_code=403, headers={"Cache-Control": "no-store"})
    if "application/json" not in (request.headers.get("content-type") or ""):
        return JSONResponse({"detail": "JSON body required"}, status_code=400,
                            headers={"Cache-Control": "no-store"})

    viewer = await _watch_viewer(request)
    if not viewer:
        return JSONResponse({"detail": "authentication required"}, status_code=401,
                            headers={"Cache-Control": "no-store"})

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    room = watch_mod.canonical_room((body or {}).get("roomId"))
    if not room or not watch_mod.is_allowed_room(room):
        return JSONResponse({"detail": "invalid room"}, status_code=400,
                            headers={"Cache-Control": "no-store"})

    if WATCH_REQUIRE_PSN_LINK and not viewer["psnOnlineId"]:
        return JSONResponse({"detail": "link your PSN account to join"}, status_code=403,
                            headers={"Cache-Control": "no-store"})

    # Scope the limiter per viewer so one person can't starve the room.
    _rate_limit("watch_join", viewer["viewerId"])

    try:
        minted = await asyncio.to_thread(
            watch_mod.mint_ticket,
            viewer=viewer["viewerId"], room=room, display_name=viewer["displayName"],
        )
    except watch_mod.WatchConfigError as e:
        logger.error("watch: cannot mint ticket: %s", e)
        return JSONResponse({"detail": "watch party not configured"}, status_code=503,
                            headers={"Cache-Control": "no-store"})

    # Log-safe: hashed viewer prefix + jti, never the ticket itself.
    logger.info("watch ticket issued room=%s viewer=%s jti=%s kid=%s",
                room, watch_mod.short_viewer(viewer["viewerId"]), minted["jti"], minted["kid"])

    return JSONResponse(
        {
            "ticket": minted["ticket"],
            "expiresIn": minted["expires_in"],
            "room": room,
            "viewer": {"name": viewer["displayName"]},
        },
        headers={"Cache-Control": "no-store"},
    )


# Internal browser-extract service (crcmz-browser-extract container, same coolify network).
_BROWSER_EXTRACT_URL = os.environ.get("BROWSER_EXTRACT_URL", "http://crcmz-browser-extract:8091")
_BROWSER_EXTRACT_KEY = os.environ.get("BROWSER_EXTRACT_API_KEY", "")


# How much of a quota-limited Drive file to pull per upstream request.  Big
# enough that the player is not making constant round trips, small enough that
# one request is not holding a huge window open.
_DRIVE_WINDOW = 8 * 1024 * 1024


def _drive_file_id(url: str) -> str:
    """Return the Google Drive file id in `url`, or "" if it isn't a Drive file.

    Folder links deliberately do not match: they hold no single video.
    """
    for pat in (
        r"drive\.google\.com/file/d/([A-Za-z0-9_-]{10,})",
        r"drive\.google\.com/(?:open|uc)\?(?:[^#]*&)?id=([A-Za-z0-9_-]{10,})",
        r"drive\.usercontent\.google\.com/download\?(?:[^#]*&)?id=([A-Za-z0-9_-]{10,})",
    ):
        m = _re.search(pat, url)
        if m:
            return m.group(1)
    return ""


def _drive_download_url(file_id: str) -> str:
    """The one Drive URL that streams reliably for us.

    `confirm=t` skips the virus-scan interstitial that large files otherwise
    get.  Unlike the rr*.c.drive.google.com/videoplayback URLs, this endpoint
    needs no cookies and honours Range.
    """
    return (
        "https://drive.usercontent.google.com/download"
        f"?id={file_id}&export=download&confirm=t"
    )


def _run_ytdlp(url: str) -> dict:
    """Resolve a page URL to a direct video URL via yt-dlp.

    Returns {"url": str, "kind": "hls"|"dash"|"direct", "title": str}.
    Raises RuntimeError on failure; raises ValueError("unsupported") when
    yt-dlp explicitly says the URL is unsupported (caller may fall back to
    the browser extractor).
    """
    import subprocess as _sp
    import json as _json

    r = _sp.run(
        ["yt-dlp", "--no-download", "--no-playlist", "--dump-json", "--no-warnings", "--", url],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        stderr = (r.stderr or "").strip()
        if "Unsupported URL" in stderr or "unsupported url" in stderr.lower():
            raise ValueError("unsupported")
        raise RuntimeError(stderr[-300:] if stderr else "yt-dlp error")

    try:
        data = _json.loads(r.stdout.strip())
    except Exception as exc:
        raise RuntimeError(f"could not parse yt-dlp output: {exc}") from exc

    title = data.get("title", "")
    formats = data.get("formats", [])

    # Drive: pin the download endpoint rather than trusting yt-dlp's pick.
    # When Drive has a transcode ready, "best" is an
    # rr*.c.drive.google.com/videoplayback URL tied to the Drive web session
    # (source=webdrive&app=explorer) that 403s for any cookie-less fetch — so
    # the same link played fine one minute and died the next depending purely
    # on whether that transcode happened to exist.  Only take the title here.
    drive_id = _drive_file_id(url)
    if drive_id:
        return {"url": _drive_download_url(drive_id), "kind": "direct", "title": title}

    # HLS master manifest is adaptive (includes all quality tiers + audio).
    manifest = next((f.get("manifest_url") for f in formats if f.get("manifest_url")), None)
    if manifest:
        return {"url": manifest, "kind": "hls", "title": title}

    # Otherwise trust yt-dlp's own best-format selection (top-level "url").
    top_url = data.get("url", "")
    if top_url.startswith("http"):
        kind = "hls" if ".m3u8" in top_url else "dash" if ".mpd" in top_url else "direct"
        return {"url": top_url, "kind": kind, "title": title}

    # Last resort: pick best format manually.
    best = next(
        (f for f in reversed(formats)
         if f.get("vcodec", "none") != "none" and f.get("url", "").startswith("http")),
        None,
    ) or next(
        (f for f in reversed(formats) if f.get("url", "").startswith("http")),
        None,
    )
    if not best:
        raise RuntimeError("no playable URL found")

    furl = best["url"]
    kind = "hls" if ".m3u8" in furl else "dash" if ".mpd" in furl else "direct"
    return {"url": furl, "kind": kind, "title": title}


async def _browser_extract(page_url: str) -> dict:
    """Fall back to the headless-browser service for JS-rendered players.

    Returns {"url": str, "kind": str, "referer": str} or raises RuntimeError.
    """
    payload = {"url": page_url, "timeout_s": 25}
    if _BROWSER_EXTRACT_KEY:
        payload["api_key"] = _BROWSER_EXTRACT_KEY
    try:
        import httpx as _hx
        async with _hx.AsyncClient(timeout=35.0) as client:
            r = await client.post(f"{_BROWSER_EXTRACT_URL}/extract", json=payload)
    except Exception as exc:
        raise RuntimeError(f"browser-extract unreachable: {exc}") from exc
    if r.status_code == 422:
        raise RuntimeError("no video found on that page")
    if not r.is_success:
        raise RuntimeError(f"browser-extract error {r.status_code}")
    data = r.json()
    data["referer"] = page_url   # used by the proxy to set the Referer header
    return data


def _proxy_url(video_url: str, referer: str) -> str:
    """Build a /api/watch/proxy URL so the browser never fetches direct."""
    from urllib.parse import quote as _q
    return f"/api/watch/proxy?url={_q(video_url, safe='')}&ref={_q(referer, safe='')}"


def _public_http_target(target: str) -> bool:
    """True only if `target` is http(s) on a publicly-routable address.

    /api/watch/proxy fetches a caller-supplied URL, so without this it is an
    SSRF pivot: any signed-in viewer could read our internal services on the
    coolify network (browser-extract, the watchparty container) or cloud
    metadata endpoints.  Blocking by resolved IP rather than hostname also
    stops names that deliberately resolve into private space.
    """
    import ipaddress
    import socket
    from urllib.parse import urlparse

    try:
        p = urlparse(target)
    except Exception:
        return False
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    try:
        port = p.port or (443 if p.scheme == "https" else 80)
    except ValueError:
        return False
    try:
        infos = socket.getaddrinfo(p.hostname, port, proto=socket.IPPROTO_TCP)
    except Exception:
        return False
    if not infos:
        return False
    # Every A/AAAA answer must be public — one private hit is enough to abuse.
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return False
    return True


@app.get("/api/watch/proxy")
async def watch_proxy(request: Request, url: str = "", ref: str = ""):
    """Proxy a media URL through the server, injecting a Referer header.

    Required for HLS streams (Referer-locked CDNs) and for direct video
    files like Google Drive where the browser can't access the extracted
    URL directly.  Manifests are rewritten; all other content is streamed
    with Range-request support so the player can seek.
    """
    from urllib.parse import urljoin
    from fastapi.responses import StreamingResponse
    import httpx as _hx

    viewer = await _watch_viewer(request)
    if not viewer:
        return Response(status_code=401)
    if not _re.match(r"^https?://", url):
        return Response(status_code=400)

    req_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
    }
    if ref:
        req_headers["Referer"] = ref
        try:
            from urllib.parse import urlparse as _up
            p = _up(ref)
            req_headers["Origin"] = f"{p.scheme}://{p.netloc}"
        except Exception:
            pass
    # Forward Range header so the player can seek in direct video files.
    range_hdr = request.headers.get("range")
    if range_hdr:
        req_headers["Range"] = range_hdr

    # Once a Drive file is over its download quota, open-ended reads stop
    # returning video: no Range, or "bytes=0-", yields a 2 KB "Quota exceeded"
    # HTML page that a <video> element can only fail on.  A *bounded* range
    # still serves real bytes, so convert the player's open-ended read into a
    # window and let it walk the file with follow-up ranges (which is what it
    # does for seeking anyway).
    if "drive.usercontent.google.com" in url:
        m = _re.match(r"bytes=(\d*)-(\d*)$", (range_hdr or "").strip())
        if not m or not m.group(2):
            start = int(m.group(1)) if (m and m.group(1)) else 0
            req_headers["Range"] = f"bytes={start}-{start + _DRIVE_WINDOW - 1}"

    # Redirects are followed by hand so every hop can be re-checked: a public
    # URL is free to redirect somewhere internal, which would defeat the guard.
    client = _hx.AsyncClient(timeout=60.0, follow_redirects=False)
    target = url
    r = None
    try:
        for _hop in range(6):
            if not await asyncio.to_thread(_public_http_target, target):
                await client.aclose()
                logger.warning("watch_proxy: blocked non-public target %.80s", target)
                return Response(status_code=400)
            r = await client.send(
                client.build_request("GET", target, headers=req_headers),
                stream=True,
            )
            loc = r.headers.get("location", "")
            if r.status_code in (301, 302, 303, 307, 308) and loc:
                await r.aclose()
                r = None
                target = urljoin(target, loc)
                continue
            break
        else:
            await client.aclose()
            return Response(status_code=502)
    except Exception as exc:
        if r is not None:
            await r.aclose()
        await client.aclose()
        logger.warning("watch_proxy: fetch failed %.80s: %s", url, exc)
        return Response(status_code=502)

    if not r.is_success and r.status_code != 206:
        await r.aclose()
        await client.aclose()
        return Response(status_code=r.status_code)

    ct = r.headers.get("content-type", "")
    is_manifest = "mpegurl" in ct or target.split("?")[0].lower().endswith(".m3u8")

    if is_manifest:
        # Need full text to rewrite segment URIs — safe to buffer (manifests are small).
        text_bytes = await r.aread()
        await r.aclose()
        await client.aclose()
        text = text_bytes.decode("utf-8", errors="replace")
        lines: list[str] = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                lines.append(line)
                continue
            if stripped.startswith("#"):
                # Relative URIs resolve against the *final* URL, not the one we
                # were handed, or they break whenever the CDN redirects.
                def _rewrite_attr(m: "_re.Match") -> str:
                    abs_u = urljoin(target, m.group(1))
                    return f'URI="{_proxy_url(abs_u, ref)}"'
                lines.append(_re.sub(r'URI="([^"]+)"', _rewrite_attr, line))
            else:
                abs_u = urljoin(target, stripped)
                lines.append(_proxy_url(abs_u, ref))
        return Response(
            content="\n".join(lines),
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"},
        )

    # An HTML *error page* answering a media request leaves the player retrying
    # blindly, so surface it (Drive's quota page took far too long to spot).
    # Sniff the body rather than trusting content-type: cinejoy's CDN serves
    # real HLS segments as "text/html" from .html URLs, so rejecting on the
    # header alone breaks every one of them.  Markup starts with "<"; MPEG-TS
    # starts with 0x47 and fMP4 with a box header, so neither is mistaken.
    body_iter = r.aiter_bytes(65536)
    head = b""
    if "text/html" in ct:
        async for _first in body_iter:
            head = _first
            break
        if head.lstrip()[:1] == b"<":
            await r.aclose()
            await client.aclose()
            text = " ".join(
                _re.sub(r"<[^>]+>", " ", head[:4096].decode("utf-8", "replace")).split()
            )
            quota = "Quota exceeded" in text
            logger.warning(
                "watch_proxy: HTML error page instead of media (quota=%s) from %.70s: %.120s",
                quota, target, text,
            )
            return JSONResponse(
                {"detail": (
                    "Google Drive has hit its download limit for this file. Make a copy "
                    "in your own Drive and share that, or try again in a few hours."
                ) if quota else "that link returned a web page instead of a video"},
                status_code=502,
            )

    # Stream segments / direct video files — forward Range/Content-Range so seeking works.
    resp_headers: dict[str, str] = {"Access-Control-Allow-Origin": "*"}
    for h in ("content-type", "content-length", "content-range", "accept-ranges"):
        if h in r.headers:
            resp_headers[h] = r.headers[h]
    if "content-type" not in resp_headers:
        resp_headers["content-type"] = "application/octet-stream"

    async def _body():
        try:
            if head:
                yield head          # already pulled off body_iter while sniffing
            async for chunk in body_iter:
                yield chunk
        finally:
            await r.aclose()
            await client.aclose()

    return StreamingResponse(
        _body(),
        status_code=r.status_code,
        headers=resp_headers,
    )


@app.post("/api/watch/extract")
async def watch_extract(request: Request):
    """Resolve a page URL to a direct video URL.

    Tries yt-dlp first (fast, 1000+ sites).  If yt-dlp says the URL is
    unsupported, falls back to the headless browser service which can handle
    JS-rendered players (cinejoy, vidsrc, etc.).  Browser-extracted HLS
    streams are served through /api/watch/proxy to inject the required
    Referer header that the CDN checks.
    """
    if not _watch_same_origin(request):
        return JSONResponse({"detail": "forbidden"}, status_code=403)
    viewer = await _watch_viewer(request)
    if not viewer:
        return JSONResponse({"detail": "not authenticated"}, status_code=401)

    body = None
    try:
        body = await request.json()
    except Exception:
        pass

    url = str((body or {}).get("url", "")).strip()
    if not _re.match(r"^https?://", url):
        return JSONResponse({"detail": "a http(s) URL is required"}, status_code=400)

    # A folder holds no single video; yt-dlp fails on it with an opaque
    # "expected string or bytes-like object, got 'bool'", so say it plainly.
    if _re.search(r"drive\.google\.com/drive/(?:u/\d+/)?folders/", url):
        return JSONResponse(
            {"detail": "that's a Drive folder — open the video inside it and paste its link"},
            status_code=400,
        )

    _rate_limit("watch_extract", viewer["viewerId"])

    # 1. Try yt-dlp.
    try:
        result = await asyncio.to_thread(_run_ytdlp, url)
        # Always proxy through the server: the extracted URL may be IP-tied
        # (Google Drive CDN), require cookies, or not support CORS from the
        # browser.  The server fetched the URL so it has the right context.
        result["url"] = _proxy_url(result["url"], url)
        logger.info(
            "watch_extract(ytdlp): resolved %.80s -> kind=%s viewer=%s",
            url, result["kind"], watch_mod.short_viewer(viewer["viewerId"]),
        )
        return JSONResponse(result)
    except ValueError:
        pass  # yt-dlp said "Unsupported URL" — fall through to browser
    except Exception as exc:
        logger.warning("watch_extract(ytdlp): failed for %.80s: %s", url, str(exc)[:200])
        # For Drive we can build the streaming URL from the file id alone, so a
        # yt-dlp hiccup only costs us the title, not the video.
        drive_id = _drive_file_id(url)
        if drive_id:
            logger.info(
                "watch_extract(drive): yt-dlp failed, using download endpoint viewer=%s",
                watch_mod.short_viewer(viewer["viewerId"]),
            )
            return JSONResponse({
                "url": _proxy_url(_drive_download_url(drive_id), url),
                "kind": "direct",
                "title": "",
            })
        return JSONResponse({"detail": "could not extract a video from that URL"}, status_code=422)

    # 2. Fall back to headless browser.
    try:
        result = await _browser_extract(url)
        # Wrap HLS through our proxy so the browser never needs to send a Referer
        # directly — the CDN would block it otherwise.
        if result.get("kind") == "hls":
            result["url"] = _proxy_url(result["url"], result.get("referer", url))
        logger.info(
            "watch_extract(browser): resolved %.80s -> kind=%s viewer=%s",
            url, result["kind"], watch_mod.short_viewer(viewer["viewerId"]),
        )
        return JSONResponse(result)
    except Exception as exc:
        logger.warning("watch_extract(browser): failed for %.80s: %s", url, str(exc)[:200])
        return JSONResponse({"detail": "could not extract a video from that URL"}, status_code=422)


@app.post("/api/watch/nickname")
async def watch_set_nickname(request: Request):
    """Change the Watch Party display name (the top-priority name source).

    The browser can set its *profile* nickname here — an authenticated,
    server-side change — but never the identity on a live socket. Callers
    reconnect afterwards to pick up a ticket with the new name.
    """
    if not _watch_same_origin(request):
        return JSONResponse({"detail": "cross-origin request rejected"}, status_code=403)
    viewer = await _watch_viewer(request)
    if not viewer:
        return JSONResponse({"detail": "authentication required"}, status_code=401)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    stored = await asyncio.to_thread(
        watch_mod.set_nickname, viewer["zitadelSubject"], (body or {}).get("nickname") or ""
    )
    refreshed = await _watch_viewer(request)
    return JSONResponse(
        {"nickname": stored, "name": (refreshed or viewer)["displayName"]},
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/watch/rally")
async def watch_rally(request: Request):
    """Send a 'Join us!' text to the WhatsApp group via the baily bridge.

    Proxies to WA_BRIDGE_URL/send with mentionAll=true so @everyone is tagged.
    """
    if not _watch_same_origin(request):
        return JSONResponse({"detail": "cross-origin request rejected"}, status_code=403)
    viewer = await _watch_viewer(request)
    if not viewer:
        return JSONResponse({"detail": "authentication required"}, status_code=401)
    if not WA_BRIDGE_URL:
        return JSONResponse({"detail": "WhatsApp bridge not configured"}, status_code=503)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    message = str((body or {}).get("message", "")).strip()
    if not message:
        return JSONResponse({"detail": "message required"}, status_code=400)
    import httpx as _httpx
    try:
        async with _httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{WA_BRIDGE_URL}/send", json={
                "message": message,
                "mentionAll": True,
                **({"groupJid": WA_GOOPERS_JID} if WA_GOOPERS_JID else {}),
            })
        r.raise_for_status()
        return JSONResponse({"status": "sent"}, headers={"Cache-Control": "no-store"})
    except Exception as exc:  # noqa: BLE001
        logger.warning("watch rally send failed: %s", exc)
        return JSONResponse({"detail": "failed to send"}, status_code=502)


# ── Huddle API (LiveKit token + Ollama proxy) ──────────────────────────────────

def _mk_livekit_token(identity: str, name: str, room: str) -> str:
    import jwt as _pyjwt, uuid as _uuid
    now = int(_time.time())
    payload = {
        "exp": now + 21600,
        "iss": LIVEKIT_API_KEY,
        "nbf": now,
        "sub": identity,
        "name": name,
        "video": {
            "roomJoin": True,
            "room": room,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
        },
        "jti": str(_uuid.uuid4()),
    }
    token = _pyjwt.encode(payload, LIVEKIT_API_SECRET, algorithm="HS256")
    return token if isinstance(token, str) else token.decode()


@app.post("/api/huddle/token")
async def huddle_token(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
        return JSONResponse({"error": "Huddle not configured on this server"}, status_code=503)
    try:
        body = await request.json()
    except Exception:
        body = {}
    room = str((body or {}).get("room", "crcmz")).strip() or "crcmz"
    # sanitise: only alphanumeric + hyphens
    import re as _re
    room = _re.sub(r"[^a-z0-9\-]", "", room.lower())[:64] or "crcmz"
    identity = session.get("sub", "anon")
    name = session.get("name") or session.get("preferred_username") or identity
    token = _mk_livekit_token(identity, name, room)
    ws_url = LIVEKIT_URL
    return JSONResponse({"token": token, "url": ws_url, "room": room})


@app.post("/api/huddle/ai")
async def huddle_ai(request: Request):
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    if not OLLAMA_BASE_URL:
        return JSONResponse({"error": "AI not configured — set OLLAMA_BASE_URL"}, status_code=503)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    messages = body.get("messages", [])
    model = body.get("model") or OLLAMA_MODEL
    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=60) as c:
            r = await c.post(
                f"{OLLAMA_BASE_URL.rstrip('/')}/api/chat",
                json={"model": model, "messages": messages, "stream": False},
            )
        return JSONResponse(r.json())
    except Exception as exc:
        logger.warning("huddle ollama proxy error: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.get("/watch")
def watch_page():
    """User-facing entry point — the Watch tab of the existing dashboard.

    Kept as a real URL so /watch can be shared; the auth gate redirects
    unauthenticated visitors through the normal Zitadel login first.
    """
    return RedirectResponse(url="/?p=watch", status_code=302)


@app.get("/auth/settings/psn")
async def settings_psn_status(request: Request):
    """PSN status for the logged-in user. Admins see all accounts."""
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    if not user_id:
        return JSONResponse({"linked": False, "unclaimed": []})

    is_admin = await _is_iam_admin(user_id)
    record = portal_mod.find_by_zitadel_id(user_id)
    all_users = portal_mod.list_users() if is_admin else None

    if record:
        base = {"linked": True, **record}
        if is_admin:
            base["admin"] = True
            base["users"] = all_users
        return JSONResponse(base)

    # Not yet claimed — everyone sees unclaimed list to pick from
    unclaimed = portal_mod.list_unclaimed()
    resp: dict = {"linked": False, "unclaimed": unclaimed}
    if is_admin:
        resp["admin"] = True
        resp["users"] = all_users
    return JSONResponse(resp)


@app.post("/auth/settings/psn/claim")
async def settings_psn_claim(request: Request):
    """Claim an unassigned PSN record for the logged-in user."""
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    user_id = session.get("sub", "")
    if not user_id:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    body = await request.json()
    key = (body.get("key") or "").strip()
    if not key or "/" in key or ".." in key:
        return JSONResponse({"error": "invalid key"}, status_code=400)
    ok = portal_mod.claim_record(key, user_id)
    if not ok:
        return JSONResponse({"error": "record not found or already claimed"}, status_code=404)
    return JSONResponse({"ok": True})


@app.get("/auth/logout")
async def auth_logout():
    resp = RedirectResponse(url="/auth/login", status_code=302)
    resp.delete_cookie(_SESSION_COOKIE, path="/")
    return resp


@app.post("/api/psn/link")
async def api_psn_link(request: Request):
    """Link a PSN account via NPSSO token — JSON endpoint for the settings modal."""
    session = _get_session(request)
    if not session:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    body = await request.json()
    npsso = (body.get("npsso") or "").strip()
    if not npsso:
        return JSONResponse({"error": "token is required"}, status_code=400)
    zitadel_user_id = session.get("sub", "")
    # Derive a display username from the session email (email prefix) so every
    # user linked via Zitadel gets an @username shown on the squad page.
    # Preserve any existing mm_username that was set via the old Mattermost flow.
    email = session.get("email", "")
    derived_username = email.split("@")[0] if email else ""
    existing = portal_mod.find_by_zitadel_id(zitadel_user_id)
    mm_username = (existing or {}).get("mm_username") or derived_username
    try:
        result = portal_mod.link_user(npsso, mm_username=mm_username, zitadel_user_id=zitadel_user_id)
    except portal_mod.LinkError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        logger.error("api/psn/link failed: %s", e)
        return JSONResponse({"error": "Something went wrong. Try a fresh token."}, status_code=500)
    return JSONResponse({"ok": True, "online_id": result.get("online_id", "")})


@app.get("/portal", response_class=HTMLResponse)
def portal_home(request: Request):
    return HTMLResponse(_portal_page())


@app.post("/portal/link", response_class=HTMLResponse)
def portal_link(
    request: Request,
    npsso: str = Form(...),
    mm_username: str = Form(""),
):
    zitadel_user_id = (_get_session(request) or {}).get("sub", "")
    try:
        result = portal_mod.link_user(npsso, mm_username=mm_username.strip(),
                                      zitadel_user_id=zitadel_user_id)
    except portal_mod.LinkError as e:
        return HTMLResponse(_portal_page(error=str(e)), status_code=400)
    except Exception as e:  # noqa: BLE001
        logger.error("portal: link failed: %s", e)
        return HTMLResponse(
            _portal_page(error="Something went wrong. Try a fresh token."),
            status_code=500,
        )
    who = result.get("online_id") or result.get("mm_username") or "Your account"
    return HTMLResponse(_portal_page(ok=who))


@app.get("/portal/users")
def portal_users():
    return {"users": portal_mod.list_users()}


# === Squad Dashboard (app.crcmz.me home) ===
#
# Live view of everyone linked via the portal: who's online, what they're
# playing, plus one-tap actions (Squad Up, Game Time, Roast) wired to the
# existing endpoints. Data comes from psn_data using the bot's auth.

import psn_data


# Background poller: refresh the squad cache every minute so online/playing
# status stays live even when nobody has the dashboard open, and so the game
# list's real-time lastPlayedDateTime is checked frequently enough to reflect
# "online right now". This is the ONLY periodic PSN caller; viewers read cache.
_poller_started = False

import mattermost as mm_client

# ARC Raiders alert: when someone starts playing it, post ONE message to the
# "Squad Alerts" Mattermost channel tagging the crew. Match is
# substring/case-insensitive. Mentions must use real MM usernames to ping.
_ARC_MATCH = "arc raider"
_SQUAD_ALERTS_CHANNEL = os.environ.get(
    "SQUAD_ALERTS_CHANNEL_ID", "5115wy8pc7ffuj5c3zor51jxew"
)
_ARC_TAGS = "@themoosecompany @zubair221b @deception @moiz"
# DISABLED: the auto ARC alert fired at the WRONG time. PSN's gamelist
# lastPlayedDateTime only updates when a session SYNCS (i.e. when someone stops
# / switches away), so "playing" flips true right as they LEAVE ARC -- the alert
# announced arrivals that were actually departures. There's no reliable live
# "just started" signal in the data, so we don't auto-ping. Set
# ARC_ALERT_ENABLED=1 to re-enable (not recommended).
ARC_ALERT_ENABLED = os.environ.get("ARC_ALERT_ENABLED", "0") == "1"
_arc_alerted = False


def _check_arc_alert(squad: list[dict]) -> None:
    """Post ONE tagging message to Squad Alerts when ARC play starts.

    No-op unless ARC_ALERT_ENABLED -- see note above on why this misfires.
    """
    global _arc_alerted
    if not ARC_ALERT_ENABLED or not mm_client.available():
        return
    playing = [
        m.get("online_id")
        for m in squad
        if m.get("playing") and _ARC_MATCH in (m.get("game") or "").lower()
    ]
    if playing and not _arc_alerted:
        who = ", ".join(p for p in playing if p) or "Someone"
        msg = (
            f"🎮🔫 **{who}** is on **ARC Raiders**! Squad up — who's in? 💥\n"
            f"{_ARC_TAGS}"
        )
        ok = mm_client.post_channel(_SQUAD_ALERTS_CHANNEL, msg)
        logger.info("arc alert: %s on ARC -> posted=%s", who, ok)
        _arc_alerted = True
    elif not playing:
        _arc_alerted = False


# === PSN → WhatsApp / Discord video forwarder ================================
WA_BRIDGE_URL  = os.environ.get("WA_BRIDGE_URL", "")
WA_GOOPERS_JID = os.environ.get("WA_GOOPERS_JID", "")
DISCORD_BOT_TOKEN       = os.environ.get("DISCORD_BOT_TOKEN", "")
DISCORD_CLIPS_CHANNEL_ID = os.environ.get("DISCORD_CLIPS_CHANNEL_ID", "")

# ── Huddle (LiveKit video chat) ────────────────────────────────────────────────
LIVEKIT_URL        = os.environ.get("LIVEKIT_URL", "wss://huddle.crcmz.me")
LIVEKIT_API_KEY    = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")
# Ollama on the local Mac — e.g. http://192.168.5.xxx:11434
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "")
OLLAMA_MODEL    = os.environ.get("OLLAMA_MODEL", "llama3.2")

# Resolve WA bridge host — host.docker.internal may not exist in Coolify
if WA_BRIDGE_URL:
    import socket as _socket
    _parsed = WA_BRIDGE_URL.replace("http://", "").replace("https://", "").split(":")[0]
    try:
        _socket.gethostbyname(_parsed)
    except _socket.gaierror:
        _port = WA_BRIDGE_URL.split(":")[-1] if ":" in WA_BRIDGE_URL.split("//")[-1] else "3100"
        try:
            with open("/proc/net/route") as _f:
                for _line in _f:
                    _parts = _line.split()
                    if _parts[1] == "00000000":
                        _gw_hex = _parts[2]
                        _gw = ".".join(str(int(_gw_hex[i:i+2], 16)) for i in [6, 4, 2, 0])
                        WA_BRIDGE_URL = f"http://{_gw}:{_port}"
                        break
        except Exception:
            pass

import clips as _clips
import clip_store as _cstore
from psn_messaging import ClipNotReady, ClipUnauthorized, ClipRateLimited, ClipError, ClipDownload
_clips.init()

import whatsapp_analytics as _wa
import giveaway as _giveaway
_wa.init()

_video_seen: set[str] = set()
_video_initialized: bool = False
_video_queue: "asyncio.Queue[str]" = None   # type: ignore[assignment]
_watched_messengers: list = []


def _messenger_for_group(group_id: str):
    for m in _watched_messengers:
        if m._group_id == group_id:
            return m
    return None


async def _forward_screenshot(uid: str, ugc_id: str, sender: str, body: str, wm) -> None:
    """Resolve a PSN screenshot ugcId, download it, and forward to WhatsApp."""
    import base64
    import httpx as _httpx

    if not WA_BRIDGE_URL or not WA_GOOPERS_JID:
        return
    try:
        logger.info("screenshot_forward_started uid=%s ugcId=%s sender=%s", uid, ugc_id, sender)
        image_bytes = await asyncio.to_thread(wm.resolve_and_download_screenshot, ugc_id)
        caption = f"{sender}: {body}" if body else sender
        payload = {
            "imageBase64": base64.b64encode(image_bytes).decode(),
            "groupJid": WA_GOOPERS_JID,
            "caption": caption,
            "idempotencyKey": f"psn-img:{uid}",
        }
        async with _httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{WA_BRIDGE_URL}/send-image", json=payload)
        logger.info("screenshot_forward_sent uid=%s status=%d", uid, resp.status_code)
    except Exception as exc:
        logger.error("screenshot_forward_failed uid=%s: %s", uid, exc)


async def _forward_image(uid: str, image_url: str, sender: str, body: str, wm) -> None:
    """Download a PSN image using auth headers and forward it to WhatsApp."""
    import base64
    import httpx as _httpx

    if not WA_BRIDGE_URL or not WA_GOOPERS_JID:
        return
    try:
        logger.info("image_forward_started uid=%s sender=%s", uid, sender)
        image_bytes = await asyncio.to_thread(wm.download_image, image_url)
        caption = f"{sender}: {body}" if body else sender
        payload = {
            "imageBase64": base64.b64encode(image_bytes).decode(),
            "groupJid": WA_GOOPERS_JID,
            "caption": caption,
            "idempotencyKey": f"psn-img:{uid}",
        }
        async with _httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{WA_BRIDGE_URL}/send-image", json=payload)
        logger.info("image_forward_sent uid=%s status=%d", uid, resp.status_code)
    except Exception as exc:
        logger.error("image_forward_failed uid=%s: %s", uid, exc)


def _send_to_wa(message_uid: str, video_bytes: bytes, sender: str, body: str = "") -> str | None:
    """POST video bytes to slaptastic. Returns wa_message_id or None."""
    import base64
    import httpx as _httpx

    # Guard: verify the bridge has an active WA connection before sending.
    # The bridge returns {"status":"ok","whatsapp":true/false}. If whatsapp is
    # false the bridge will accept the request and return 200 but never deliver —
    # raise ClipError so the retry loop holds the job until the bridge recovers.
    try:
        health = _httpx.get(f"{WA_BRIDGE_URL}/health", timeout=5).json()
        if not health.get("whatsapp"):
            raise ClipError("WA bridge WhatsApp connection is down — will retry")
    except ClipError:
        raise
    except Exception as e:
        raise ClipError(f"WA bridge health check failed: {e}") from e

    # PSN auto-generates "X sent a video clip." — not a real user caption
    import re as _re
    real_body = body if body and not _re.fullmatch(r'.+ sent a video clip\.', body, _re.IGNORECASE) else ""
    caption = f"🎮 {sender}: {real_body}" if real_body else f"🎮 {sender}"
    idempotency_key = f"psn:{message_uid}"

    payload = {
        "videoBase64": base64.b64encode(video_bytes).decode(),
        "groupJid": WA_GOOPERS_JID,
        "caption": caption,
        "idempotencyKey": idempotency_key,
    }
    logger.info("clip_whatsapp_send_started uid=%s bytes=%d", message_uid, len(video_bytes))
    r = _httpx.post(f"{WA_BRIDGE_URL}/send-video", json=payload, timeout=180)
    if r.status_code == 200:
        resp = r.json()
        # already_sent is fine — idempotency working as intended
        status = resp.get("status", "")
        wa_id  = resp.get("messageId")
        logger.info("clip_whatsapp_sent uid=%s status=%s waId=%s", message_uid, status, wa_id)
        return wa_id
    raise ClipError(f"WA bridge error {r.status_code}: {r.text[:200]}")


def _send_to_discord(message_uid: str, video_bytes: bytes, sender: str, body: str = "") -> None:
    """Upload video to #crcmz-clips via Discord bot. Best-effort — never raises."""
    if not DISCORD_BOT_TOKEN or not DISCORD_CLIPS_CHANNEL_ID:
        return
    import json as _json
    import httpx as _httpx
    import re as _re

    DISCORD_MAX_BYTES = 25 * 1024 * 1024
    if len(video_bytes) > DISCORD_MAX_BYTES:
        logger.warning("clip_discord_skip uid=%s size=%d exceeds 25MB Discord limit",
                       message_uid, len(video_bytes))
        return

    real_body = body if body and not _re.fullmatch(r'.+ sent a video clip\.', body, _re.IGNORECASE) else ""
    caption = f"🎮 {sender}: {real_body}" if real_body else f"🎮 {sender}"

    try:
        r = _httpx.post(
            f"https://discord.com/api/v10/channels/{DISCORD_CLIPS_CHANNEL_ID}/messages",
            headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}"},
            data={"payload_json": _json.dumps({"content": caption})},
            files={"file": ("clip.mp4", video_bytes, "video/mp4")},
            timeout=120,
        )
        if r.status_code in (200, 201):
            logger.info("clip_discord_sent uid=%s messageId=%s", message_uid,
                        r.json().get("id"))
        else:
            logger.error("clip_discord_failed uid=%s status=%d body=%s",
                         message_uid, r.status_code, r.text[:200])
    except Exception as exc:
        logger.error("clip_discord_failed uid=%s: %s", message_uid, exc)


def _process_clip_job(message_uid: str, job: dict) -> str | None:
    """Run the full clip pipeline synchronously. Returns wa_message_id.

    Raises ClipNotReady, ClipUnauthorized, ClipRateLimited, ClipError.
    Stage awareness: if already archived, loads from store and skips to send.
    """
    if not WA_BRIDGE_URL or not WA_GOOPERS_JID:
        raise ClipError("WA_BRIDGE_URL or WA_GOOPERS_JID not configured")

    ugc_id   = job["ugc_id"]
    sender   = job["sender_online_id"]
    group_id = job.get("psn_group_id", "")
    body     = job.get("body") or ""

    # ── Resume from archive if available ──────────────────────────────────────
    storage_key = job.get("storage_key_original")
    if job.get("archive_status") == "archived" and storage_key:
        logger.info("clip_archive: resuming from stored copy uid=%s", message_uid)
        video_bytes = _cstore.load(storage_key)
        if not video_bytes:
            raise ClipError(f"archived clip missing from store: {storage_key}")
        _send_to_discord(message_uid, video_bytes, sender, body)
        return _send_to_wa(message_uid, video_bytes, sender, body)

    # ── Resolve + download ────────────────────────────────────────────────────
    _clips.mark(message_uid, _clips.RESOLVING)
    messenger = _messenger_for_group(group_id)
    if not messenger:
        # Fallback to primary messenger
        messenger = psn_messenger

    _clips.mark(message_uid, _clips.DOWNLOADING)
    result: ClipDownload = messenger.download_clip(ugc_id)  # raises on error

    # ── Archive ───────────────────────────────────────────────────────────────
    _clips.mark(message_uid, _clips.PROCESSING)
    key = _cstore.storage_key(message_uid, job.get("psn_created_at"))
    ok  = _cstore.archive(key, result.data)
    if not ok:
        raise ClipError("archive storage write failed")

    _clips.set_archived(
        message_uid, key,
        sha256=result.sha256,
        file_size=result.file_size,
        duration_seconds=result.duration_seconds,
        width=result.width,
        height=result.height,
        fps=result.fps,
        video_codec=result.video_codec,
        audio_codec=result.audio_codec,
        audio_sample_rate=result.audio_sample_rate,
    )

    # ── Send ─────────────────────────────────────────────────────────────────
    _send_to_discord(message_uid, result.data, sender, body)
    return _send_to_wa(message_uid, result.data, sender, body)




@app.on_event("startup")
async def _start_squad_poller():
    _giveaway.init_db()
    global _poller_started
    if _poller_started or not _v2_available:
        return
    _poller_started = True

    async def _loop():
        while True:
            try:
                # Presence-only refresh — no trophy API calls.
                # Trophy data is only fetched when someone opens the dashboard
                # (via /api/squad which uses include_stats=True).
                squad = await asyncio.to_thread(psn_data.squad_status, psn_auth, False)
                await asyncio.to_thread(_check_arc_alert, squad)
            except Exception as e:  # noqa: BLE001
                logger.debug("squad poller tick failed: %s", e)
            await asyncio.sleep(180)

    asyncio.create_task(_loop())
    logger.info("squad presence poller started (180s)")

    if WA_BRIDGE_URL and WA_GOOPERS_JID:
        global _watched_messengers, _video_queue
        _watched_messengers = [m for m in [psn_messenger, _squad_messenger] if m is not None]
        _video_queue = asyncio.Queue()

        async def _video_detect_loop():
            def _adjacent_caption(msgs: list[dict], idx: int, sender: str,
                                   window_ms: int = 5000) -> str:
                """Return the body of a type-1 message from the same sender
                within window_ms of msgs[idx], or '' if none found."""
                try:
                    ts0 = int(msgs[idx].get("timestamp") or 0)
                except (ValueError, TypeError):
                    return ""
                for j in range(max(0, idx - 3), min(len(msgs), idx + 4)):
                    if j == idx:
                        continue
                    m = msgs[j]
                    if m.get("messageType") != 1:
                        continue
                    if m.get("sender") != sender:
                        continue
                    try:
                        delta = abs(int(m.get("timestamp") or 0) - ts0)
                    except (ValueError, TypeError):
                        continue
                    if delta <= window_ms:
                        body = (m.get("body") or "").strip()
                        if body:
                            return body
                return ""

            global _video_initialized
            while True:
                try:
                    for wm in _watched_messengers:
                        msgs = await asyncio.to_thread(wm.get_messages, 10)
                        for idx, msg in enumerate(msgs):
                            uid = msg.get("messageUid", "")
                            if not uid or uid in _video_seen:
                                continue
                            _video_seen.add(uid)

                            # Parse PSN timestamp (ms → int)
                            psn_ts_ms: int | None = None
                            ts_raw = msg.get("timestamp")
                            if ts_raw:
                                try:
                                    psn_ts_ms = int(ts_raw)
                                except (ValueError, TypeError):
                                    pass

                            if not _video_initialized:
                                # Seed pass: record cursor, don't forward
                                if psn_ts_ms:
                                    _clips.update_cursor(wm._group_id, uid,
                                                         psn_ts_ms / 1000.0)
                                continue

                            msg_type = msg.get("messageType", 1)
                            sender = msg.get("sender", "unknown")

                            # Screenshot messages (type 3) — resolve ugcId and forward
                            screenshot_ugc_id = msg.get("screenshotUgcId") or ""
                            if msg_type == 3 and screenshot_ugc_id:
                                body_text = _adjacent_caption(msgs, idx, sender)
                                asyncio.create_task(
                                    _forward_screenshot(uid, screenshot_ugc_id, sender, body_text, wm)
                                )
                                continue

                            # Video clip messages
                            if msg_type != 210:
                                continue
                            ugc_id = msg.get("ugcId", "")
                            if not ugc_id:
                                continue
                            body_text = _adjacent_caption(msgs, idx, sender)
                            is_new = _clips.claim(
                                uid, ugc_id, wm._group_id, wm._group_name,
                                sender, psn_ts_ms, body_text,
                            )
                            if is_new:
                                logger.info(
                                    "clip_detected uid=%s ugcId=%s sender=%s group=%s",
                                    uid, ugc_id, sender, wm._group_name,
                                )
                                await _video_queue.put(uid)
                except Exception as exc:  # noqa: BLE001
                    logger.error("video-watch tick failed: %s", exc)
                finally:
                    if not _video_initialized:
                        recovered = _clips.recoverable_jobs()
                        for job in recovered:
                            _video_seen.add(job["message_uid"])
                            await _video_queue.put(job["message_uid"])
                        _video_initialized = True
                        logger.info(
                            "video-watch: seeded %d UIDs, recovered %d unfinished jobs",
                            len(_video_seen), len(recovered),
                        )
                await asyncio.sleep(30)

        async def _video_forward_worker():
            while True:
                uid = await _video_queue.get()
                try:
                    job = _clips.get(uid)
                    if not job or job["status"] in _clips.TERMINAL:
                        continue

                    exc_info: tuple[str, str, int] | None = None  # (kind, msg, extra)
                    wa_msg_id: str | None = None

                    try:
                        wa_msg_id = await asyncio.wait_for(
                            asyncio.to_thread(_process_clip_job, uid, job),
                            timeout=300.0,
                        )
                    except asyncio.TimeoutError:
                        exc_info = ("timeout", "ffmpeg/process timeout (300s)", 0)
                    except ClipNotReady as e:
                        exc_info = ("not_ready", str(e), 0)
                    except ClipUnauthorized:
                        exc_info = ("unauthorized", "PSN 401", 0)
                    except ClipRateLimited as e:
                        exc_info = ("rate_limited", str(e), e.retry_after)
                    except ClipError as e:
                        exc_info = ("error", str(e), 0)
                    except Exception as e:
                        exc_info = ("error", f"unexpected: {e}", 0)

                    if exc_info is None:
                        _clips.set_delivered(uid, wa_msg_id)
                        continue

                    kind, error_msg, extra = exc_info
                    attempts = job["attempts"] + 1

                    if kind == "unauthorized":
                        # Force token refresh; immediate retry
                        psn_auth._expires_at = 0
                        logger.warning("clip 401 uid=%s — refreshing PSN token", uid)
                        if attempts <= 2:
                            await _video_queue.put(uid)
                        else:
                            _clips.mark(uid, _clips.FAILED,
                                        error="401 after token refresh")
                        continue

                    if kind == "not_ready":
                        # PSN CDN still transcoding — staged delays
                        delays = [30, 60, 120, 240, 480]
                        if attempts > len(delays):
                            _clips.mark(uid, _clips.FAILED,
                                        error=f"media never ready: {error_msg}")
                            logger.error("clip_failed uid=%s reason=never_ready", uid)
                        else:
                            delay = delays[attempts - 1]
                            _clips.mark(uid, _clips.WAITING_MEDIA,
                                        error=error_msg,
                                        next_attempt_at=_time.time() + delay)
                            logger.info(
                                "clip_retry_scheduled uid=%s attempt=%d delay=%ds reason=not_ready",
                                uid, attempts, delay,
                            )
                            async def _requeue_nr(u=uid, d=delay):
                                await asyncio.sleep(d)
                                await _video_queue.put(u)
                            asyncio.create_task(_requeue_nr())
                        continue

                    if kind == "rate_limited":
                        delay = max(extra, 30)
                        _clips.mark(uid, _clips.DISCOVERED,
                                    error=error_msg,
                                    next_attempt_at=_time.time() + delay)
                        logger.warning("clip_retry_scheduled uid=%s reason=rate_limited delay=%ds",
                                       uid, delay)
                        async def _requeue_rl(u=uid, d=delay):
                            await asyncio.sleep(d)
                            await _video_queue.put(u)
                        asyncio.create_task(_requeue_rl())
                        continue

                    # timeout / generic error — exponential backoff
                    if attempts >= 5:
                        _clips.mark(uid, _clips.FAILED,
                                    error=f"max attempts: {error_msg}")
                        logger.error("clip_failed uid=%s attempts=%d error=%s",
                                     uid, attempts, error_msg[:80])
                    else:
                        delay = 30 * (2 ** (attempts - 1))
                        _clips.mark(uid, _clips.DISCOVERED,
                                    error=error_msg,
                                    next_attempt_at=_time.time() + delay)
                        logger.info(
                            "clip_retry_scheduled uid=%s attempt=%d delay=%ds",
                            uid, attempts, delay,
                        )
                        async def _requeue_e(u=uid, d=delay):
                            await asyncio.sleep(d)
                            await _video_queue.put(u)
                        asyncio.create_task(_requeue_e())

                except Exception as exc:  # noqa: BLE001
                    logger.exception("video worker unexpected error uid=%s: %s", uid, exc)
                finally:
                    _video_queue.task_done()

        asyncio.create_task(_video_detect_loop())
        asyncio.create_task(_video_forward_worker())
        logger.info("video watcher started (30s, %d groups, persistent clips DB)",
                    len(_watched_messengers))


@app.get("/api/video-jobs")
def api_video_jobs():
    """Clip pipeline status: counts + queue depth."""
    q_depth = _video_queue.qsize() if _video_queue is not None else 0
    return {"stats": _clips.stats(), "queue_depth": q_depth}


@app.get("/api/pipeline-status")
def api_pipeline_status():
    """Aggregated health for the PSN → montage pipeline."""
    import httpx as _hx
    import time as _time
    from datetime import datetime
    from zoneinfo import ZoneInfo

    def _ping(url, timeout=3.0):
        try:
            t0 = _time.monotonic()
            r = _hx.get(url, timeout=timeout)
            ms = int((_time.monotonic() - t0) * 1000)
            return {"status": "ok" if r.status_code < 400 else "error", "ms": ms}
        except Exception:
            return {"status": "down", "ms": None}

    montage_health = _ping("http://10.0.1.1:3099/health")
    wa_health      = _ping("http://10.0.1.1:3100/health")

    # Clip stats for current calendar month (Pacific time)
    tz = ZoneInfo("America/Los_Angeles")
    now = datetime.now(tz)
    import calendar
    month_start = datetime(now.year, now.month, 1, tzinfo=tz).timestamp()
    next_month  = (now.month % 12) + 1
    next_year   = now.year + (1 if now.month == 12 else 0)
    month_end   = datetime(next_year, next_month, 1, tzinfo=tz).timestamp()

    clips_this_month = 0
    last_clip_at     = None
    last_clip_sender = None
    try:
        all_month = _clips.list_clips(limit=200)
        month_clips = [
            c for c in all_month
            if c.get("montage_eligible") and
               month_start <= (c.get("discovered_at") or 0) < month_end
        ]
        month_clips.sort(key=lambda c: c.get("discovered_at") or 0, reverse=True)
        clips_this_month = len(month_clips)
        if month_clips:
            last_clip_at     = month_clips[0].get("discovered_at")
            last_clip_sender = month_clips[0].get("sender_online_id")
    except Exception:
        pass

    # Next auto-build info — find the earliest future build date for a month
    # that doesn't already have a completed montage.
    build_day  = int(os.environ.get("MONTAGE_BUILD_DAY",  "1"))
    build_hour = int(os.environ.get("MONTAGE_BUILD_HOUR", "6"))

    # Fetch existing completed montages so we can skip already-built months
    _built_months: set = set()
    try:
        _mj = _hx.get("http://10.0.1.1:3099/montages", timeout=3).json()
        for _m in _mj:
            if _m.get("status") == "completed":
                _built_months.add((_m["year"], _m["month"]))
    except Exception:
        pass

    # Walk forward month by month until we find one that hasn't been built yet
    _bm, _by = next_month, next_year
    for _ in range(24):
        # The build fires on build_day of (_bm, _by) for the PREVIOUS month
        prev_m = _bm - 1 if _bm > 1 else 12
        prev_y = _by if _bm > 1 else _by - 1
        if (prev_y, prev_m) not in _built_months:
            break
        _bm = (_bm % 12) + 1
        _by = _by + (1 if _bm == 1 else 0)

    next_build_dt = datetime(_by, _bm, build_day, build_hour, 0, 0, tzinfo=tz)
    next_build_ts = next_build_dt.timestamp()
    next_build_label = next_build_dt.strftime("%b %-d, %Y · %-I %p PT")

    # Last completed montage from psn-montage + its manifest
    last_montage = None
    manifest_by_uid: dict = {}  # uid → {included, excluded_reason}
    try:
        mj = _hx.get("http://10.0.1.1:3099/montages", timeout=3).json()
        # Find the latest completed build for the CURRENT month
        current_month_builds = [
            m for m in mj
            if m.get("status") == "completed"
            and m.get("year") == now.year
            and m.get("month") == now.month
        ]
        all_completed = [m for m in mj if m.get("status") == "completed"]
        if current_month_builds:
            m = current_month_builds[0]
            last_montage = {
                "version": m["version"], "year": m["year"], "month": m["month"],
                "clips": m.get("included_clip_count", 0),
                "duration": round(m.get("actual_duration_seconds") or 0, 1),
                "sent": bool(m.get("whatsapp_message_id")),
            }
            try:
                manifest_resp = _hx.get(
                    f"http://10.0.1.1:3099/montages/{m['id']}/manifest", timeout=3
                ).json()
                for c in manifest_resp.get("clips", []):
                    manifest_by_uid[c["message_uid"]] = {
                        "included": c.get("included", False),
                        "excluded_reason": c.get("excluded_reason"),
                    }
            except Exception:
                pass
        elif all_completed:
            m = all_completed[0]
            last_montage = {
                "version": m["version"], "year": m["year"], "month": m["month"],
                "clips": m.get("included_clip_count", 0),
                "duration": round(m.get("actual_duration_seconds") or 0, 1),
                "sent": bool(m.get("whatsapp_message_id")),
            }
    except Exception:
        pass

    # Build clip list for this month enriched with manifest status
    clip_list = []
    for c in month_clips:
        uid = c.get("message_uid", "")
        ms = manifest_by_uid.get(uid, {})
        clip_list.append({
            "uid":      uid,
            "sender":   c.get("sender_online_id") or "unknown",
            "duration": round(c.get("duration_seconds") or 0, 1),
            "at":       c.get("discovered_at"),
            "included": ms.get("included"),          # None = not yet built
            "reason":   ms.get("excluded_reason"),
        })

    return {
        "services": {
            "psn_messenger": {"status": "ok", "ms": 0},
            "psn_montage":   montage_health,
            "wa_bridge":     wa_health,
        },
        "clips_this_month": clips_this_month,
        "last_clip_at":     last_clip_at,
        "last_clip_sender": last_clip_sender,
        "next_build_ts":    next_build_ts,
        "next_build_label": next_build_label,
        "next_build_month": datetime(next_year, next_month, 1, tzinfo=tz).strftime("%B %Y"),
        "last_montage":     last_montage,
        "clips":            clip_list,
    }


@app.post("/api/scan-group")
async def api_scan_group(max_pages: int = 10):
    """Page back through group history and register unprocessed video clips for the montage.

    Paginates using beforeMessageUid up to max_pages×100 messages back.
    Clips are registered in the DB (montage-eligible) but NOT forwarded to WhatsApp —
    this is a backfill only. Live clips arriving via the normal watcher are forwarded.
    """
    if not _v2_available:
        raise HTTPException(503, "PSN auth not available")

    found = 0
    registered = 0
    skipped = 0
    pages_fetched = 0

    for wm in _watched_messengers:
        before_uid: str | None = None
        for _ in range(max_pages):
            try:
                msgs = await asyncio.to_thread(wm.get_messages_page, 100, before_uid)
            except Exception as exc:
                logger.error("scan-group: fetch failed: %s", exc)
                break

            if not msgs:
                break

            pages_fetched += 1
            for msg in msgs:
                uid = msg["messageUid"]
                if not uid:
                    continue
                if msg["messageType"] != 210:
                    continue
                ugc_id = msg["ugcId"]
                if not ugc_id:
                    continue
                found += 1
                sender = msg["sender"]
                ts_raw = msg.get("timestamp")
                psn_ts_ms: int | None = None
                try:
                    psn_ts_ms = int(ts_raw) if ts_raw else None
                except (ValueError, TypeError):
                    pass

                is_new = _clips.claim(
                    uid, ugc_id, wm._group_id, wm._group_name, sender, psn_ts_ms,
                )
                if is_new:
                    logger.info("scan-group: registered uid=%s ugcId=%s sender=%s", uid, ugc_id, sender)
                    registered += 1
                else:
                    skipped += 1

            # Paginate: use the oldest message uid as the cursor
            before_uid = msgs[-1]["messageUid"]
            if len(msgs) < 100:
                break  # last page

    logger.info("scan-group: pages=%d found=%d registered=%d skipped=%d", pages_fetched, found, registered, skipped)
    return {"pages_fetched": pages_fetched, "video_msgs_found": found, "registered": registered, "already_known": skipped}


@app.get("/status")
def status():
    """Lightweight operational status for monitoring."""
    q_depth  = _video_queue.qsize() if _video_queue is not None else 0
    s = _clips.stats()
    return {
        "psn": "connected" if _v2_available else "unavailable",
        "whatsapp": "configured" if (WA_BRIDGE_URL and WA_GOOPERS_JID) else "not_configured",
        "clip_store": _cstore.backend(),
        "groups": len(_watched_messengers),
        "queue_depth": q_depth,
        "clips_total": s.get("total", 0),
        "clips_delivered": s.get("delivered", 0),
        "clips_archived": s.get("archived", 0),
        "clips_failed": s.get("failed", 0),
        "clips_active": s.get("active", 0),
    }


@app.get("/clips")
def api_clips(
    month: str | None = None,
    sender: str | None = None,
    group_id: str | None = None,
    status: str | None = None,
    montage_eligible: bool | None = None,
    limit: int = 50,
    offset: int = 0,
):
    """Clip catalog with optional filters. month='2026-08'."""
    rows = _clips.list_clips(
        month=month, sender=sender, group_id=group_id,
        status=status, montage_eligible=montage_eligible,
        limit=min(limit, 200), offset=offset,
    )
    # Strip sha256 from list response (keep in detail view only)
    for r in rows:
        r.pop("sha256", None)
    return {"clips": rows, "count": len(rows)}


@app.get("/clips/{message_uid:path}")
def api_clip_detail(message_uid: str):
    """Full metadata for one clip."""
    row = _clips.get(message_uid)
    if not row:
        raise HTTPException(status_code=404, detail="clip not found")
    return row


@app.post("/api/clips/{message_uid:path}/resend")
def api_clip_resend(message_uid: str):
    """Force-resend a delivered clip to WhatsApp with a new idempotency key."""
    import base64 as _b64, time as _t
    job = _clips.get(message_uid)
    if not job:
        raise HTTPException(status_code=404, detail="clip not found")
    if not WA_BRIDGE_URL or not WA_GOOPERS_JID:
        raise HTTPException(status_code=503, detail="WA bridge not configured")
    storage_key = job.get("storage_key_original")
    if not storage_key:
        raise HTTPException(status_code=409, detail="clip not yet archived")
    video_bytes = _cstore.load(storage_key)
    if not video_bytes:
        raise HTTPException(status_code=410, detail="archived clip missing from store")
    sender = job.get("sender_online_id", "unknown")
    body   = job.get("body") or ""
    import re as _re
    real_body = body if body and not _re.fullmatch(r'.+ sent a video clip\.', body, _re.IGNORECASE) else ""
    caption = f"🎮 {sender}: {real_body}" if real_body else f"🎮 {sender}"
    import httpx as _httpx
    payload = {
        "videoBase64": _b64.b64encode(video_bytes).decode(),
        "groupJid": WA_GOOPERS_JID,
        "caption": caption,
        "idempotencyKey": f"psn:{message_uid}:r{int(_t.time())}",
    }
    r = _httpx.post(f"{WA_BRIDGE_URL}/send-video", json=payload, timeout=180)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"WA bridge: {r.text[:200]}")
    return {"status": "sent", "caption": caption, "wa": r.json()}


_hype_cache: dict = {}
_HYPE_MAX = 150  # messages = 100%

@app.get("/api/hype")
def api_hype():
    """Count today's squad group messages and return a hype level."""
    global _hype_cache
    if not _v2_available or _squad_messenger is None:
        return {"count": 0, "pct": 0, "label": "❄️ COLD", "level": "cold"}
    now = _time.time()
    if _hype_cache.get("ts", 0) > now - 60:
        return _hype_cache["data"]
    try:
        msgs = _squad_messenger.get_messages(200)
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).date()
        count = 0
        for m in msgs:
            ts = m.get("timestamp", "")
            if not ts:
                continue
            try:
                ts_int = int(ts)
                # PSN returns milliseconds; convert to seconds
                if ts_int > 1e11:
                    ts_int //= 1000
                d = _dt.datetime.fromtimestamp(ts_int, tz=_dt.timezone.utc).date()
                if d == today:
                    count += 1
            except Exception:
                try:
                    d = _dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).date()
                    if d == today:
                        count += 1
                except Exception:
                    continue
        pct = min(100, round(count / _HYPE_MAX * 100))
        if count == 0:
            label, level = "☠️ DEAD SILENT", "dead"
        elif count < 15:
            label, level = "❄️ COLD", "cold"
        elif count < 40:
            label, level = "🌡️ WARMING UP", "warm"
        elif count < 80:
            label, level = "🔥 HOT", "hot"
        elif count < 120:
            label, level = "🔥🔥 ON FIRE", "fire"
        else:
            label, level = "💥 HYPE OVERLOAD", "overload"
        data = {"count": count, "pct": pct, "label": label, "level": level}
        _hype_cache = {"ts": now, "data": data}
        return data
    except Exception as e:
        logger.error("api/hype failed: %s", e)
        return {"count": 0, "pct": 0, "label": "❄️ COLD", "level": "cold"}


@app.get("/api/squad")
def api_squad():
    """Live presence + trophy stats for every squad member (JSON, for the UI)."""
    if not _v2_available:
        return JSONResponse({"squad": [], "error": "auth unavailable"})
    try:
        return {"squad": psn_data.squad_status(psn_auth)}
    except Exception as e:  # noqa: BLE001
        logger.error("dashboard: squad status failed: %s", e)
        return JSONResponse({"squad": [], "error": str(e)}, status_code=500)



class CustomButtonRequest(BaseModel):
    text: str
    send: bool = True  # also fire it to the group immediately


@app.get("/api/soundboard")
def api_soundboard():
    """Current soundboard (built-ins + custom), for live refresh after adds."""
    return {"buttons": _soundboard()}


@app.post("/api/soundboard")
def api_add_button(req: CustomButtonRequest, request: Request):
    """Turn a user's line into an AI-flavored permanent soundboard button.

    Uses the same Bedrock model as the roast bot to punch up the text, saves it
    to /data/soundboard.json, and (optionally) sends it to the group right away.
    """
    _rate_limit("custom_add", request.client.host)
    if req.send:
        _rate_limit("psn_send", request.client.host)
    raw = (req.text or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    if len(raw) > 200:
        raise HTTPException(status_code=400, detail="Too long (200 char max)")

    flavored = roast_bot.flavor_message(raw)

    customs = _load_custom_buttons()
    if len(customs) >= 24:
        raise HTTPException(status_code=400, detail="Soundboard full (24 custom max)")

    # Label: a short preview of the flavored text; color cycles.
    label = flavored if len(flavored) <= 22 else flavored[:21].rstrip() + "…"
    color = _CUSTOM_COLORS[len(customs) % len(_CUSTOM_COLORS)]
    button = {"label": label, "msg": flavored, "cls": color, "custom": True}
    customs.append(button)
    _save_custom_buttons(customs)

    # Fire it now so the person sees it land in the group.
    sent = False
    if req.send and _squad_messenger is not None:
        try:
            sent = _squad_messenger.send_message(flavored)
        except Exception as e:  # noqa: BLE001
            logger.warning("custom button initial send failed: %s", e)

    return {"status": "added", "button": button, "flavored": flavored, "sent": sent}


@app.post("/api/soundboard/delete")
def api_delete_button(req: CustomButtonRequest):
    """Remove a custom button by its exact message text."""
    customs = _load_custom_buttons()
    kept = [b for b in customs if b.get("msg") != req.text]
    _save_custom_buttons(kept)
    return {"status": "deleted", "removed": len(customs) - len(kept)}


@app.get("/", response_class=HTMLResponse)
@app.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request):
    session = _get_session(request)
    user_email = session.get("email", "") if session else ""
    psn_id = ""
    if session:
        rec = portal_mod.find_by_zitadel_id(session.get("sub", ""))
        if rec:
            psn_id = rec.get("online_id", "")
    return HTMLResponse(_dashboard_html(user_email, psn_id))




# The dashboard's "soundboard" buttons. Built-in defaults live here; custom ones
# that anyone adds via the dashboard are AI-flavored and persisted to
# /data/soundboard.json so they become permanent buttons for everyone.
# Each posts a canned message to the squad PSN group via /v2/squad {message};
# `path` instead of `msg` hits a non-message action. `cls` picks a color.
_SOUNDBOARD_DEFAULTS = [
    {"label": "👉👌 Have you ever?", "msg": "Have you ever? 👉👌", "cls": "c1"},
    {"label": "🧊☕ Iced Cap STORY", "msg": "🧊☕ Iced Cap STORRYYY! 📖✨", "cls": "c2"},
    {"label": "🙅‍♂️ Never", "msg": "Never 🙅‍♂️❌", "cls": "c3"},
    {"label": "💧 Water Break", "msg": "💧 Water break! 🚰💦", "cls": "c4"},
    {"label": "🎬 Zubi Clip It", "msg": "🎬 ZUBI CLIP IT!! 📸🔥 That was insane!", "cls": "c5"},
    {"label": "🎮 Squad Up", "msg": "🎮🔥 SQUAD UP! Who's hopping on? 🕹️💥", "cls": "c1"},
    {"label": "🕹️ Game Time", "msg": "🎮🔥 Let's party up y'all. It's GAME TIME! 🕹️💥", "cls": "c2"},
]

from pathlib import Path as _Path

_SOUNDBOARD_FILE = _Path("/data/soundboard.json")
# Colors cycled through for new custom buttons.
_CUSTOM_COLORS = ["c1", "c2", "c3", "c4", "c5"]


def _load_custom_buttons() -> list[dict]:
    try:
        return json.loads(_SOUNDBOARD_FILE.read_text()).get("buttons", [])
    except Exception:  # noqa: BLE001
        return []


def _save_custom_buttons(buttons: list[dict]) -> None:
    _SOUNDBOARD_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SOUNDBOARD_FILE.write_text(json.dumps({"buttons": buttons}, indent=2))


def _soundboard() -> list[dict]:
    """Built-in buttons followed by persisted custom ones."""
    return _SOUNDBOARD_DEFAULTS + _load_custom_buttons()


def _soundboard_json() -> str:
    return json.dumps(_soundboard())


def _dashboard_html(user_email: str = "", psn_id: str = "") -> str:
    if user_email:
        disp = user_email.split("@")[0] if "@" in user_email else user_email
        user_html = (
            '<button class="user-btn" id="userBtn" onclick="toggleUserMenu()" aria-label="Account">'
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>'
            '</svg></button>'
            '<div class="user-drop" id="userMenu">'
            f'<div class="ud-name">{disp}</div>'
            '<button class="ud-item" style="width:100%;border:none;cursor:pointer;margin-bottom:6px" onclick="openSettings()">⚙️ Settings</button>'
            '<a class="ud-item" href="/auth/logout">Sign out</a>'
            '</div>'
        )
    else:
        user_html = '<a class="ud-item" href="/auth/login" style="padding:8px 12px;font-size:12px">Sign in</a>'
    import json as _json
    return (_DASHBOARD_TMPL
            .replace("__SOUNDBOARD__", _soundboard_json())
            .replace("__USER__", user_html)
            .replace("__PSN_ID__", _json.dumps(psn_id)))


_DASHBOARD_TMPL = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" type="image/png" href="/favicon.png">
<title>CRCMZ APP · PSN</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Rajdhani:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  /* ===== NEON / GAMER ARCADE THEME ===== */
  :root { color-scheme:dark;
    --bg:#05030f; --card:rgba(18,10,38,.66); --line:rgba(255,60,200,.22);
    --txt:#f3ecff; --dim:#9d8fc4;
    --neon:#ff2fd6;      /* hot magenta   */
    --cyan:#22e6ff;      /* electric cyan */
    --lime:#8cff2b;      /* acid green    */
    --violet:#9d5cff;    /* violet        */
    --gold:#ffd24a;
    --ok:var(--lime); }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { margin:0; }
  body { font-family:"Rajdhani",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color:var(--txt); min-height:100dvh; background:var(--bg);
    padding:0 0 var(--board-h, 220px); position:relative; overflow-x:hidden;
    font-size:15px; letter-spacing:.2px; }
  /* animated neon aurora */
  body::before { content:""; position:fixed; inset:-30% -10%; z-index:-3;
    background:
      radial-gradient(38% 40% at 18% 12%, rgba(255,47,214,.34), transparent 60%),
      radial-gradient(40% 40% at 84% 18%, rgba(34,230,255,.30), transparent 60%),
      radial-gradient(46% 42% at 55% 96%, rgba(157,92,255,.28), transparent 62%);
    filter:blur(34px); animation:drift 22s ease-in-out infinite alternate; }
  @keyframes drift { to { transform:translate3d(4%,3%,0) scale(1.12); } }
  /* scanline / grid texture overlay */
  body::after { content:""; position:fixed; inset:0; z-index:-2; pointer-events:none;
    opacity:.5;
    background-image:
      linear-gradient(rgba(34,230,255,.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,47,214,.03) 1px, transparent 1px);
    background-size:40px 40px, 40px 40px; }
  .wrap { max-width:760px; margin:0 auto; padding:0 14px; }

  .announce {
    width:100%; overflow:hidden; text-align:center;
    font-size:12px; font-family:"Orbitron",sans-serif; letter-spacing:.5px;
    color:var(--lime); background:rgba(140,255,43,.07);
    border-bottom:1px solid rgba(140,255,43,.15);
    max-height:36px; padding:9px 16px;
    transition:max-height .4s ease, padding .4s ease, opacity .35s ease;
    opacity:1; }
  .announce.empty { max-height:0; padding:0; opacity:0; border-bottom-color:transparent; }
  .announce b { font-size:13px; }

  .top { display:flex; align-items:center; gap:13px; padding:20px 2px 14px; }
  .logo { width:60px; height:60px; flex:none; display:grid;
    place-items:center; font-size:25px; overflow:hidden; }
  h1 { font-family:"Orbitron",sans-serif; font-size:21px; margin:0; font-weight:900;
    letter-spacing:1px; text-transform:uppercase;
    background:linear-gradient(90deg,var(--cyan),var(--neon));
    -webkit-background-clip:text; background-clip:text; color:transparent;
    text-shadow:0 0 18px rgba(255,47,214,.35); }
  .tag { color:var(--dim); font-size:12px; margin:3px 0 0; letter-spacing:1px;
    text-transform:uppercase; }

  /* ── Chat Board (sticky bottom) ── */
  .board-wrap { position:fixed; left:0; right:0; bottom:var(--minibar-h,0px); z-index:30;
    padding:10px 14px calc(12px + env(safe-area-inset-bottom));
    background:linear-gradient(0deg, rgba(7,11,24,.97) 72%, rgba(7,11,24,0));
    backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
    border-top:1px solid var(--line);
    transition:top .25s ease, bottom .25s ease, border-radius .25s ease, background .25s ease; }
  /* ── Watch Party mini-bar (persists across pages while connected) ── */
  .wp-minibar { position:fixed; bottom:0; left:0; right:0; z-index:31;
    padding:8px 14px calc(8px + env(safe-area-inset-bottom));
    background:rgba(7,11,24,.98); border-top:1px solid rgba(34,230,255,.18);
    backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    display:none; }
  .wp-minibar.on { display:block; }
  .wp-minibar-inner { display:flex; align-items:center; gap:10px;
    max-width:760px; margin:0 auto; height:38px; }
  .wp-minibar-back { background:rgba(34,230,255,.07); border:1px solid rgba(34,230,255,.28);
    color:var(--cyan); border-radius:10px; padding:0 13px; height:38px; font-size:14px;
    cursor:pointer; flex-shrink:0; white-space:nowrap;
    font-family:"Rajdhani",sans-serif; font-weight:700; letter-spacing:.3px; }
  .wp-minibar-back:active { background:rgba(34,230,255,.18); }
  .wp-minibar-info { flex:1; min-width:0; }
  .wp-minibar-label { font-size:10px; font-weight:700; color:var(--dim);
    text-transform:uppercase; letter-spacing:1px; display:block; line-height:1.2; }
  .wp-minibar-sub { font-size:13px; color:#fff; font-weight:600;
    font-family:"Rajdhani",sans-serif; display:block;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.5; }
  .wp-minibar-mute { background:none; border:1px solid rgba(255,255,255,.18);
    color:#fff; border-radius:10px; padding:0 12px; height:38px; font-size:13px;
    cursor:pointer; flex-shrink:0; font-weight:700;
    font-family:"Rajdhani",sans-serif; white-space:nowrap; }
  .wp-minibar-mute.muted { border-color:rgba(255,80,80,.45); color:#ff6060;
    background:rgba(255,60,60,.1); }
  @keyframes wpMiniPulse {
    0%,100%{ box-shadow:0 0 0 0 rgba(140,255,43,.5); }
    50%{ box-shadow:0 0 0 7px rgba(140,255,43,0); } }
  .wp-minibar.speaking .wp-minibar-back { border-color:rgba(140,255,43,.5);
    color:var(--lime); animation:wpMiniPulse 1.15s ease-in-out infinite; }
  .board-wrap > * { max-width:760px; margin:0 auto; }
  /* fullscreen: covers the whole viewport */
  .board-wrap.fullscreen { top:0; border-radius:0; overflow-y:auto;
    background:rgba(7,11,24,.99); border-top:none; padding-top:calc(10px + env(safe-area-inset-top)); }
  .board-wrap.fullscreen .board { max-height:none; overflow-y:visible; }
  /* header row: fs icon + toggle button */
  .board-hdr { display:flex; align-items:center; gap:8px; margin:0 0 8px; }
  .board-fs-btn { flex:none; width:32px; height:32px; border:1px solid rgba(34,230,255,.28);
    border-radius:9px; background:none; color:var(--cyan); cursor:pointer; font-size:15px;
    display:grid; place-items:center; transition:background .12s, border-color .12s; }
  .board-fs-btn:active { background:rgba(34,230,255,.18); }
  .board-toggle-btn { flex:1; display:flex; align-items:center; gap:7px;
    font-size:10.5px; letter-spacing:2px; color:var(--cyan); text-transform:uppercase;
    font-weight:700; padding:4px 4px; background:none; border:none; cursor:pointer;
    font-family:"Orbitron",sans-serif; text-shadow:0 0 10px rgba(34,230,255,.4); }
  .board-toggle-btn .chev { transition:transform .25s ease; font-size:13px; }
  .board-wrap.collapsed .chev { transform:rotate(-90deg); }
  /* hint shown briefly under the title to teach the toggle */
  .board-hint { font-size:10px; color:var(--dim); text-align:center;
    overflow:hidden; pointer-events:none;
    animation:hintfade 10s ease 1s both; }
  @keyframes hintfade {
    0%  { opacity:0;   max-height:22px; margin:0 0 6px }
    8%  { opacity:.48; max-height:22px; margin:0 0 6px }
    80% { opacity:.48; max-height:22px; margin:0 0 6px }
    100%{ opacity:0;   max-height:0;    margin:0 } }
  .board { display:grid; grid-template-columns:repeat(3,1fr); gap:8px;
    max-height:52vh; overflow-y:auto; -webkit-overflow-scrolling:touch;
    transition:max-height .28s ease, opacity .2s ease, margin .28s ease; }
  /* collapsed: hide buttons grid */
  .board-wrap.collapsed .board { max-height:0; opacity:0; overflow:hidden;
    margin-bottom:-8px; pointer-events:none; }
  /* organize mode: wiggle + grab cursor */
  .board-wrap.organizing .snd:not(.add) { animation:wiggle .35s ease infinite alternate;
    cursor:grab; touch-action:none; }
  @keyframes wiggle { from{transform:rotate(-.6deg) scale(1)} to{transform:rotate(.6deg) scale(1.01)} }
  .snd.drag-ghost { opacity:.35; transform:scale(.92)!important; }
  .snd.drop-target { border-color:var(--cyan)!important;
    box-shadow:0 0 22px rgba(34,230,255,.55)!important; transform:scale(1.06)!important; }
  .board-done-btn { display:none; width:100%; margin-top:10px; padding:13px;
    border-radius:13px; border:none; cursor:pointer; font-weight:800; font-size:14px;
    font-family:"Orbitron",sans-serif; letter-spacing:1px;
    background:linear-gradient(135deg,var(--cyan),var(--neon)); color:#07080f; }
  /* ad-hoc quick-send row */
  .quick { display:flex; gap:8px; margin-top:10px; }
  .quick input { flex:1; padding:13px 15px; border-radius:12px; font-size:15px;
    border:1px solid rgba(34,230,255,.28); background:rgba(6,4,18,.8); color:var(--txt);
    -webkit-appearance:none; font-family:"Rajdhani",sans-serif; }
  .quick input:focus { outline:none; border-color:var(--cyan);
    box-shadow:0 0 0 3px rgba(34,230,255,.22), 0 0 16px rgba(34,230,255,.25); }
  .qsend { flex:none; width:52px; border:none; border-radius:12px; font-size:18px;
    color:#fff; cursor:pointer; background:linear-gradient(135deg,var(--cyan),var(--neon));
    box-shadow:0 0 16px rgba(255,47,214,.45); transition:transform .07s, filter .12s; }
  .qsend:active { transform:scale(.94); } .qsend:hover { filter:brightness(1.12); }
  .qsend:disabled { opacity:.5; }
  .snd { border:1px solid rgba(255,255,255,.14); border-radius:13px; padding:13px 8px;
    font-size:12.5px; font-weight:700; cursor:pointer; color:#fff; line-height:1.22;
    min-height:56px; display:flex; align-items:center; justify-content:center;
    text-align:center; position:relative; overflow:hidden;
    font-family:"Rajdhani",sans-serif; letter-spacing:.3px;
    transition:transform .07s, filter .12s, box-shadow .12s; }
  .snd:active { transform:scale(.93); }
  .snd:hover { filter:brightness(1.18) saturate(1.2); }
  .snd.flash { animation:flash .5s ease; }
  @keyframes flash { 0%{ box-shadow:0 0 0 0 rgba(140,255,43,.8);} 100%{ box-shadow:0 0 0 16px rgba(140,255,43,0);} }
  .snd.custom { position:relative; }
  .snd.custom::after { content:"✕"; position:absolute; top:3px; right:6px; font-size:10px; opacity:.5; }
  .snd.holding { animation:holdpulse .6s ease forwards; }
  @keyframes holdpulse { to { transform:scale(.86); filter:brightness(.6) saturate(1.5);
    box-shadow:0 0 0 3px rgba(255,47,120,.8) inset, 0 0 20px rgba(255,47,120,.6); } }
  /* neon color chips -- dark fill + glowing border/text */
  .c1 { background:linear-gradient(135deg,rgba(34,230,255,.16),rgba(34,230,255,.04));
    border-color:rgba(34,230,255,.55); color:#c8fbff; box-shadow:0 0 14px rgba(34,230,255,.25); }
  .c2 { background:linear-gradient(135deg,rgba(255,47,214,.16),rgba(255,47,214,.04));
    border-color:rgba(255,47,214,.55); color:#ffd6f6; box-shadow:0 0 14px rgba(255,47,214,.25); }
  .c3 { background:linear-gradient(135deg,rgba(157,92,255,.18),rgba(157,92,255,.05));
    border-color:rgba(157,92,255,.55); color:#e4d4ff; box-shadow:0 0 14px rgba(157,92,255,.25); }
  .c4 { background:linear-gradient(135deg,rgba(140,255,43,.15),rgba(140,255,43,.04));
    border-color:rgba(140,255,43,.5); color:#e0ffc0; box-shadow:0 0 14px rgba(140,255,43,.22); }
  .c5 { background:linear-gradient(135deg,rgba(255,210,74,.18),rgba(255,150,58,.05));
    border-color:rgba(255,210,74,.55); color:#fff0c0; box-shadow:0 0 14px rgba(255,180,60,.25); }
  .snd.add { background:rgba(255,255,255,.03); border:1.5px dashed rgba(255,47,214,.5);
    color:#ff9ee8; box-shadow:none; }

  /* ── Liquid Nav ─────────────────────────────────────────────── */
  .nav-wrap { position:relative; margin:14px 0; z-index:200; }

  .nav-trigger {
    width:100%; display:flex; align-items:center; gap:12px;
    padding:13px 18px; border-radius:18px; border:1px solid var(--line);
    background:rgba(255,255,255,.04); backdrop-filter:blur(20px);
    -webkit-backdrop-filter:blur(20px);
    color:var(--txt); cursor:pointer;
    transition:border-color .3s, box-shadow .3s, border-radius .4s cubic-bezier(0.34,1.56,0.64,1);
    box-shadow:0 2px 16px rgba(0,0,0,.3); }
  .nav-trigger:hover { border-color:rgba(255,47,214,.4); box-shadow:0 4px 24px rgba(255,47,214,.15); }
  .nav-trigger.open {
    border-radius:18px 18px 0 0; border-color:rgba(255,47,214,.35);
    box-shadow:0 0 28px rgba(255,47,214,.2); }

  .nav-t-icon { font-size:20px; line-height:1; flex:none; }
  .nav-t-label {
    flex:1; text-align:left; font-family:"Rajdhani",sans-serif;
    font-size:15px; font-weight:700; letter-spacing:.8px; text-transform:uppercase; }
  .nav-t-sub {
    font-size:11px; color:var(--dim); letter-spacing:.3px;
    font-weight:500; text-transform:none; font-family:"Rajdhani",sans-serif; }

  .nav-chevron {
    width:18px; height:18px; flex:none; color:var(--dim);
    transition:transform .5s cubic-bezier(0.34,1.56,0.64,1), color .3s; }
  .nav-trigger.open .nav-chevron { transform:rotate(-180deg); color:var(--neon); }

  .nav-dropdown {
    position:absolute; top:100%; left:0; right:0;
    background:rgba(12,6,28,.96); backdrop-filter:blur(28px);
    -webkit-backdrop-filter:blur(28px);
    border:1px solid rgba(255,47,214,.25); border-top:none;
    border-radius:0 0 18px 18px;
    overflow:hidden; pointer-events:none;
    clip-path:inset(0 0 100% 0 round 0 0 18px 18px);
    opacity:0;
    transition:
      clip-path .5s cubic-bezier(0.34,1.56,0.64,1),
      opacity .25s ease;
    box-shadow:0 16px 40px rgba(0,0,0,.5), 0 0 0 1px rgba(255,47,214,.08) inset; }
  .nav-dropdown.open {
    clip-path:inset(0 0 -2px 0 round 0 0 18px 18px);
    opacity:1; pointer-events:auto; }

  .nav-item {
    width:100%; display:flex; align-items:center; gap:14px;
    padding:14px 20px; border:none; background:none;
    color:var(--dim); cursor:pointer;
    font-family:"Rajdhani",sans-serif; font-size:14px;
    font-weight:700; letter-spacing:.6px; text-transform:uppercase;
    text-align:left; position:relative; overflow:hidden;
    opacity:0; transform:translateY(-10px) scale(.97);
    transition:color .2s, opacity .0s, transform .0s; }
  .nav-item::before {
    content:""; position:absolute; inset:0;
    background:linear-gradient(90deg, rgba(255,47,214,.12), transparent);
    transform:translateX(-100%);
    transition:transform .4s cubic-bezier(0.34,1.56,0.64,1); }
  .nav-item:hover::before { transform:translateX(0); }
  .nav-item:hover { color:#fff; }
  .nav-item + .nav-item { border-top:1px solid rgba(255,255,255,.04); }

  .nav-item.on { color:var(--neon); }
  .nav-item.on::after {
    content:""; position:absolute; left:0; top:20%; bottom:20%;
    width:3px; border-radius:2px;
    background:linear-gradient(to bottom, var(--neon), var(--violet));
    box-shadow:0 0 8px var(--neon); }

  .nav-i-icon { font-size:18px; line-height:1; flex:none; }

  /* stagger items in when dropdown opens */
  .nav-dropdown.open .nav-item {
    opacity:1; transform:none;
    transition:
      color .2s,
      opacity .35s ease calc(var(--ni,0) * 55ms),
      transform .45s cubic-bezier(0.34,1.56,0.64,1) calc(var(--ni,0) * 55ms); }
  .nav-item:nth-child(1){--ni:0} .nav-item:nth-child(2){--ni:1}
  .nav-item:nth-child(3){--ni:2} .nav-item:nth-child(4){--ni:3}
  .nav-item:nth-child(5){--ni:4} .nav-item:nth-child(6){--ni:5}
  .nav-item:nth-child(7){--ni:6} .nav-item:nth-child(8){--ni:7}

  /* panel animation */
  .panel { display:none; }
  .panel.on { display:block; animation:panelIn .4s cubic-bezier(0.34,1.56,0.64,1) both; overflow-x:hidden; }
  @keyframes panelIn {
    from { opacity:0; transform:translateY(12px) scale(.985); }
    to   { opacity:1; transform:none; } }

  .card { background:var(--card); border:1px solid var(--line); border-radius:16px;
    padding:8px 16px; backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
    box-shadow:0 0 24px rgba(255,47,214,.08), inset 0 1px 0 rgba(255,255,255,.05); }
  .row { display:flex; align-items:center; gap:13px; padding:13px 4px;
    border-bottom:1px solid rgba(255,255,255,.05); }
  .row:last-child { border-bottom:none; }
  .avwrap { position:relative; flex:none; }
  .av { width:50px; height:50px; border-radius:12px; background:#1a1030; object-fit:cover;
    display:block; border:1px solid rgba(255,255,255,.1); }
  .playing .av { border-color:rgba(140,255,43,.6); box-shadow:0 0 14px rgba(140,255,43,.4); }
  .gicon { position:absolute; right:-6px; bottom:-6px; width:26px; height:26px;
    border-radius:8px; object-fit:cover; border:2px solid #0e0620; box-shadow:0 2px 8px rgba(0,0,0,.7); }
  .who { flex:1; min-width:0; }
  .name { font-weight:700; font-size:15.5px; display:flex; align-items:center;
    font-family:"Rajdhani",sans-serif; letter-spacing:.3px; }
  .mm { color:#7a6ca0; font-size:12px; font-weight:500; margin-left:6px; }
  .state { font-size:12.5px; color:var(--dim); margin-top:3px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:9px; height:9px; border-radius:50%; margin-right:7px; flex:none;
    background:#4a3f6b; display:inline-block; }
  .playing .name { color:#eaffd4; }
  .playing .dot { background:var(--lime); box-shadow:0 0 12px var(--lime); animation:pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow:0 0 3px var(--lime); opacity:.55; } }
  .game-badge { color:var(--lime); font-weight:600; text-shadow:0 0 8px rgba(140,255,43,.4); }
  .game-badge b { color:#eaffd4; }
  .lastgame { color:#8a7db0; }
  .troph { display:flex; gap:9px; align-items:center; flex:none; }
  .lvl { text-align:center; }
  .lvl .v { font-size:18px; font-weight:800; line-height:1; font-family:"Orbitron",sans-serif;
    background:linear-gradient(135deg,var(--gold),#ff9d3a);
    -webkit-background-clip:text; background-clip:text; color:transparent;
    text-shadow:0 0 12px rgba(255,180,60,.4); }
  .lvl .k { font-size:9px; color:var(--dim); letter-spacing:.5px; }
  .tcount { font-size:11.5px; color:var(--dim); text-align:right; line-height:1.5; }
  .tcount .p { color:var(--cyan); font-weight:700; }

  /* "playing together" hype banner */
  .together { display:flex; align-items:center; gap:12px; margin-bottom:14px;
    padding:14px 16px; border-radius:16px; cursor:pointer;
    background:linear-gradient(135deg,rgba(140,255,43,.16),rgba(34,230,255,.1));
    border:1px solid rgba(140,255,43,.5); box-shadow:0 0 24px rgba(140,255,43,.25);
    animation:fade .4s ease both; }
  .together .gicon2 { width:46px; height:46px; border-radius:11px; object-fit:cover; flex:none;
    border:1px solid rgba(255,255,255,.2); }
  .together .t-main { flex:1; min-width:0; }
  .together .t-title { font-family:"Orbitron",sans-serif; font-weight:800; font-size:14px;
    color:#eaffd4; text-shadow:0 0 10px rgba(140,255,43,.5); }
  .together .t-sub { font-size:12.5px; color:var(--dim); margin-top:2px; }
  .together .t-go { font-size:11px; font-weight:700; color:#04210f; padding:8px 12px;
    border-radius:10px; background:linear-gradient(135deg,var(--lime),var(--cyan)); flex:none;
    text-transform:uppercase; letter-spacing:.5px; }
  /* squad stat tiles */
  .statgrid { display:grid; grid-template-columns:repeat(3,1fr); gap:9px; margin-bottom:14px; }
  .stile { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:12px 8px; text-align:center; backdrop-filter:blur(14px); }
  .stile .sv { font-family:"Orbitron",sans-serif; font-size:19px; font-weight:800; line-height:1;
    background:linear-gradient(135deg,var(--cyan),var(--neon));
    -webkit-background-clip:text; background-clip:text; color:transparent; }
  .stile .sl { font-size:9.5px; color:var(--dim); margin-top:6px; letter-spacing:.6px;
    text-transform:uppercase; }

  /* ── Hype Meter ── */
  .hype-wrap { margin-bottom:14px; padding:12px 14px; border-radius:14px;
    background:var(--card); border:1px solid var(--line);
    backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px); }
  .hype-head { display:flex; align-items:center; justify-content:space-between;
    margin-bottom:8px; }
  .hype-title { font-family:"Orbitron",sans-serif; font-size:9px; letter-spacing:2px;
    color:var(--dim); text-transform:uppercase; }
  .hype-label { font-size:13px; font-weight:700; letter-spacing:.5px;
    font-family:"Rajdhani",sans-serif; }
  .hype-count { font-family:"Orbitron",sans-serif; font-size:16px; font-weight:800;
    background:linear-gradient(135deg,var(--cyan),var(--neon));
    -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hype-track { height:10px; border-radius:99px; background:rgba(255,255,255,.07);
    overflow:hidden; }
  .hype-fill { height:100%; border-radius:99px; width:0%;
    transition:width .8s cubic-bezier(.4,0,.2,1); }
  .hype-fill.dead  { background:rgba(157,92,255,.4); }
  .hype-fill.cold  { background:linear-gradient(90deg,#4488ff,#22e6ff);
    box-shadow:0 0 10px rgba(34,230,255,.5); }
  .hype-fill.warm  { background:linear-gradient(90deg,var(--cyan),var(--lime));
    box-shadow:0 0 12px rgba(140,255,43,.45); }
  .hype-fill.hot   { background:linear-gradient(90deg,var(--lime),var(--gold));
    box-shadow:0 0 14px rgba(255,180,60,.55); animation:hypepulse 1.8s ease-in-out infinite; }
  .hype-fill.fire  { background:linear-gradient(90deg,var(--gold),var(--neon));
    box-shadow:0 0 18px rgba(255,47,214,.65); animation:hypepulse 1.2s ease-in-out infinite; }
  .hype-fill.overload { background:linear-gradient(90deg,var(--neon),var(--cyan),var(--neon));
    background-size:200% 100%; box-shadow:0 0 22px rgba(255,47,214,.8);
    animation:hyperain 1s linear infinite, hypepulse .8s ease-in-out infinite; }
  @keyframes hypepulse { 50% { filter:brightness(1.3) saturate(1.4); } }
  @keyframes hyperain { to { background-position:200% 0; } }

  .lb-row { display:flex; align-items:center; gap:13px; padding:13px 4px;
    border-bottom:1px solid rgba(255,255,255,.05); }
  .lb-row:last-child { border-bottom:none; }
  .rank { width:30px; text-align:center; font-size:17px; font-weight:800; color:var(--dim);
    flex:none; font-family:"Orbitron",sans-serif; }
  .bar { height:7px; border-radius:99px; background:rgba(255,255,255,.06); margin-top:6px; overflow:hidden; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--cyan),var(--neon));
    box-shadow:0 0 10px rgba(255,47,214,.5); }

  .empty { color:#7d8ab0; text-align:center; padding:30px 10px; font-size:14px; line-height:1.6; }
  .spin { color:#7d8ab0; text-align:center; padding:26px; }
  .link-cta { color:#7fb2ff; font-size:12.5px; text-decoration:none; }
  .toast { position:fixed; left:50%; bottom:22px; transform:translateX(-50%);
    background:#1b2540; border:1px solid #33436b; color:#eaf0ff; padding:12px 20px;
    border-radius:13px; font-size:14px; opacity:0; pointer-events:none; transition:opacity .2s;
    z-index:50; box-shadow:0 12px 30px rgba(0,0,0,.5); }
  .toast.show { opacity:1; }

  /* ── Sent flyout animation ── */
  .sent-fly { position:fixed; z-index:200; pointer-events:none;
    transform:translateX(-50%);
    display:flex; align-items:center; gap:10px;
    background:rgba(12,6,28,.82); border:1px solid rgba(255,255,255,.14);
    backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
    border-radius:18px; padding:10px 16px 10px 10px;
    box-shadow:0 8px 32px rgba(0,0,0,.5), 0 0 0 1px rgba(255,47,214,.18);
    animation:sentfly 1.5s cubic-bezier(.22,.6,.36,1) forwards; }
  .sent-fly .sf-av { width:40px; height:40px; border-radius:50%; object-fit:cover;
    flex:none; border:2px solid rgba(255,255,255,.2);
    background:linear-gradient(135deg,var(--violet),var(--neon)); }
  .sent-fly .sf-av-fallback { width:40px; height:40px; border-radius:50%; flex:none;
    display:grid; place-items:center; font-size:18px;
    background:linear-gradient(135deg,var(--violet),var(--neon));
    border:2px solid rgba(255,255,255,.2); }
  .sent-fly .sf-info { min-width:0; }
  .sent-fly .sf-name { font-family:"Orbitron",sans-serif; font-size:10px;
    letter-spacing:1px; color:var(--cyan); text-transform:uppercase; margin-bottom:2px; }
  .sent-fly .sf-msg { font-size:13px; font-weight:600; color:var(--txt);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px; }
  .sent-fly .sf-tick { font-size:15px; margin-left:4px; flex:none;
    filter:drop-shadow(0 0 6px rgba(140,255,43,.8)); }
  @keyframes sentfly {
    0%   { transform:translateX(-50%) translateY(0)    scale(1);    opacity:1; }
    15%  { transform:translateX(-50%) translateY(-8px) scale(1.04); opacity:1; }
    70%  { transform:translateX(-50%) translateY(-55vh) scale(.88); opacity:.55; }
    100% { transform:translateX(-50%) translateY(-92vh) scale(.72); opacity:0; }
  }

  /* ── Pipeline / Montage panel ── */
  .pip-section { margin-bottom:14px; }
  .pip-title { font-family:"Orbitron",sans-serif; font-size:10px; letter-spacing:2px;
    color:var(--dim); text-transform:uppercase; margin:0 0 8px; padding:0 2px; }
  .svc-row { display:flex; align-items:center; gap:11px; padding:12px 14px;
    background:var(--card); border:1px solid var(--line); border-radius:13px;
    margin-bottom:8px; }
  .svc-dot { width:10px; height:10px; border-radius:50%; flex:none;
    box-shadow:0 0 7px currentColor; }
  .dot-ok   { background:var(--lime); color:var(--lime); }
  .dot-warn { background:var(--gold); color:var(--gold); }
  .dot-down { background:#ff4040;     color:#ff4040; }
  .svc-name { font-weight:700; font-size:14px; flex:1; }
  .svc-meta { font-size:12px; color:var(--dim); }
  .big-stat { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px; }
  .bstat { background:var(--card); border:1px solid var(--line); border-radius:13px;
    padding:14px 16px; text-align:center; }
  .bstat .bv { font-family:"Orbitron",sans-serif; font-size:28px; font-weight:900;
    background:linear-gradient(90deg,var(--cyan),var(--neon));
    -webkit-background-clip:text; background-clip:text; color:transparent; line-height:1.1; }
  .bstat .bl { font-size:11px; color:var(--dim); text-transform:uppercase;
    letter-spacing:1px; margin-top:4px; }
  .pip-build { background:var(--card); border:1px solid var(--line); border-radius:13px;
    padding:14px 16px; margin-bottom:14px; }
  .pip-build .pb-label { font-size:11px; color:var(--dim); text-transform:uppercase;
    letter-spacing:1px; margin-bottom:5px; }
  .pip-build .pb-date { font-family:"Orbitron",sans-serif; font-size:14px;
    color:var(--gold); text-shadow:0 0 10px rgba(255,210,74,.5); }
  .pip-build .pb-countdown { font-size:12px; color:var(--cyan); margin-top:4px; }
  .last-montage { background:var(--card); border:1px solid var(--line);
    border-radius:13px; padding:14px 16px; margin-bottom:14px; }
  .lm-row { display:flex; justify-content:space-between; align-items:center;
    font-size:13px; padding:3px 0; }
  .lm-key { color:var(--dim); }
  .lm-val { font-weight:700; }
  .sent-badge { display:inline-block; padding:2px 9px; border-radius:20px; font-size:11px;
    font-weight:700; letter-spacing:.5px; }
  .sent-badge.yes { background:rgba(140,255,43,.15); color:var(--lime);
    border:1px solid rgba(140,255,43,.4); }
  .sent-badge.no  { background:rgba(255,64,64,.12); color:#ff9090;
    border:1px solid rgba(255,64,64,.3); }
  .last-clip-note { font-size:12px; color:var(--dim); text-align:center;
    margin-top:2px; padding:4px 0; }
  .clip-list { background:var(--card); border:1px solid var(--line);
    border-radius:13px; overflow:hidden; }
  .clip-row { display:flex; align-items:center; gap:9px; padding:10px 14px;
    font-size:13px; border-bottom:1px solid rgba(255,255,255,.05); }
  .clip-row:last-child { border-bottom:none; }
  .cdot { width:18px; text-align:center; font-size:12px; font-weight:900; flex:none; }
  .cdot-in   { color:var(--lime); }
  .cdot-ex   { color:#ff6060; }
  .cdot-pend { color:var(--dim); }
  .csender { font-weight:700; flex:1; min-width:0; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .cdur { color:var(--cyan); font-size:12px; flex:none; }
  .creason { font-size:11px; color:var(--gold); background:rgba(255,210,74,.1);
    border:1px solid rgba(255,210,74,.25); border-radius:8px; padding:1px 7px;
    flex:none; white-space:nowrap; }
  .cage { color:var(--dim); font-size:11px; flex:none; margin-left:auto; }

  /* ── WhatsApp tab ── */
  .wa-range { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:10px; }
  .wa-rb { padding:5px 11px; border-radius:20px; border:1px solid rgba(255,255,255,.15);
    background:none; color:var(--dim); font-size:11px; cursor:pointer;
    font-family:"Rajdhani",sans-serif; font-weight:700; letter-spacing:.3px;
    transition:background .12s, color .12s, border-color .12s; }
  .wa-rb.on { background:linear-gradient(135deg,rgba(34,230,255,.18),rgba(157,92,255,.12));
    border-color:var(--cyan); color:var(--cyan); }
  .wa-date-in { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.15);
    border-radius:9px; padding:7px 10px; color:var(--txt); font-size:13px;
    outline:none; font-family:"Rajdhani",sans-serif; }
  .wa-date-in:focus { border-color:var(--cyan); }
  .wa-top { margin-bottom:6px; }
  .wa-award-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(155px,1fr)); gap:8px; margin-bottom:14px; }
  .wa-award { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:12px 10px; text-align:center; }
  .wa-award .aw-em { font-size:24px; margin-bottom:5px; }
  .wa-award .aw-role { font-size:9px; color:var(--dim); text-transform:uppercase;
    letter-spacing:.8px; margin-bottom:3px; }
  .wa-award .aw-name { font-size:14px; font-weight:700; color:var(--txt); }
  .wa-award .aw-stat { font-size:10px; color:var(--dim); margin-top:2px; }
  .wa-cloud { display:flex; flex-wrap:wrap; gap:6px; padding:12px 16px; }
  .wa-cloud span { border-radius:6px; padding:2px 8px; background:rgba(157,92,255,.12);
    border:1px solid rgba(157,92,255,.2); cursor:default; }
  .wa-bar-row { display:flex; align-items:center; gap:8px; padding:6px 0;
    border-bottom:1px solid rgba(255,255,255,.04); }
  .wa-bar-row:last-child { border-bottom:none; }
  .wa-bar-name { width:80px; font-size:12px; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; flex-shrink:0; }
  .wa-bar-track { flex:1; height:6px; background:rgba(255,255,255,.06); border-radius:3px; overflow:hidden; }
  .wa-bar-fill { height:100%; border-radius:3px; background:linear-gradient(90deg,var(--cyan),var(--neon)); }
  .wa-bar-val { font-size:11px; color:var(--dim); flex-shrink:0; min-width:36px; text-align:right; }
  .wa-word-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
  @media(max-width:600px){ .wa-word-grid { grid-template-columns:1fr; } }

  /* ── Giveaway ── */
  .gw-hero { border-radius:20px; padding:28px 20px 24px; text-align:center;
    background:linear-gradient(135deg,rgba(255,47,214,.1),rgba(157,92,255,.1));
    border:1px solid rgba(255,47,214,.2); margin-bottom:14px; position:relative; overflow:hidden; }
  .gw-hero::before { content:''; position:absolute; inset:0;
    background:radial-gradient(ellipse at 50% 0%,rgba(255,47,214,.12) 0%,transparent 65%); pointer-events:none; }
  .gw-hero-title { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--dim); margin-bottom:6px; }
  .gw-hero-prize { font-size:18px; font-weight:700; color:var(--txt); margin-bottom:20px; }
  .gw-timer { display:flex; justify-content:center; gap:10px; }
  .gw-unit { display:flex; flex-direction:column; align-items:center; gap:3px; min-width:48px; }
  .gw-unit-val { font-size:28px; font-weight:900; font-family:'Orbitron',monospace; line-height:1;
    background:linear-gradient(135deg,var(--neon),var(--violet)); -webkit-background-clip:text;
    -webkit-text-fill-color:transparent; background-clip:text; }
  .gw-unit-lbl { font-size:9px; text-transform:uppercase; letter-spacing:.07em; color:var(--dim); }
  .gw-eligibility { display:inline-flex; align-items:center; gap:6px; margin-top:16px;
    background:rgba(255,255,255,.06); border-radius:20px; padding:5px 14px; font-size:13px; }
  .gw-eligibility.eligible { color:#4ade80; }
  .gw-eligibility.ineligible { color:var(--dim); }
  .gw-winner-reveal { text-align:center; padding:24px 16px; }
  .gw-winner-name { font-size:40px; font-weight:900; line-height:1.1;
    background:linear-gradient(135deg,#fff 0%,var(--neon) 50%,var(--violet) 100%);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
    animation:gwPop .6s cubic-bezier(.34,1.56,.64,1); }
  @keyframes gwPop { from{transform:scale(.6);opacity:0} to{transform:scale(1);opacity:1} }
  .gw-winner-prize { margin-top:10px; display:inline-block;
    background:linear-gradient(135deg,rgba(255,215,0,.2),rgba(255,165,0,.1));
    border:1px solid rgba(255,215,0,.3); border-radius:20px; padding:6px 16px;
    font-size:13px; color:#ffd700; font-weight:600; }
  .gw-rotation { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.07);
    border-radius:14px; padding:16px; margin-bottom:14px; }
  .gw-rotation-label { font-size:12px; color:var(--dim); margin-bottom:8px; }
  .gw-bar { height:5px; background:rgba(255,255,255,.08); border-radius:3px; overflow:hidden; margin-bottom:6px; }
  .gw-bar-fill { height:100%; border-radius:3px;
    background:linear-gradient(90deg,var(--neon),var(--violet)); transition:width .6s ease; }
  .gw-rotation-count { font-size:12px; color:var(--dim); }
  .gw-history summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--dim);
    padding:4px 0; list-style:none; display:flex; align-items:center; gap:6px; }
  .gw-history summary::before { content:'▸'; transition:transform .2s; }
  .gw-history[open] summary::before { transform:rotate(90deg); }
  .gw-history-row { display:flex; justify-content:space-between; align-items:center;
    padding:8px 0; border-bottom:1px solid rgba(255,255,255,.05); font-size:13px; }
  .gw-history-row:last-child { border-bottom:none; }
  .gw-admin { background:rgba(255,255,255,.03); border:1px solid rgba(255,47,214,.2);
    border-radius:14px; padding:16px; margin-top:14px; }
  .gw-admin h3 { font-size:11px; font-weight:700; color:var(--neon); text-transform:uppercase;
    letter-spacing:.08em; margin:0 0 14px; }
  .gw-admin-preview { background:rgba(255,215,0,.07); border:1px solid rgba(255,215,0,.2);
    border-radius:10px; padding:12px 14px; margin-bottom:14px; }
  .gw-admin-preview .gw-ap-lbl { font-size:10px; text-transform:uppercase; letter-spacing:.07em;
    color:rgba(255,215,0,.6); margin-bottom:4px; }
  .gw-admin-preview .gw-ap-name { font-size:20px; font-weight:800; color:#ffd700; }
  .gw-status-badge { display:inline-block; padding:3px 10px; border-radius:12px; font-size:11px;
    font-weight:700; text-transform:uppercase; letter-spacing:.06em; margin-bottom:10px; }
  .gw-status-draft { background:rgba(100,100,100,.2); color:#aaa; border:1px solid rgba(255,255,255,.1); }
  .gw-status-open { background:rgba(34,230,255,.15); color:#22e6ff; border:1px solid rgba(34,230,255,.3); }
  .gw-status-locked { background:rgba(255,165,0,.15); color:#ffa500; border:1px solid rgba(255,165,0,.3); }
  .gw-status-drawn { background:rgba(157,92,255,.2); color:#9d5cff; border:1px solid rgba(157,92,255,.4); }
  .gw-status-revealed { background:rgba(255,47,214,.2); color:#ff2fd6; border:1px solid rgba(255,47,214,.4); }
  .gw-admin-field { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
  .gw-admin-field label { font-size:11px; color:var(--dim); }
  .gw-admin-field input, .gw-admin-field select { background:rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:8px 12px;
    color:var(--txt); font-size:13px; outline:none; color-scheme:dark; width:100%; box-sizing:border-box; }
  .gw-admin-field input:focus { border-color:rgba(255,47,214,.5); }
  .gw-admin-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .gw-btn-primary { padding:8px 16px; border-radius:8px; border:1px solid rgba(255,47,214,.5);
    background:linear-gradient(135deg,rgba(255,47,214,.25),rgba(157,92,255,.2));
    color:#fff; cursor:pointer; font-size:13px; font-weight:600; transition:all .2s; }
  .gw-btn-primary:hover { background:linear-gradient(135deg,rgba(255,47,214,.4),rgba(157,92,255,.35)); }
  .gw-btn-secondary { padding:8px 14px; border-radius:8px; border:1px solid rgba(255,255,255,.15);
    background:rgba(255,255,255,.06); color:var(--txt); cursor:pointer; font-size:13px; transition:all .2s; }
  .gw-btn-secondary:hover { background:rgba(255,255,255,.1); }
  .gw-btn-danger { padding:7px 13px; border-radius:8px; border:1px solid rgba(255,80,80,.4);
    background:rgba(255,80,80,.08); color:#ff8080; cursor:pointer; font-size:12px; font-weight:600; transition:all .2s; }
  .gw-btn-danger:hover { background:rgba(255,80,80,.2); }
  .gw-entry-list { display:flex; flex-direction:column; gap:3px; margin:8px 0 12px; max-height:200px; overflow-y:auto; }
  .gw-entry-row { display:flex; justify-content:space-between; align-items:center;
    padding:6px 10px; background:rgba(255,255,255,.04); border-radius:8px; font-size:13px; }
  .gw-entry-remove { background:none; border:none; color:rgba(255,80,80,.6); cursor:pointer;
    font-size:16px; padding:0 4px; line-height:1; }
  .gw-entry-remove:hover { color:#ff5050; }
  .gw-no-giveaway { text-align:center; padding:32px 16px; color:var(--dim); font-size:14px; }

  .user-btn { width:38px; height:38px; border-radius:50%;
    border:1.5px solid rgba(255,47,214,.7);
    background:linear-gradient(135deg,rgba(255,47,214,.25),rgba(157,92,255,.25));
    box-shadow:0 0 12px rgba(255,47,214,.35), inset 0 1px 0 rgba(255,255,255,.1);
    color:#ff2fd6; cursor:pointer;
    display:grid; place-items:center; flex:none; padding:0;
    transition:box-shadow .15s, transform .1s; }
  .user-btn:hover { box-shadow:0 0 20px rgba(255,47,214,.6), inset 0 1px 0 rgba(255,255,255,.15); }
  .user-btn:active { transform:scale(.93); }
  .user-drop { position:absolute; top:calc(100% + 10px); right:0; min-width:150px;
    background:rgba(12,6,26,.97); border:1px solid rgba(255,47,214,.35); border-radius:14px;
    padding:8px; backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
    z-index:400; box-shadow:0 14px 40px rgba(0,0,0,.7); display:none; }
  .user-drop.open { display:block; animation:fade .18s ease both; }
  .ud-name { font-size:12px; color:var(--dim); padding:5px 10px 9px;
    border-bottom:1px solid rgba(255,255,255,.07); margin-bottom:7px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .ud-item { display:block; padding:10px; border-radius:10px; font-size:13.5px;
    font-weight:700; color:var(--neon); text-decoration:none; text-align:center;
    background:rgba(255,47,214,.08); border:1px solid rgba(255,47,214,.25); }
  .ud-item:hover { background:rgba(255,47,214,.18); }

  /* ── Settings modal ───────────────────────────────────────── */
  .smodal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.7);
    backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
    z-index:1000; display:none; align-items:flex-start; justify-content:center;
    padding:20px 12px; overflow-y:auto; }
  .smodal-overlay.open { display:flex; animation:fade .2s ease both; }
  .smodal { background:rgba(12,6,26,.98); border:1px solid rgba(255,47,214,.3);
    border-radius:20px; width:100%; max-width:460px; padding:0;
    box-shadow:0 24px 60px rgba(0,0,0,.8); overflow:hidden; }
  .smodal-head { display:flex; align-items:center; justify-content:space-between;
    padding:18px 20px 14px; border-bottom:1px solid rgba(255,255,255,.07); }
  .smodal-head h2 { margin:0; font-size:16px; color:var(--neon); letter-spacing:.5px; }
  .smodal-close { background:none; border:none; color:var(--dim); font-size:20px;
    cursor:pointer; padding:0 4px; line-height:1; }
  .smodal-close:hover { color:#fff; }
  .stabs { display:flex; gap:6px; padding:14px 20px 0; border-bottom:1px solid rgba(255,255,255,.07); }
  .stab { background:none; border:none; border-bottom:2px solid transparent;
    color:var(--dim); font-size:13px; font-weight:700; cursor:pointer;
    padding:0 4px 10px; letter-spacing:.4px; }
  .stab.active { color:var(--neon); border-bottom-color:var(--neon); }
  .spanel { display:none; padding:20px; }
  .spanel.active { display:block; }
  .smodal-sect { margin-bottom:20px; }
  .smodal-sect-title { font-size:11px; color:var(--dim); text-transform:uppercase;
    letter-spacing:1px; margin:0 0 10px; }
  .pk-row { display:flex; align-items:center; justify-content:space-between;
    background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08);
    border-radius:10px; padding:10px 12px; margin-bottom:8px; }
  .pk-info { display:flex; flex-direction:column; gap:2px; }
  .pk-name { font-size:13.5px; font-weight:600; color:#fff; }
  .pk-date { font-size:11px; color:var(--dim); }
  .pk-del { background:rgba(255,60,60,.12); border:1px solid rgba(255,60,60,.3);
    color:#ff6060; border-radius:8px; padding:5px 10px; font-size:12px;
    font-weight:700; cursor:pointer; white-space:nowrap; }
  .pk-del:hover { background:rgba(255,60,60,.25); }
  .pk-empty { font-size:13px; color:var(--dim); text-align:center; padding:18px 0; }
  .smodal-btn { display:block; width:100%; padding:11px; border-radius:12px;
    background:rgba(255,47,214,.12); border:1px solid rgba(255,47,214,.35);
    color:var(--neon); font-size:13.5px; font-weight:700; cursor:pointer;
    text-align:center; margin-top:10px; }
  .smodal-btn:hover { background:rgba(255,47,214,.22); }
  .sfield { width:100%; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12);
    border-radius:10px; padding:10px 13px; color:#fff; font-size:14px;
    outline:none; box-sizing:border-box; margin-bottom:10px; }
  .sfield:focus { border-color:rgba(255,47,214,.6); }
  .sfield-label { font-size:12px; color:var(--dim); margin-bottom:5px; display:block; }
  .smsg { font-size:13px; border-radius:8px; padding:9px 12px; margin-bottom:10px;
    display:none; }
  .smsg.ok { background:rgba(0,220,120,.12); border:1px solid rgba(0,220,.5);
    color:#00dc78; display:block; }
  .smsg.err { background:rgba(255,60,60,.12); border:1px solid rgba(255,60,60,.4);
    color:#ff7070; display:block; }

  /* PSN inline link flow */
  .psn-steps { display:flex; align-items:center; gap:0; margin-bottom:18px; }
  .psn-step-dot { width:28px; height:28px; border-radius:50%; flex:none; display:grid;
    place-items:center; font-size:12px; font-weight:800; font-family:"Orbitron",sans-serif;
    background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.15); color:var(--dim);
    transition:background .25s, color .25s, border-color .25s, box-shadow .25s; }
  .psn-step-dot.active { background:linear-gradient(135deg,var(--cyan),var(--violet));
    border-color:transparent; color:#fff; box-shadow:0 0 12px rgba(34,230,255,.5); }
  .psn-step-dot.done { background:rgba(0,220,120,.2); border-color:rgba(0,220,120,.5);
    color:#00dc78; }
  .psn-step-line { flex:1; height:2px; background:rgba(255,255,255,.07); margin:0 4px; }
  .psn-step-block { margin-bottom:14px; padding:14px; border-radius:14px;
    border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.025);
    transition:opacity .25s, filter .25s; }
  .psn-step-block.locked { opacity:.38; filter:grayscale(.4); pointer-events:none; }
  .psn-step-label { font-weight:700; font-size:14px; margin-bottom:6px; color:var(--txt); }
  .psn-step-hint { font-size:12.5px; color:var(--dim); line-height:1.55; }
  .psn-token-preview { margin-top:10px; padding:9px 12px; border-radius:10px;
    background:rgba(34,230,255,.07); border:1px solid rgba(34,230,255,.2);
    font-size:12px; line-height:1.6; }

  /* ── Watch Party ────────────────────────────────────────────── */
  .wp-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    margin:8px 0 10px; }
  .wp-pill { display:inline-flex; align-items:center; gap:6px; font-size:12px;
    font-weight:700; padding:6px 12px; border-radius:999px; letter-spacing:.4px;
    background:rgba(140,255,43,.1); border:1px solid rgba(140,255,43,.35);
    color:var(--lime); }
  .wp-pill.off { background:rgba(255,255,255,.05); border-color:rgba(255,255,255,.14);
    color:var(--dim); }
  .wp-dot { width:7px; height:7px; border-radius:50%; background:currentColor;
    box-shadow:0 0 8px currentColor; animation:wpPulse 1.8s ease-in-out infinite; }
  @keyframes wpPulse { 50% { opacity:.35; } }
  /* presence orbs: name chip that becomes a live circular camera feed */
  .wp-orbs { display:flex; align-items:flex-start; gap:10px; margin-bottom:10px;
    padding:6px 2px 10px; overflow-x:auto; overflow-y:hidden;
    scroll-snap-type:x proximity; -webkit-overflow-scrolling:touch;
    scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.18) transparent; }
  .wp-orbs::-webkit-scrollbar { height:5px; }
  .wp-orbs::-webkit-scrollbar-track { background:transparent; }
  .wp-orbs::-webkit-scrollbar-thumb { background:rgba(255,255,255,.16);
    border-radius:3px; }
  .wp-orbs:empty { display:none; }
  .wp-orb { flex:0 0 auto; width:74px; scroll-snap-align:start; cursor:pointer;
    transition:width .26s cubic-bezier(.3,.8,.3,1); }
  .wp-orb-ring { position:relative; width:66px; height:66px; margin:0 auto 6px;
    box-sizing:border-box; padding:2.5px; border-radius:50%;
    background:conic-gradient(from 210deg, rgba(157,92,255,.85),
      rgba(34,230,255,.45), rgba(157,92,255,.85));
    transition:width .26s cubic-bezier(.3,.8,.3,1),
      height .26s cubic-bezier(.3,.8,.3,1), box-shadow .22s ease,
      background .22s ease, transform .18s ease; }
  .wp-orb.me .wp-orb-ring { background:conic-gradient(from 210deg,
    rgba(34,230,255,.95), rgba(255,47,214,.5), rgba(34,230,255,.95)); }
  .wp-orb:hover .wp-orb-ring { transform:translateY(-2px); }
  .wp-orb.talking .wp-orb-ring {
    background:conic-gradient(from 210deg, var(--lime), rgba(140,255,43,.3), var(--lime));
    box-shadow:0 0 0 3px rgba(140,255,43,.15), 0 0 18px rgba(140,255,43,.45);
    animation:wpTalk 1.15s ease-in-out infinite; }
  @keyframes wpTalk { 50% { box-shadow:0 0 0 6px rgba(140,255,43,.08),
    0 0 26px rgba(140,255,43,.62); } }
  .wp-orb-inner { position:relative; width:100%; height:100%; border-radius:50%;
    overflow:hidden; display:grid; place-items:center; background:#12121c; }
  .wp-orb-inner video { position:absolute; inset:0; width:100%; height:100%;
    object-fit:cover; display:block; background:#000; }
  /* mirror our own preview so it reads like a mirror, not a stranger */
  .wp-orb.me .wp-orb-inner video { transform:scaleX(-1); }
  .wp-orb-ini { font-family:"Rajdhani",sans-serif; font-weight:700; font-size:22px;
    letter-spacing:.5px; color:rgba(255,255,255,.9); user-select:none;
    transition:font-size .26s ease; }
  .wp-orb-badge { position:absolute; right:-1px; bottom:-1px; min-width:21px;
    height:21px; padding:0 3px; box-sizing:border-box; border-radius:999px;
    display:grid; place-items:center; font-size:10px; line-height:1;
    background:#15151f; border:2px solid #0b0b12; color:var(--dim); }
  .wp-orb.talking .wp-orb-badge { color:var(--lime);
    border-color:rgba(140,255,43,.35); }
  .wp-orb-name { font-size:11px; line-height:1.35; color:var(--dim);
    text-align:center; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; }
  .wp-orb.me .wp-orb-name { color:#c8fbff; font-weight:700; }
  .wp-orb.big { width:154px; }
  .wp-orb.big .wp-orb-ring { width:146px; height:146px; }
  .wp-orb.big .wp-orb-ini { font-size:46px; }
  .wp-orb.speaking { width:154px; }
  .wp-orb.speaking .wp-orb-ring { width:146px; height:146px; }
  .wp-orb.speaking .wp-orb-ini { font-size:46px; }
  @media (max-width:560px){
    .wp-orb { width:60px; }
    .wp-orb-ring { width:54px; height:54px; }
    .wp-orb-ini { font-size:18px; }
    .wp-orb-badge { min-width:18px; height:18px; font-size:9px; }
    .wp-orb.big { width:124px; }
    .wp-orb.big .wp-orb-ring { width:118px; height:118px; }
    .wp-orb.big .wp-orb-ini { font-size:38px; }
    .wp-orb.speaking { width:124px; }
    .wp-orb.speaking .wp-orb-ring { width:118px; height:118px; }
    .wp-orb.speaking .wp-orb-ini { font-size:38px; }
  }
  /* back-camera has no mirror */
  .wp-orb.me.no-mirror .wp-orb-inner video { transform:none !important; }
  /* fullscreen camera grid overlay */
  .wp-cam-fs { position:fixed; inset:0; z-index:9999; background:#06041a;
    display:none; flex-direction:column; }
  .wp-cam-fs.open { display:flex; }
  .wp-cam-fs-head { display:flex; align-items:center; gap:8px; padding:12px 16px;
    border-bottom:1px solid rgba(255,255,255,.07); flex-shrink:0; }
  .wp-cam-fs-title { font-size:14px; font-weight:700; color:#fff; flex:1; }
  /* Grid tiles — rectangular video panels, not circles */
  .wp-orbs-grid { flex:1; overflow-y:auto; display:grid; gap:10px; padding:12px;
    grid-template-columns:repeat(auto-fill,minmax(min(160px,45%),1fr));
    align-content:start; }
  .wp-orbs-grid .wp-orb { width:100%; }
  /* Make ring a square rounded-rect instead of a circle */
  .wp-orbs-grid .wp-orb-ring {
    width:100% !important; height:auto !important; aspect-ratio:1 !important;
    border-radius:14px !important; padding:3px !important;
    margin:0 0 6px !important; }
  /* Inner fills the ring using absolute positioning — avoids height:100% on auto parent */
  .wp-orbs-grid .wp-orb-inner {
    position:absolute !important; inset:3px !important;
    width:auto !important; height:auto !important;
    border-radius:11px !important; }
  .wp-orbs-grid .wp-orb-ini { font-size:clamp(32px,12vw,72px) !important; }
  /* Badge floats over the tile bottom-right */
  .wp-orbs-grid .wp-orb-badge {
    right:8px !important; bottom:8px !important;
    min-width:26px !important; height:26px !important; font-size:13px !important;
    background:rgba(0,0,0,.7) !important; border-color:transparent !important; }
  .wp-orbs-grid .wp-orb-name { font-size:13px !important; text-align:center; padding:0 4px; }
  /* Speaking glow works on rectangular tiles too */
  .wp-orbs-grid .wp-orb.talking .wp-orb-ring,
  .wp-orbs-grid .wp-orb.speaking .wp-orb-ring {
    box-shadow:0 0 0 3px rgba(140,255,43,.4),0 0 20px rgba(140,255,43,.25) !important; }
  .wp-cam-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
    margin-bottom:10px; }
  .wp-ptt { user-select:none; -webkit-user-select:none; }
  .wp-ptt.hot { background:rgba(255,60,60,.18);
    border-color:rgba(255,80,80,.55); color:#ff6060;
    box-shadow:0 0 16px rgba(255,60,60,.25); }
  .wp-cam-note { font-size:12px; color:var(--dim); line-height:1.5; }
  .wp-stage { position:relative; width:100%; aspect-ratio:16/9; border-radius:16px;
    overflow:hidden; background:#000; border:1px solid var(--line);
    box-shadow:0 18px 40px rgba(0,0,0,.5); }
  .wp-stage video, .wp-stage iframe, .wp-stage #wpYt { width:100%; height:100%;
    display:block; border:0; background:#000; }
  .wp-empty { position:absolute; inset:0; display:grid; place-items:center;
    text-align:center; padding:20px; font-size:13px; color:var(--dim);
    line-height:1.6; }
  .wp-row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  .wp-row .sfield { margin-bottom:0; flex:1; min-width:180px; }
  .wp-btn { padding:10px 15px; border-radius:12px; cursor:pointer; font-size:13px;
    font-weight:700; font-family:"Rajdhani",sans-serif; letter-spacing:.4px;
    background:rgba(255,47,214,.12); border:1px solid rgba(255,47,214,.35);
    color:var(--neon); flex:none; }
  .wp-btn:hover { background:rgba(255,47,214,.22); }
  .wp-btn.ghost { background:rgba(255,255,255,.04);
    border-color:rgba(255,255,255,.14); color:var(--dim); }
  .wp-btn:disabled { opacity:.45; cursor:default; }
  .wp-note { font-size:12px; color:var(--dim); margin:8px 0 0; line-height:1.6; }
  .wp-chat { margin-top:14px; border:1px solid var(--line); border-radius:16px;
    background:rgba(255,255,255,.02); overflow:hidden; }
  .wp-chat-log { max-height:240px; overflow-y:auto; padding:12px 14px;
    display:flex; flex-direction:column; gap:7px; }
  .wp-msg { font-size:13px; line-height:1.5; word-break:break-word; }
  .wp-msg .who { font-weight:700; color:var(--cyan); margin-right:5px; }
  .wp-msg.sys { color:var(--dim); font-style:italic; font-size:12px; }
  .wp-chat-in { display:flex; gap:8px; padding:10px 12px;
    border-top:1px solid var(--line); }
  .wp-chat-in input { flex:1; background:rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:9px 12px;
    color:#fff; font-size:13.5px; outline:none; }
  .wp-chat-in input:focus { border-color:rgba(255,47,214,.6); }
  .wp-err { font-size:13px; border-radius:12px; padding:10px 13px; margin:10px 0 0;
    background:rgba(255,60,60,.1); border:1px solid rgba(255,60,60,.35);
    color:#ff8f9f; display:none; }
  .wp-err.on { display:block; }

  /* ── Huddle (revamped) ──────────────────────────────────────────────────── */
  /* NOTE: do NOT set display here — .panel{display:none} must win when not active */
  #p-huddle { padding:0 !important; overflow:hidden; }
  #p-huddle.on { display:flex !important; flex-direction:column; }
  #huddlePre { height:100%; display:flex; align-items:center; justify-content:center; padding:16px; overflow-y:auto; }
  .hpj { display:flex; gap:20px; width:100%; max-width:620px; align-items:center; }
  .hpj-cam { flex:1; position:relative; background:#0a0a1a; border-radius:16px; overflow:hidden;
    aspect-ratio:4/3; min-width:0; border:1px solid rgba(255,255,255,.08); }
  .hpj-cam video { width:100%; height:100%; object-fit:cover; transform:scaleX(-1); display:block; }
  .hpj-cam-off { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    color:var(--dim); font-size:13px; flex-direction:column; gap:6px; }
  .hpj-side { flex:1; display:flex; flex-direction:column; gap:10px; min-width:0; }
  .hpj-title { font-size:20px; font-weight:800; color:#fff; font-family:"Orbitron",sans-serif; letter-spacing:1px; }
  .hpj-sub { font-size:12px; color:var(--dim); margin-top:-6px; }
  .hpj-devices { display:flex; flex-direction:column; gap:6px; }
  #huddleStage { display:flex; flex-direction:column; height:100%; }
  .hs-topbar { display:flex; align-items:center; gap:8px; padding:8px 12px;
    border-bottom:1px solid rgba(255,255,255,.06); flex-shrink:0; }
  .hs-room { font-size:13px; font-weight:700; color:#fff; font-family:"Orbitron",sans-serif; letter-spacing:.5px; }
  .hs-topbtn { background:none; border:1px solid rgba(255,255,255,.14); color:var(--dim);
    border-radius:8px; padding:5px 10px; font-size:12px; cursor:pointer;
    font-family:"Rajdhani",sans-serif; font-weight:700; transition:all .15s; white-space:nowrap; }
  .hs-topbtn:hover { color:#fff; border-color:rgba(255,255,255,.3); }
  .hs-topbtn.on { color:var(--cyan); border-color:rgba(34,230,255,.4); background:rgba(34,230,255,.08); }
  .hs-main { flex:1; display:flex; overflow:hidden; min-height:0; }
  .hs-spotlight-wrap { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }
  .hs-spotlight { flex:1; position:relative; background:#050510; overflow:hidden; min-height:0; }
  .hs-spotlight video { width:100%; height:100%; object-fit:contain; display:block; }
  .hs-spotlight.me video { transform:scaleX(-1); }
  .hs-spot-info { position:absolute; bottom:0; left:0; right:0; padding:28px 12px 10px;
    background:linear-gradient(0deg,rgba(0,0,0,.65),rgba(0,0,0,0));
    display:flex; align-items:flex-end; gap:6px; pointer-events:none; }
  .hs-spot-name { font-size:14px; font-weight:700; color:#fff; flex:1; }
  .hs-spot-badges { font-size:16px; }
  .hs-strip { height:88px; flex-shrink:0; display:flex; gap:6px; padding:6px 8px;
    overflow-x:auto; background:rgba(0,0,0,.35); border-top:1px solid rgba(255,255,255,.05); }
  .hs-strip::-webkit-scrollbar { height:3px; }
  .hs-strip::-webkit-scrollbar-thumb { background:rgba(255,255,255,.2); border-radius:2px; }
  .hs-strip-tile { width:116px; flex-shrink:0; position:relative; border-radius:10px;
    overflow:hidden; background:#0c0c1e; cursor:pointer;
    border:2px solid transparent; transition:border-color .15s; }
  .hs-strip-tile video { width:100%; height:100%; object-fit:cover; display:block; }
  .hs-strip-tile.me video { transform:scaleX(-1); }
  .hs-strip-tile.speaking { border-color:rgba(140,255,43,.7); }
  .hs-strip-tile.active { border-color:rgba(34,230,255,.7); }
  .hs-strip-name { position:absolute; bottom:0; left:0; right:0;
    padding:14px 5px 3px; background:linear-gradient(0deg,rgba(0,0,0,.7),transparent);
    font-size:10px; font-weight:700; color:#fff; text-align:center;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none; }
  .hs-grid { flex:1; display:grid; gap:6px; padding:8px; align-content:start; overflow-y:auto; }
  .hs-tile { position:relative; background:#0a0a1a; border-radius:12px; overflow:hidden;
    aspect-ratio:4/3; border:2px solid transparent; transition:border-color .15s; }
  .hs-tile video { width:100%; height:100%; object-fit:cover; display:block; background:#111; }
  .hs-tile.me video { transform:scaleX(-1); }
  .hs-tile.speaking { border-color:rgba(140,255,43,.75); }
  .hs-tile-info { position:absolute; bottom:0; left:0; right:0; padding:18px 8px 6px;
    background:linear-gradient(0deg,rgba(0,0,0,.7),rgba(0,0,0,0));
    display:flex; align-items:flex-end; gap:4px; pointer-events:none; }
  .hs-tile-name { font-size:11px; font-weight:700; color:#fff; flex:1;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hs-tile-badges { font-size:13px; flex-shrink:0; }
  .hs-controls { display:flex; align-items:center; justify-content:center; gap:10px;
    padding:10px 12px; border-top:1px solid rgba(255,255,255,.06); flex-shrink:0; }
  .hs-ctrl { width:46px; height:46px; border-radius:50%; border:1px solid rgba(255,255,255,.18);
    background:rgba(255,255,255,.06); color:#fff; font-size:18px; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    transition:background .15s, border-color .15s, transform .1s; flex-shrink:0; }
  .hs-ctrl:hover { background:rgba(255,255,255,.14); transform:scale(1.08); }
  .hs-ctrl.on { background:rgba(34,230,255,.15); border-color:rgba(34,230,255,.5); }
  .hs-ctrl.off { background:rgba(255,50,50,.12); border-color:rgba(255,50,50,.4); }
  .hs-ctrl.active { background:rgba(34,230,255,.12); border-color:rgba(34,230,255,.4); }
  .hs-ctrl.danger { width:auto; border-radius:22px; padding:0 18px; font-size:13px;
    font-weight:700; font-family:"Rajdhani",sans-serif; letter-spacing:.3px;
    background:rgba(255,40,40,.15); border-color:rgba(255,40,40,.4); color:#ff5555; }
  .hs-ctrl.danger:hover { background:rgba(255,40,40,.28); transform:none; }
  .hs-ai { width:260px; flex-shrink:0; display:flex; flex-direction:column;
    border-left:1px solid rgba(255,255,255,.07); overflow:hidden; }
  .hs-ai-head { display:flex; align-items:center; justify-content:space-between;
    padding:8px 12px; border-bottom:1px solid rgba(255,255,255,.05);
    font-size:13px; font-weight:700; color:#fff; flex-shrink:0; }
  .hs-ai-log { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; min-height:0; }
  .hs-ai-msg { padding:7px 9px; border-radius:10px; font-size:12px; line-height:1.5;
    white-space:pre-wrap; word-break:break-word; }
  .hs-ai-msg.user { background:rgba(34,230,255,.1); border:1px solid rgba(34,230,255,.2);
    align-self:flex-end; max-width:90%; }
  .hs-ai-msg.assistant { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); }
  .hs-ai-msg.sys { color:var(--dim); font-size:11px; text-align:center; background:none; border:none; padding:2px 0; }
  .hs-ai-in { display:flex; gap:6px; padding:8px; border-top:1px solid rgba(255,255,255,.05); flex-shrink:0; }
  @media (max-width:600px) {
    .hpj { flex-direction:column; }
    .hpj-cam { width:100%; max-width:260px; align-self:center; }
    .hs-ai { width:100%; border-left:none; border-top:1px solid rgba(255,255,255,.07); max-height:180px; }
    .hs-main { flex-direction:column; }
    .hs-ctrl { width:40px; height:40px; font-size:16px; }
    .hs-strip { height:70px; }
    .hs-strip-tile { width:88px; }
    .hs-controls { gap:8px; padding:8px; }
  }
</style></head>
<body>

<!-- Settings modal -->
<div class="smodal-overlay" id="settingsOverlay" onclick="if(event.target===this)closeSettings()">
  <div class="smodal">
    <div class="smodal-head">
      <h2>⚙️ Account Settings</h2>
      <button class="smodal-close" onclick="closeSettings()">✕</button>
    </div>
    <div class="stabs">
      <button class="stab active" data-tab="passkeys" onclick="switchTab('passkeys')">🔑 Passkeys</button>
      <button class="stab" data-tab="security" onclick="switchTab('security')">🔒 Security</button>
      <button class="stab" data-tab="psn" onclick="switchTab('psn')">🎮 PSN</button>
      <button class="stab" data-tab="users" id="tabUsersBtn" onclick="switchTab('users')" style="display:none">👥 Users</button>
    </div>

    <!-- Passkeys tab -->
    <div class="spanel active" id="tab-passkeys">
      <div class="smodal-sect">
        <p class="smodal-sect-title">Your saved passkeys</p>
        <div id="pkList"><div class="pk-empty">Loading…</div></div>
      </div>
      <button class="smodal-btn" onclick="addPasskeyFromSettings()">＋ Add new passkey</button>
      <div class="smsg" id="pkMsg"></div>
    </div>

    <!-- Security tab -->
    <div class="spanel" id="tab-security">
      <div class="smodal-sect">
        <p class="smodal-sect-title">Change password</p>
        <div class="smsg" id="pwMsg"></div>
        <label class="sfield-label">Current password</label>
        <input class="sfield" type="password" id="pwCur" autocomplete="current-password" placeholder="••••••••">
        <label class="sfield-label">New password</label>
        <input class="sfield" type="password" id="pwNew" autocomplete="new-password" placeholder="••••••••">
        <label class="sfield-label">Confirm new password</label>
        <input class="sfield" type="password" id="pwConf" autocomplete="new-password" placeholder="••••••••">
        <button class="smodal-btn" onclick="changePassword()">Update password</button>
      </div>
    </div>

    <!-- PSN tab -->
    <div class="spanel" id="tab-psn">
      <div class="smodal-sect">
        <p class="smodal-sect-title">PlayStation account</p>
        <div id="psnStatus" style="font-size:13.5px;color:var(--dim);margin-bottom:16px;line-height:1.6">Loading…</div>
      </div>

      <!-- Inline link flow (shown when not linked, or expanded via re-link) -->
      <div id="psnLinkFlow" style="display:none">
        <!-- Step progress dots -->
        <div class="psn-steps" id="psnSteps">
          <div class="psn-step-dot active" id="psdot-1">1</div>
          <div class="psn-step-line"></div>
          <div class="psn-step-dot" id="psdot-2">2</div>
          <div class="psn-step-line"></div>
          <div class="psn-step-dot" id="psdot-3">3</div>
        </div>

        <!-- Step 1 -->
        <div class="psn-step-block" id="psnS1">
          <div class="psn-step-label">Sign in to PlayStation</div>
          <div class="psn-step-hint">Open PlayStation.com and make sure you're logged into your account. If you already are, skip this.</div>
          <a class="smodal-btn" href="https://www.playstation.com/" target="_blank" rel="noopener"
             onclick="psnAdvance(2)" style="text-decoration:none;margin-top:10px;display:block">
            Open PlayStation.com ↗
          </a>
          <button class="smodal-btn" style="background:none;border:1px solid rgba(255,255,255,.12);color:var(--dim);margin-top:8px" onclick="psnAdvance(2)">Already logged in — skip</button>
        </div>

        <!-- Step 2 -->
        <div class="psn-step-block locked" id="psnS2">
          <div class="psn-step-label">Get your token</div>
          <div class="psn-step-hint">This link opens a Sony page. It looks like a blank page with a short code — that's your token. Copy everything you see.</div>
          <div class="psn-token-preview"><span style="color:#9d8fc4">You'll see:</span> <code style="color:#22e6ff">{{"npsso":"AbCd1234..."}}</code></div>
          <a class="smodal-btn" href="https://ca.account.sony.com/api/v1/ssocookie" target="_blank" rel="noopener"
             onclick="psnAdvance(3)" style="text-decoration:none;margin-top:10px;display:block">
            Open my token page ↗
          </a>
        </div>

        <!-- Step 3 -->
        <div class="psn-step-block locked" id="psnS3">
          <div class="psn-step-label">Paste &amp; link</div>
          <div class="psn-step-hint">Paste whatever the token page showed — the whole thing or just the token value, we'll figure it out.</div>
          <textarea id="psnTokenInput" placeholder='{"npsso":"AbCd1234..."} — paste it all'
            oninput="psnAdvance(3)" rows="3"
            style="width:100%;margin-top:10px;padding:11px 13px;border-radius:12px;
              border:1px solid rgba(34,230,255,.28);background:rgba(6,4,18,.8);
              color:var(--txt);font-size:13px;font-family:ui-monospace,monospace;
              resize:none;box-sizing:border-box;line-height:1.5"></textarea>
          <button class="smodal-btn" style="background:none;border:1px solid rgba(255,255,255,.12);color:var(--dim);margin-top:6px" onclick="psnPasteClipboard()">📋 Paste from clipboard</button>
          <div id="psnLinkMsg" class="smsg" style="display:none;margin-top:10px"></div>
          <button class="smodal-btn" id="psnLinkBtn" onclick="linkPsn()" style="margin-top:8px">🔗 Link my account</button>
        </div>
      </div>

      <button id="psnRelinkBtn" class="smodal-btn" style="display:none;background:none;border:1px solid rgba(255,255,255,.12);color:var(--dim);margin-top:4px" onclick="togglePsnRelink()">Re-link PSN account</button>
    </div>

    <!-- Users tab (admin only) -->
    <div class="spanel" id="tab-users">
      <div class="smodal-sect">
        <p class="smodal-sect-title">User management</p>
        <div id="adminUsersList"><span style="color:var(--dim)">Loading…</span></div>
      </div>
    </div>
  </div>
</div>

<div class="announce empty" id="livecount"></div>
<div class="wrap">
  <div class="top">
    <div class="logo" style="background-image:url('/footer-avatar.png');background-size:90%;background-position:center center;background-repeat:no-repeat;"></div>
    <div><h1>CRCMZ APP</h1><p class="tag">Yes. We have one.</p></div>
    <div style="margin-left:auto">
      <div style="position:relative">__USER__</div>
    </div>
  </div>

  <div class="nav-wrap" id="navWrap">
    <button class="nav-trigger" id="navTrigger" onclick="toggleNav(event)">
      <span class="nav-t-icon" id="navActiveIcon">🎮</span>
      <div style="flex:1;min-width:0">
        <div class="nav-t-label" id="navActiveLabel">Squad</div>
      </div>
      <svg class="nav-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="nav-dropdown" id="navDropdown">
      <button class="nav-item on" data-p="squad" data-icon="🎮" data-label="Squad" onclick="tab(this)"><span class="nav-i-icon">🎮</span><span>Squad</span></button>
      <button class="nav-item" data-p="pipeline" data-icon="🎬" data-label="Clips" onclick="tab(this)"><span class="nav-i-icon">🎬</span><span>Clips</span></button>
      <button class="nav-item" data-p="slap" data-icon="🎵" data-label="Slap" onclick="tab(this);loadSlap()"><span class="nav-i-icon">🎵</span><span>Slap</span></button>
      <button class="nav-item" data-p="wa" data-icon="💬" data-label="WhatsApp" onclick="tab(this);loadWa()"><span class="nav-i-icon">💬</span><span>WhatsApp</span></button>
      <button class="nav-item" data-p="giveaway" data-icon="🎁" data-label="Giveaway" onclick="tab(this);loadGiveaway()"><span class="nav-i-icon">🎁</span><span>Giveaway</span></button>
      <button class="nav-item" data-p="watch" data-icon="🍿" data-label="Watch" onclick="tab(this);loadWatch()"><span class="nav-i-icon">🍿</span><span>Watch</span></button>
      <button class="nav-item" data-p="huddle" data-icon="🎥" data-label="Huddle" onclick="tab(this);loadHuddle()"><span class="nav-i-icon">🎥</span><span>Huddle</span></button>
    </div>
  </div>
  <div class="panel" id="p-squad">
    <div id="together"></div>
    <div class="hype-wrap" id="hypeMeter">
      <div class="hype-head">
        <div>
          <div class="hype-title">Today's Hype</div>
          <div class="hype-label" id="hypeLabel">…</div>
        </div>
        <div class="hype-count"><span id="hypeCount">—</span> msgs</div>
      </div>
      <div class="hype-track"><div class="hype-fill dead" id="hypeFill"></div></div>
    </div>
    <div class="statgrid" id="statgrid"></div>
    <div class="card" id="squad"><div class="spin">Loading squad…</div></div>
    <p class="pip-title" style="margin:18px 0 8px">🏆 Ranks</p>
    <div class="card" id="lb"><div class="spin">Loading ranks…</div></div>
  </div>
  <div class="panel" id="p-lb" style="display:none"></div>
  <div class="panel" id="p-pipeline"><div id="pipeline-inner"><div class="spin">Loading pipeline…</div></div></div>
  <div class="panel" id="p-slap">
    <div id="slap-stats" class="statgrid" style="margin-bottom:10px"></div>
    <div id="slap-vibe" class="card" style="display:none;margin-bottom:10px;padding:12px 16px;font-size:13px;color:var(--dim);font-style:italic;text-align:center"></div>
    <div id="slap-digest" class="card" style="display:none;margin-bottom:10px;padding:10px 14px;font-size:13px;color:var(--dim)"></div>
    <div id="slap-inner"><div class="spin">Loading Slapshare…</div></div>
  </div>
  <div class="panel" id="p-wa">
    <div class="wa-top">
      <div class="pip-title" style="margin:8px 0 4px">Professional Goopers</div>
      <div class="wa-range" id="waRange">
        <button class="wa-rb on" data-r="all_time" onclick="waSetRange(this)">All Time</button>
        <button class="wa-rb" data-r="this_year" onclick="waSetRange(this)">This Year</button>
        <button class="wa-rb" data-r="this_month" onclick="waSetRange(this)">This Month</button>
        <button class="wa-rb" data-r="prev_month" onclick="waSetRange(this)">Prev Month</button>
        <button class="wa-rb" data-r="custom" onclick="waSetRange(this)">Custom</button>
      </div>
      <div id="waCustomRange" style="display:none;gap:8px;margin-top:8px;flex-wrap:wrap">
        <input type="date" id="waStart" class="wa-date-in" onchange="waReload()">
        <span style="color:var(--dim);line-height:38px">→</span>
        <input type="date" id="waEnd" class="wa-date-in" onchange="waReload()">
      </div>
    </div>
    <div id="wa-stats" class="statgrid" style="margin-bottom:10px"></div>
    <div id="wa-inner"><div class="spin">Loading WhatsApp analytics…</div></div>
    <div id="wa-import-section" style="display:none;margin-top:18px">
      <div style="border-top:1px solid var(--line);padding-top:14px">
        <p class="pip-title">Import WhatsApp History</p>
        <div class="card" style="padding:14px 16px">
          <p style="font-size:12.5px;color:var(--dim);margin:0 0 12px">Upload a WhatsApp export (.txt or .zip) to import historical messages.</p>
          <input type="file" id="waImportFile" accept=".txt,.zip" style="display:none" onchange="waDoImport()">
          <button class="smodal-btn" style="margin-top:0" onclick="document.getElementById('waImportFile').click()">📂 Choose Export File</button>
          <div id="waImportMsg" class="smsg" style="display:none;margin-top:8px"></div>
        </div>
      </div>
    </div>
  </div>
  <div class="panel" id="p-giveaway">
    <div id="giveaway-inner"><div class="spin">Loading giveaway…</div></div>
  </div>
  <div class="panel" id="p-watch">
    <div class="wp-head">
      <div class="pip-title" style="margin:0;flex:1">🍿 Watch Party</div>
      <span class="wp-pill off" id="wpPresence"><span class="wp-dot"></span><span id="wpPresenceTxt">connecting…</span></span>
    </div>
    <div class="wp-orbs" id="wpOrbs"></div>
    <div class="wp-cam-bar">
      <button class="wp-btn ghost" id="wpCamBtn" onclick="wpToggleCam()">📷 Turn on camera</button>
      <button class="wp-btn ghost wp-ptt" id="wpPttBtn" style="display:none">🎤 Mute</button>
      <button class="wp-btn ghost" id="wpFsBtn" onclick="wpFsOpen()" title="Camera grid fullscreen">⛶ Cams</button>
      <span class="wp-cam-note" id="wpCamNote"></span>
    </div>
    <div class="wp-stage" id="wpStage">
      <video id="wpVideo" playsinline controls style="display:none"></video>
      <div id="wpYt" style="display:none"></div>
      <div class="wp-empty" id="wpEmpty">Nothing playing yet.<br>Paste a video link below to start the party.</div>
    </div>
    <div class="wp-row">
      <input class="sfield" id="wpUrl" type="text" autocomplete="off" spellcheck="false"
        placeholder="https://… video link or YouTube URL"
        onkeydown="if(event.key==='Enter')wpSetVideo()">
      <button class="wp-btn" id="wpSetBtn" onclick="wpSetVideo()">▶ Play for everyone</button>
      <button class="wp-btn ghost" onclick="wpSetVideo('')">Clear</button>
      <button class="wp-btn ghost" onclick="wpEditNickname()">✏️ Name</button>
      <button class="wp-btn ghost" id="wpRallyBtn" onclick="wpRally()">📣 Rally</button>
    </div>
    <div class="wp-err" id="wpErr"></div>
    <p class="wp-note" id="wpNote">Everyone in this room sees the same thing — play, pause and seek are shared.</p>
    <div class="wp-chat">
      <div class="wp-chat-log" id="wpChatLog"></div>
      <div class="wp-chat-in">
        <input id="wpChatIn" type="text" maxlength="500" autocomplete="off"
          placeholder="Say something…" onkeydown="if(event.key==='Enter')wpSendChat()">
        <button class="wp-btn" onclick="wpSendChat()">➤</button>
      </div>
    </div>
  </div>

  <!-- ── Huddle panel ── -->
  <div class="panel" id="p-huddle">
    <!-- Pre-join -->
    <div id="huddlePre" style="height:100%;display:flex;flex-direction:column">
      <div class="hpj">
        <div class="hpj-cam">
          <video id="huddleLocalPreview" autoplay muted playsinline></video>
          <div class="hpj-cam-off" id="huddlePreviewOff" style="display:none">
            <span style="font-size:28px">📷</span>
            <span>Camera off</span>
          </div>
        </div>
        <div class="hpj-side">
          <div class="hpj-title">🎥 Huddle</div>
          <div class="hpj-sub">Video calls with your squad &amp; AI</div>
          <input class="sfield" id="huddleRoom" value="crcmz" placeholder="Room name" style="font-size:15px;text-align:center">
          <div class="hpj-devices">
            <select class="sfield" id="huddleMicSel" style="font-size:12px;padding:8px 10px"></select>
            <select class="sfield" id="huddleCamSel" style="font-size:12px;padding:8px 10px"></select>
          </div>
          <button class="wp-btn" id="huddleJoinBtn" onclick="huddleJoin()">🎥 Join</button>
          <div id="huddleJoinMsg" style="font-size:12px;color:var(--dim);text-align:center;min-height:16px"></div>
        </div>
      </div>
    </div>
    <!-- In-call stage -->
    <div id="huddleStage" style="display:none;flex-direction:column;height:100%">
      <div class="hs-topbar">
        <span class="hs-room">🎥 <span id="huddleRoomName">crcmz</span></span>
        <span id="huddleCount" style="font-size:12px;color:var(--dim);margin-left:6px"></span>
        <div style="display:flex;gap:6px;margin-left:auto;align-items:center">
          <button class="hs-topbtn" id="huddleLayoutBtn" onclick="huddleToggleLayout()" title="Toggle layout">⊞ Grid</button>
          <button class="hs-topbtn" id="huddleAiToggle" onclick="huddleToggleAi()">💬 AI</button>
        </div>
      </div>
      <div class="hs-main" id="huddleMain">
        <!-- Spotlight + filmstrip (default) -->
        <div class="hs-spotlight-wrap" id="huddleSpotlightWrap">
          <div class="hs-spotlight" id="huddleSpotlight">
            <video id="huddleSpotVid" autoplay playsinline muted></video>
            <audio id="huddleSpotAud" autoplay style="display:none"></audio>
            <div class="hs-spot-info">
              <span class="hs-spot-name" id="huddleSpotName">You</span>
              <span class="hs-spot-badges" id="huddleSpotBadges"></span>
            </div>
          </div>
          <div class="hs-strip" id="huddleStrip"></div>
        </div>
        <!-- Grid mode (hidden by default) -->
        <div class="hs-grid" id="huddleGrid" style="display:none"></div>
        <!-- AI panel -->
        <div class="hs-ai" id="huddleAiPanel" style="display:none">
          <div class="hs-ai-head">
            <span>💬 AI</span>
            <span id="huddleAiStatus" style="font-size:11px;color:var(--dim)"></span>
          </div>
          <div class="hs-ai-log" id="huddleAiLog"></div>
          <div class="huddle-transcript-box" id="huddleTranscriptBox" style="display:none">
            <div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Live Transcript</div>
            <div id="huddleTranscriptText" style="font-size:12px;color:rgba(255,255,255,.7);max-height:60px;overflow-y:auto"></div>
          </div>
          <div style="display:flex;gap:6px;padding:6px 8px;border-top:1px solid rgba(255,255,255,.05);flex-shrink:0">
            <button class="wp-btn ghost" onclick="huddleToggleTranscript()" style="flex:1;font-size:11px;padding:7px">🎙 Transcript</button>
            <button class="wp-btn ghost" onclick="huddleMeetingNotes()" style="flex:1;font-size:11px;padding:7px">📋 Notes</button>
          </div>
          <div class="hs-ai-in">
            <input class="sfield" id="huddleAiInput" placeholder="Ask AI…"
              onkeydown="if(event.key==='Enter')huddleAiSend()" style="margin:0;flex:1;font-size:13px">
            <button class="wp-btn ghost" onclick="huddleAiSend()" style="flex-shrink:0;padding:10px 12px">➤</button>
          </div>
        </div>
      </div>
      <div class="hs-controls">
        <button class="hs-ctrl on" id="huddleMicBtn" onclick="huddleToggleMic()" title="Mute">🎤</button>
        <button class="hs-ctrl on" id="huddleCamBtn" onclick="huddleToggleCam()" title="Camera off">📷</button>
        <button class="hs-ctrl" id="huddleShareBtn" onclick="huddleToggleShare()" title="Share screen">🖥</button>
        <button class="hs-ctrl" id="huddleBlurBtn" onclick="huddleToggleBlur()" title="Background blur">🌫</button>
        <button class="hs-ctrl danger" onclick="huddleLeave()">🔴 Leave</button>
      </div>
    </div>
  </div>
</div>

<!-- Watch Party fullscreen camera grid overlay -->
<div class="wp-cam-fs" id="wpCamFs">
  <div class="wp-cam-fs-head">
    <span class="wp-cam-fs-title">📷 Camera Grid</span>
    <button class="wp-btn ghost" id="wpFlipBtn" onclick="wpFlipCam()" style="display:none">🔄 Flip</button>
    <button class="wp-btn ghost" onclick="wpFsClose()" style="margin-left:auto">✕ Close</button>
  </div>
  <div class="wp-orbs-grid" id="wpOrbsFs"></div>
</div>

<div class="board-wrap" id="boardWrap">
  <div class="board-hdr">
    <button class="board-toggle-btn" onclick="toggleBoard()">
      <span class="chev" id="chev">▾</span><span>Chat Board</span>
    </button>
    <button class="board-fs-btn" id="boardFsBtn" onclick="toggleBoardFs()" title="Fullscreen">⛶</button>
  </div>
  <div class="board-hint" id="boardHint">tap title to minimize · hold in fullscreen to organize</div>
  <div class="board" id="board"></div>
  <div class="quick">
    <input id="quick" type="text" placeholder="Send a quick message to the squad…"
      maxlength="200" autocomplete="off"
      onkeydown="if(event.key==='Enter')sendQuick()">
    <button class="qsend" onclick="sendQuick()" aria-label="Send">➤</button>
  </div>
  <button class="board-done-btn" id="boardDoneBtn" onclick="exitOrganize()">✓ Done Organizing</button>
</div>

<!-- Watch Party mini-bar: visible on any page while still connected to the watch room -->
<div class="wp-minibar" id="wpMiniBar">
  <div class="wp-minibar-inner">
    <button class="wp-minibar-back" onclick="wpMiniGoWatch()">🍿 Watch</button>
    <div class="wp-minibar-info">
      <span class="wp-minibar-label">Watch Party</span>
      <span class="wp-minibar-sub" id="wpMiniSub">connected</span>
    </div>
    <button class="wp-minibar-mute" id="wpMiniMute" onclick="wpToggleMute()" style="display:none">🎤 Live</button>
  </div>
</div>

<div class="toast" id="toast"></div>
<script>
const SOUNDBOARD = __SOUNDBOARD__;
const MY_PSN_ID = __PSN_ID__;
let MY_AVATAR = null, MOD_AVATAR = null;
const $ = id => document.getElementById(id);
const esc = s => (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const toast = m => { const t=$('toast'); t.textContent=m; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2000); };

// ── Chat Board state ─────────────────────────────────────────────────────────
let BUTTONS = SOUNDBOARD.slice();
let _isFullscreen = false, _organizeMode = false;

function renderButtons(){
  $('board').innerHTML = BUTTONS.map((b,i)=>
    '<button class="snd '+(b.cls||'c1')+(b.custom?' custom':'')+'" data-i="'+i+'" '+
    (_organizeMode ? 'style="touch-action:none"' : 'onclick="fire(this)"')+'>'+esc(b.label)+'</button>'
  ).join('') +
    (_organizeMode ? '' : '<button class="snd add" onclick="openCustom()">＋ Custom</button>');
  if(_organizeMode) bindDrag();
  else bindLongPress();
  syncBoardHeight();
}

// ── Collapse / expand ────────────────────────────────────────────────────────
function syncBoardHeight(){
  const bar = document.querySelector('.board-wrap');
  const mini = $('wpMiniBar');
  const miniH = (mini && mini.classList.contains('on')) ? (mini.offsetHeight || 0) : 0;
  document.body.style.setProperty('--minibar-h', miniH + 'px');
  if(bar) document.body.style.setProperty('--board-h', (_isFullscreen ? miniH : bar.offsetHeight + miniH + 16) + 'px');
}
function toggleBoard(){
  if(_isFullscreen) return;
  const w=$('boardWrap'); w.classList.toggle('collapsed');
  try{ localStorage.setItem('sb_collapsed', w.classList.contains('collapsed')?'1':'0'); }catch(e){}
  setTimeout(syncBoardHeight,300);
}
if(localStorage.getItem('sb_collapsed')==='1') $('boardWrap').classList.add('collapsed');
window.addEventListener('resize', syncBoardHeight);

// ── Fullscreen ───────────────────────────────────────────────────────────────
function toggleBoardFs(){
  _isFullscreen = !_isFullscreen;
  const w=$('boardWrap');
  w.classList.toggle('fullscreen', _isFullscreen);
  w.classList.toggle('collapsed', false);
  $('boardFsBtn').textContent = _isFullscreen ? '✕' : '⛶';
  if(!_isFullscreen && _organizeMode) exitOrganize();
  document.body.style.overflow = _isFullscreen ? 'hidden' : '';
  syncBoardHeight();
}

// ── Organize mode (fullscreen only, long-press any button) ───────────────────
function enterOrganize(){
  if(!_isFullscreen) return;
  _organizeMode = true;
  $('boardWrap').classList.add('organizing');
  $('boardDoneBtn').style.display = 'block';
  renderButtons();
  if(navigator.vibrate) navigator.vibrate([20,40,20]);
}
function exitOrganize(){
  _organizeMode = false;
  $('boardWrap').classList.remove('organizing');
  $('boardDoneBtn').style.display = 'none';
  _saveOrder();
  renderButtons();
}
function _saveOrder(){
  try{ localStorage.setItem('cb_order', JSON.stringify(BUTTONS.map(b=>b.label))); }catch(e){}
}

// ── Drag-to-reorder ──────────────────────────────────────────────────────────
// Global handlers (added once) so pointer capture stays reliable on mobile.
let _drag = null, _dragRaf = null;
document.addEventListener('pointermove', ev=>{
  if(!_drag) return;
  ev.preventDefault();
  const x = ev.clientX - _drag.ox, y = ev.clientY - _drag.oy;
  if(_dragRaf) cancelAnimationFrame(_dragRaf);
  _dragRaf = requestAnimationFrame(()=>{
    if(!_drag) return;
    _drag.clone.style.left = x+'px';
    _drag.clone.style.top  = y+'px';
    const btns=[...document.querySelectorAll('.snd:not(.drag-ghost)')];
    let ci=-1, cd=Infinity;
    btns.forEach((b,i)=>{
      const r=b.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
      const d=Math.hypot(ev.clientX-cx, ev.clientY-cy);
      if(d<cd){cd=d;ci=parseInt(b.dataset.i);}
    });
    if(ci!==_drag.cur){
      document.querySelectorAll('.snd').forEach(b=>b.classList.toggle('drop-target',parseInt(b.dataset.i)===ci&&ci!==_drag.idx));
      _drag.cur=ci;
    }
  });
},{passive:false});
document.addEventListener('pointerup', ()=>{
  if(!_drag) return;
  if(_dragRaf) cancelAnimationFrame(_dragRaf);
  _drag.clone.remove();
  document.querySelectorAll('.snd').forEach(b=>b.classList.remove('drag-ghost','drop-target'));
  const from=_drag.idx, to=_drag.cur;
  _drag=null;
  if(to>=0 && to!==from){
    const [item]=BUTTONS.splice(from,1);
    BUTTONS.splice(to,0,item);
    renderButtons();
  }
});
function bindDrag(){
  document.querySelectorAll('.snd').forEach((el,idx)=>{
    el.addEventListener('pointerdown', ev=>{
      ev.preventDefault();
      const r=el.getBoundingClientRect();
      const clone=el.cloneNode(true);
      clone.style.cssText='position:fixed;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;z-index:999;opacity:.88;pointer-events:none;border-radius:13px;box-shadow:0 8px 32px rgba(0,0,0,.6);will-change:left,top';
      document.body.appendChild(clone);
      el.classList.add('drag-ghost');
      _drag={idx, clone, ox:ev.clientX-r.left, oy:ev.clientY-r.top, cur:idx};
    });
  });
}

// ── Long-press: delete custom (normal) or enter organize (fullscreen) ────────
let _lpTimer=null, _lpFired=false;
function bindLongPress(){
  document.querySelectorAll('.snd.custom').forEach(el=>{
    const i=el.dataset.i;
    const start=(ev)=>{
      if(_isFullscreen){ _lpFired=false; _lpTimer=setTimeout(()=>{ _lpFired=true; enterOrganize(); },600); return; }
      _lpFired=false; el.classList.add('holding');
      _lpTimer=setTimeout(()=>{ _lpFired=true; el.classList.remove('holding');
        if(navigator.vibrate) navigator.vibrate(30); delBtn(ev,i); },600);
    };
    const cancel=()=>{ clearTimeout(_lpTimer); el.classList.remove('holding'); };
    el.addEventListener('touchstart',start,{passive:true});
    el.addEventListener('touchend',cancel); el.addEventListener('touchmove',cancel);
    el.addEventListener('mousedown',start);
    el.addEventListener('mouseup',cancel); el.addEventListener('mouseleave',cancel);
  });
  // In fullscreen, long-press on non-custom buttons also enters organize mode
  if(_isFullscreen){
    document.querySelectorAll('.snd:not(.custom):not(.add)').forEach(el=>{
      const start=()=>{ _lpFired=false; _lpTimer=setTimeout(()=>{ _lpFired=true; enterOrganize(); },600); };
      const cancel=()=>clearTimeout(_lpTimer);
      el.addEventListener('touchstart',start,{passive:true}); el.addEventListener('touchend',cancel); el.addEventListener('touchmove',cancel);
      el.addEventListener('mousedown',start); el.addEventListener('mouseup',cancel); el.addEventListener('mouseleave',cancel);
    });
  }
}

renderButtons();
// ── Sent flyout: avatar card that floats up and fades away ───────────────────
function showSentFly(avatarUrl, senderName, msgText, originEl){
  const el = document.createElement('div');
  el.className = 'sent-fly';
  // Horizontally centered; vertically anchored to the button that was pressed
  el.style.left = '50%';
  if(originEl){
    const r = originEl.getBoundingClientRect();
    el.style.top = (r.top + r.height/2 - 30) + 'px';
  } else {
    el.style.bottom = 'calc(var(--board-h,220px) + 12px)';
  }
  const avHtml = avatarUrl
    ? '<img class="sf-av" src="'+avatarUrl+'" onerror="this.parentNode.innerHTML=\'<div class=sf-av-fallback>🎮</div>\'">'
    : '<div class="sf-av-fallback">🎮</div>';
  el.innerHTML = avHtml +
    '<div class="sf-info">'+
      '<div class="sf-name">'+esc(senderName)+'</div>'+
      '<div class="sf-msg">'+esc(msgText.length>48?msgText.slice(0,47)+'…':msgText)+'</div>'+
    '</div>'+
    '<span class="sf-tick">✓</span>';
  document.body.appendChild(el);
  el.addEventListener('animationend', ()=>el.remove());
}

async function fire(el){
  if(_lpFired){ _lpFired=false; return; }  // a long-press just deleted; don't send
  const b = BUTTONS[el.dataset.i];
  el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'),500);
  try {
    let r;
    if(b.path){ r = await fetch(b.path,{method:'POST'}); }
    else { r = await fetch('/v2/squad',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:b.msg})}); }
    if(r.ok) showSentFly(MOD_AVATAR, 'CRCMZ MOD', b.label||b.msg||'', el);
    else toast('Failed ('+r.status+')');
  } catch(e){ toast('Network error'); }
}
// Ad-hoc one-off message -> sent as-is to the group (not saved, no AI).
async function sendQuick(){
  const inp = $('quick'), btn = document.querySelector('.qsend');
  const msg = (inp.value||'').trim();
  if(!msg) return;
  btn.disabled = true;
  try {
    const r = await fetch('/v2/send',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:msg})});
    if(r.ok){
      inp.value='';
      const name = MY_PSN_ID || 'You';
      showSentFly(MY_AVATAR, name, msg, btn);
    } else if(r.status===429){ toast('Slow down a sec ⏳'); }
    else toast('Failed ('+r.status+')');
  } catch(e){ toast('Network error'); }
  btn.disabled = false;
}
async function openCustom(){
  const text = prompt("What should the button say? The AI will add the flavor 🔥");
  if(!text || !text.trim()) return;
  toast("✨ AI is cooking…");
  try {
    const r = await fetch('/api/soundboard',{method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:text.trim()})});
    if(!r.ok){ toast('Failed ('+r.status+')'); return; }
    const d = await r.json();
    await refreshBoard();
    toast('Added: '+d.flavored.slice(0,40));
  } catch(e){ toast('Network error'); }
}
async function delBtn(ev, i){
  if(ev && ev.preventDefault) ev.preventDefault();
  const b = BUTTONS[i];
  if(!b || !b.custom) return false;
  if(!confirm('Remove this custom button?\n\n'+b.msg)) return false;
  try {
    await fetch('/api/soundboard/delete',{method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:b.msg})});
    await refreshBoard(); toast('Removed');
  } catch(e){ toast('Network error'); }
  return false;
}
async function refreshBoard(){
  try { const d = await (await fetch('/api/soundboard')).json();
    BUTTONS = d.buttons || BUTTONS; renderButtons();
  } catch(e){}
}

function toggleNav(e){
  e && e.stopPropagation();
  const trigger=$('navTrigger'), dd=$('navDropdown');
  const opening = !dd.classList.contains('open');
  trigger.classList.toggle('open', opening);
  dd.classList.toggle('open', opening);
}
function closeNav(){
  $('navTrigger') && $('navTrigger').classList.remove('open');
  $('navDropdown') && $('navDropdown').classList.remove('open');
}
document.addEventListener('click', e=>{
  if(!e.target.closest('#navWrap')) closeNav();
});
function tab(btn, skipHash){
  document.querySelectorAll('.nav-item').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');
  $('p-'+btn.dataset.p).classList.add('on');
  // update trigger label
  const icon=$('navActiveIcon'), lbl=$('navActiveLabel');
  if(icon) icon.textContent = btn.dataset.icon||'';
  if(lbl)  lbl.textContent  = btn.dataset.label||'';
  // update URL so the view is shareable and survives auth redirects
  if(!skipHash) history.replaceState(null,'','?p='+btn.dataset.p);
  // close dropdown with a slight delay so user sees selection
  setTimeout(closeNav, 120);
}
// restore tab from URL on load — ?p=page survives auth redirects; #hash is legacy fallback
(function(){
  const p = new URLSearchParams(location.search).get('p') || location.hash.replace('#','') || 'squad';
  const btn = document.querySelector('.nav-item[data-p="'+p+'"]') ||
              document.querySelector('.nav-item[data-p="squad"]');
  if(btn){
    tab(btn, true);
    if(p==='slap')    loadSlap();
    if(p==='wa')      loadWa();
    if(p==='giveaway') loadGiveaway();
    if(p==='watch'){
      // Defer one tick so the page settles before opening a WebSocket.
      // On mobile, connecting synchronously during page parse causes
      // transient failures that never trigger connect_error.
      setTimeout(loadWatch, 0);
    }
  }
})();
function fmtLast(iso){ if(!iso) return 'offline';
  const s=(Date.now()-new Date(iso))/1000;
  if(s<3600) return Math.max(1,Math.floor(s/60))+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago'; }

let SQUAD=[];
function trophyCells(m){
  if(m.trophy_level==null) return '';
  return '<div class="troph"><div class="lvl"><div class="v">'+m.trophy_level+'</div><div class="k">LVL</div></div>'+
    '<div class="tcount"><span class="p">'+(m.platinum||0)+' ⚪</span><br>'+(m.gold||0)+' 🥇</div></div>';
}
function renderSquad(){
  const el=$('squad');
  if(!SQUAD.length){ el.innerHTML='<div class="empty">Nobody linked yet.<br>'+
    '<a class="link-cta" href="/portal">Link your account</a> to show up here.</div>'; return; }
  el.innerHTML = SQUAD.map(m=>{
    const name=esc(m.online_id||m.mm_username||'Unknown');
    const av=m.avatar||'';
    // Show the game icon for both currently-playing and last-played (offline).
    const gsrc=(m.game_icon)||(m.recent_game_icon)||'';
    const gi=gsrc?'<img class="gicon" src="'+esc(gsrc)+'">':'';
    const avImg='<div class="avwrap">'+(av?'<img class="av" src="'+esc(av)+'">':'<div class="av"></div>')+gi+'</div>';
    // Game-centric: no online/offline. If they recently switched to a
    // whitelisted game they're "ON" it (glowing); otherwise show their last
    // game, dimmed. No timestamps.
    const g = m.game || m.recent_game;
    let st, cls='';
    if(m.playing && g){ st='<span class="game-badge">🎮 On <b>'+esc(g)+'</b></span>'; cls='playing'; }
    else if(g){ st='<span class="lastgame">'+esc(g)+'</span>'; }
    else { st='<span class="lastgame">no recent game</span>'; }
    const mm_val=m.mm_username||m.online_id||null;
    const mm=mm_val?'<span class="mm">@'+esc(mm_val)+'</span>':'';
    return '<div class="row '+cls+'">'+avImg+'<div class="who"><div class="name"><span class="dot"></span>'+name+mm+'</div>'+
      '<div class="state">'+st+'</div></div>'+trophyCells(m)+'</div>';
  }).join('');
}
function renderBoard(){
  const el=$('lb');
  const ranked=SQUAD.filter(m=>m.trophy_level!=null)
    .sort((a,b)=>(b.trophy_level-a.trophy_level)||((b.platinum||0)-(a.platinum||0)));
  if(!ranked.length){ el.innerHTML='<div class="empty">No trophy data yet.</div>'; return; }
  const max=ranked[0].trophy_level||1;
  el.innerHTML = ranked.map((m,i)=>{
    const name=esc(m.online_id||m.mm_username||'Unknown'); const av=m.avatar||'';
    const rk=i<3?['🥇','🥈','🥉'][i]:'#'+(i+1);
    return '<div class="lb-row"><div class="rank">'+rk+'</div>'+
      (av?'<img class="av" style="width:42px;height:42px" src="'+esc(av)+'">':'<div class="av" style="width:42px;height:42px"></div>')+
      '<div class="who"><div class="name">'+name+'</div>'+
      '<div class="state">Lvl '+m.trophy_level+' · '+(m.platinum||0)+' plat · '+(m.gold||0)+'🥇 '+(m.silver||0)+'🥈 '+(m.bronze||0)+'🥉</div>'+
      '<div class="bar"><i style="width:'+Math.round((m.trophy_level/max)*100)+'%"></i></div></div></div>';
  }).join('');
}
// "Playing together": if 2+ people are on the SAME game right now, hype it +
// let you rally the group into it with one tap.
function renderTogether(){
  const el=$('together'); el.innerHTML='';
  const counts={};
  SQUAD.filter(m=>m.playing && m.game).forEach(m=>{
    (counts[m.game]=counts[m.game]||{n:0,icon:m.game_icon,who:[]});
    counts[m.game].n++; counts[m.game].who.push(m.online_id||m.mm_username);
  });
  const top=Object.entries(counts).filter(([g,d])=>d.n>=2)
    .sort((a,b)=>b[1].n-a[1].n)[0];
  if(!top) return;
  const [game,d]=top;
  const icon=d.icon?'<img class="gicon2" src="'+esc(d.icon)+'">':'';
  el.innerHTML='<div class="together" onclick="rally('+JSON.stringify(game).replace(/"/g,'&quot;')+')">'+
    icon+'<div class="t-main"><div class="t-title">🔥 '+d.n+' in '+esc(game)+'</div>'+
    '<div class="t-sub">'+esc(d.who.join(', '))+' — squad\'s live!</div></div>'+
    '<div class="t-go">Rally ▶</div></div>';
}
async function rally(game){
  try {
    const r=await fetch('/v2/squad',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:'🎮🔥 Squad\'s on '+game+'! Who else is hopping in? 💥'})});
    toast(r.ok?'Rallied! 🎮':'Failed');
  } catch(e){ toast('Network error'); }
}
function renderStats(){
  const el=$('statgrid');
  const plat=SQUAD.reduce((a,m)=>a+(m.platinum||0),0);
  const lvls=SQUAD.filter(m=>m.trophy_level!=null).map(m=>m.trophy_level);
  const topLvl=lvls.length?Math.max(...lvls):0;
  // most common recent game across the squad
  const g={}; SQUAD.forEach(m=>{ const n=m.game||m.recent_game; if(n) g[n]=(g[n]||0)+1; });
  const fav=Object.entries(g).sort((a,b)=>b[1]-a[1])[0];
  el.innerHTML=
    '<div class="stile"><div class="sv">'+plat+'</div><div class="sl">⚪ Platinums</div></div>'+
    '<div class="stile"><div class="sv">'+topLvl+'</div><div class="sl">🏆 Top Level</div></div>'+
    '<div class="stile"><div class="sv" style="font-size:13px">'+(fav?esc(fav[0]).slice(0,14):'—')+'</div><div class="sl">🎯 Squad Fav</div></div>';
}
async function loadSquad(){
  try {
    const {squad=[]}=await (await fetch('/api/squad')).json();
    SQUAD=squad;
    // Resolve avatars for the sent-flyout animation.
    if (MY_PSN_ID) {
      const me = squad.find(m=>(m.online_id||'').toLowerCase()===MY_PSN_ID.toLowerCase());
      if (me?.avatar) MY_AVATAR = me.avatar;
    }
    const mod = squad.find(m=>(m.online_id||'').toLowerCase()==='crcmz-mod');
    if (mod?.avatar) MOD_AVATAR = mod.avatar;
    const playing=squad.filter(m=>m.playing).length;
    const lc = $('livecount');
    if(playing){ lc.innerHTML='<b>'+playing+'</b> in a game right now 🎮'; lc.classList.remove('empty'); }
    else { lc.innerHTML=''; lc.classList.add('empty'); }
    // On-a-game members float to the top.
    squad.sort((a,b)=> (b.playing?1:0)-(a.playing?1:0));
    renderTogether(); renderStats(); renderSquad(); renderBoard();
  } catch(e){ $('squad').innerHTML='<div class="empty">Couldn\'t load squad.</div>'; }
}
loadSquad(); setInterval(loadSquad, 30000);

// ── Hype Meter ───────────────────────────────────────────────────────────────
async function loadHype(){
  try {
    const d = await (await fetch('/api/hype')).json();
    $('hypeLabel').textContent = d.label || '—';
    $('hypeCount').textContent = d.count ?? '—';
    const fill = $('hypeFill');
    fill.className = 'hype-fill ' + (d.level || 'cold');
    // defer width so transition fires after class change
    requestAnimationFrame(()=>{ fill.style.width = (d.pct||0) + '%'; });
  } catch(e){}
}
loadHype(); setInterval(loadHype, 60000);

// ── Pipeline / Montage status ──────────────────────────────────────────────
function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor(Date.now()/1000 - ts);
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function fmtCountdown(ts) {
  const s = Math.floor(ts - Date.now()/1000);
  if (s <= 0) return 'imminent';
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600);
  return d + 'd ' + h + 'h away';
}
function dotClass(svc) {
  if (!svc) return 'dot-down';
  if (svc.status === 'ok') return 'dot-ok';
  if (svc.status === 'error') return 'dot-warn';
  return 'dot-down';
}
function svcLabel(svc) {
  if (!svc || svc.status === 'down') return 'unreachable';
  return svc.status === 'ok' ? (svc.ms != null ? svc.ms+'ms' : 'ok') : 'error';
}
async function loadPipeline() {
  try {
    const d = await (await fetch('/api/pipeline-status')).json();
    const sv = d.services || {};
    const lm = d.last_montage;
    const monthLabel = d.next_build_month || '';
    $('pipeline-inner').innerHTML = `
<div class="pip-section">
  <p class="pip-title">Services</p>
  <div class="svc-row"><span class="svc-dot ${dotClass(sv.psn_messenger)}"></span>
    <span class="svc-name">PSN Messenger</span><span class="svc-meta">${svcLabel(sv.psn_messenger)}</span></div>
  <div class="svc-row"><span class="svc-dot ${dotClass(sv.psn_montage)}"></span>
    <span class="svc-name">Montage Engine</span><span class="svc-meta">${svcLabel(sv.psn_montage)}</span></div>
  <div class="svc-row"><span class="svc-dot ${dotClass(sv.wa_bridge)}"></span>
    <span class="svc-name">WhatsApp Bridge</span><span class="svc-meta">${svcLabel(sv.wa_bridge)}</span></div>
</div>
<div class="pip-section">
  <p class="pip-title">This Month — ${monthLabel}</p>
  <div class="big-stat">
    <div class="bstat"><div class="bv">${d.clips_this_month ?? 0}</div><div class="bl">Clips Captured</div></div>
    <div class="bstat"><div class="bv">${fmtCountdown(d.next_build_ts)}</div><div class="bl">Until Build</div></div>
  </div>
  ${d.last_clip_at ? `<p class="last-clip-note">Last clip: <b>${fmtAgo(d.last_clip_at)}</b> from <b>${esc(d.last_clip_sender||'')}</b></p>` : '<p class="last-clip-note">No clips captured yet this month</p>'}
</div>
<div class="pip-section">
  <p class="pip-title">Next Auto-Build</p>
  <div class="pip-build">
    <div class="pb-label">Scheduled</div>
    <div class="pb-date">${d.next_build_label || '—'}</div>
    <div class="pb-countdown">${fmtCountdown(d.next_build_ts)} · auto-send to Goopers</div>
  </div>
</div>
${lm ? `<div class="pip-section">
  <p class="pip-title">Last Montage</p>
  <div class="last-montage">
    <div class="lm-row"><span class="lm-key">Version</span><span class="lm-val">v${lm.version} · ${lm.year}-${String(lm.month).padStart(2,'0')}</span></div>
    <div class="lm-row"><span class="lm-key">Clips</span><span class="lm-val">${lm.clips} included</span></div>
    <div class="lm-row"><span class="lm-key">Duration</span><span class="lm-val">${lm.duration}s</span></div>
    <div class="lm-row"><span class="lm-key">Sent to group</span><span class="lm-val"><span class="sent-badge ${lm.sent?'yes':'no'}">${lm.sent?'✓ Sent':'Not sent'}</span></span></div>
  </div>
</div>` : ''}
${(d.clips||[]).length ? `<div class="pip-section">
  <p class="pip-title">Clips This Month (${(d.clips||[]).length})</p>
  <div class="clip-list">
  ${(d.clips||[]).map(c => {
    const statusDot = c.included === true ? '<span class="cdot cdot-in">✓</span>'
      : c.included === false ? '<span class="cdot cdot-ex">✕</span>'
      : '<span class="cdot cdot-pend">·</span>';
    const reasonTxt = c.reason ? `<span class="creason">${esc(c.reason.replace('_',' '))}</span>` : '';
    return `<div class="clip-row">${statusDot}<span class="csender">${esc(c.sender)}</span><span class="cdur">${c.duration}s</span>${reasonTxt}<span class="cage">${fmtAgo(c.at)}</span></div>`;
  }).join('')}
  </div>
</div>` : '<p class="last-clip-note" style="margin-top:8px">No clips captured this month yet</p>'}`;
  } catch(e) {
    $('pipeline-inner').innerHTML = '<div class="card"><div class="empty">Could not load pipeline status.</div></div>';
  }
}
loadPipeline();
setInterval(loadPipeline, 30000);

// ── Slapshare full dashboard ──────────────────────────────────────────────────
const SLAP_BASE = 'https://slap.qureshi.io/api/v1/dashboard';
let _slapLoaded = false;
const SLAP_NAMES = {moiz:'moiz',themoosecompany:'moose',shahraiz:'shahraiz',
  zubair221b:'zubair',nooramin40:'noor',deception:'deception',asamad89:'asamad'};
function slapName(u){ return SLAP_NAMES[u]||u; }
function slapAgo(d){
  if(!d) return '';
  const s=Math.floor((Date.now()-new Date(d))/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function slapPlat(p){ return {spotify:'💚',apple_music:'🍎',youtube:'▶️'}[p]||'🎵'; }

async function loadSlap(){
  if(_slapLoaded) return;
  _slapLoaded = true;
  try {
    const [statsR,lbR,recentR,hotR,genreR,tlR,artR,achR,hipR,strR,perR,hofR,hmR] = await Promise.all([
      fetch(SLAP_BASE+'/stats').then(r=>r.json()),
      fetch(SLAP_BASE+'/leaderboard').then(r=>r.json()),
      fetch(SLAP_BASE+'/recent?limit=30').then(r=>r.json()),
      fetch(SLAP_BASE+'/hot').then(r=>r.json()),
      fetch(SLAP_BASE+'/genres').then(r=>r.json()),
      fetch(SLAP_BASE+'/timeline').then(r=>r.json()),
      fetch(SLAP_BASE+'/artists?limit=10').then(r=>r.json()),
      fetch(SLAP_BASE+'/achievements').then(r=>r.json()),
      fetch(SLAP_BASE+'/hipster').then(r=>r.json()),
      fetch(SLAP_BASE+'/streaks').then(r=>r.json()),
      fetch(SLAP_BASE+'/personalities').then(r=>r.json()),
      fetch(SLAP_BASE+'/hall-of-fame').then(r=>r.json()),
      fetch(SLAP_BASE+'/heatmap').then(r=>r.json()),
    ]);

    const stats      = statsR||{};
    const lb         = lbR.entries||[];
    const recent     = (recentR.items||[]).slice(0,30);
    const hot        = (hotR.items||hotR.hot||[]).slice(0,6);
    const genres     = (genreR.genres||[]).slice(0,8);
    const timeline   = (tlR.entries||[]).slice(-20);
    const artists    = (artR.artists||[]).slice(0,10);
    const achieves   = achR.achievements||[];
    const hipsters   = hipR.entries||[];
    const streaks    = strR.entries||[];
    const persons    = perR.cards||[];
    const hof        = hofR.entries||[];
    const heatmap    = hmR||{};

    // Stats bar
    const topLb = lb[0];
    $('slap-stats').innerHTML =
      `<div class="stile"><div class="sv">${stats.total_songs??'—'}</div><div class="sl">🎵 Tracks</div></div>`+
      `<div class="stile"><div class="sv">${stats.total_contributors??'—'}</div><div class="sl">👥 Squad</div></div>`+
      `<div class="stile"><div class="sv" style="font-size:11px">${stats.top_artist?esc(stats.top_artist).slice(0,12):'—'}</div><div class="sl">🎤 Top Artist</div></div>`+
      `<div class="stile"><div class="sv">${stats.this_week_additions??'—'}</div><div class="sl">📅 This Week</div></div>`;

    let html = '';

    // 1. The Throne
    if(topLb){
      html += `<div class="pip-section">
  <p class="pip-title" style="text-align:center">👑 The Throne</p>
  <div class="card" style="text-align:center;padding:18px 12px">
    <div style="font-size:36px;margin-bottom:6px">👑</div>
    <div style="font-family:'Orbitron',sans-serif;font-size:20px;color:${topLb.color||'var(--gold)'};">${esc(slapName(topLb.username))}</div>
    <div style="font-size:30px;font-family:'Orbitron',sans-serif;color:var(--gold);margin:4px 0">${topLb.song_count}</div>
    <div style="font-size:11px;color:var(--dim)">slaps — reigning champion</div>
  </div>
</div>`;
    }

    // 2. Hot Right Now
    if(hot.length){
      const hotCards = hot.map(t=>`<div style="flex-shrink:0;width:170px;background:rgba(255,115,22,.07);border:1px solid rgba(255,115,22,.3);border-radius:12px;padding:12px">
      <div style="font-size:20px;margin-bottom:6px">🎵</div>
      <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((t.title||'').slice(0,22))}</div>
      <div style="font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.artist||'')}</div>
      <div style="margin-top:6px;font-size:10px;color:var(--gold)">${esc(slapName(t.username||''))}</div>
      <div style="font-size:9px;color:var(--dim)">${slapAgo(t.created_at)}</div>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🔥 Hot Right Now <span style="font-size:10px;color:var(--dim)">last 24h</span></p>
  <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px">${hotCards}</div>
</div>`;
    }

    // 3. Full Leaderboard
    const lbRows = lb.length ? lb.map((e,i)=>{
      const medal = i===0?'👑':i===1?'🥈':i===2?'🥉':'#'+(i+1);
      const bar = lb[0].song_count?Math.round((e.song_count/lb[0].song_count)*100):0;
      return `<div class="lb-row">
      <div class="rank">${medal}</div>
      <div class="who" style="flex:1">
        <div class="name" style="color:${e.color||'var(--txt)'}">${esc(slapName(e.username))}</div>
        <div class="bar"><i style="width:${bar}%;background:${e.color||'var(--neon)'}"></i></div>
      </div>
      <div style="font-family:'Orbitron',sans-serif;font-size:13px;color:${e.color||'var(--cyan)'};min-width:36px;text-align:right">${e.song_count}</div>
    </div>`;
    }).join('') : '<div class="empty">No data</div>';
    html += `<div class="pip-section">
  <p class="pip-title">🏆 Leaderboard</p>
  <div class="card" style="padding:4px 12px">${lbRows}</div>
</div>`;

    // 4. Streak Tracker
    if(streaks.length){
      const stRows = streaks.map(s=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,.04)">
      <div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Orbitron',sans-serif;font-size:11px;font-weight:700;background:${s.color||'var(--neon)'}22;color:${s.color||'var(--neon)'};">${s.longest_streak||0}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:${s.color||'var(--txt)'}">${esc(slapName(s.username))}</div>
        <div style="font-size:10px;color:var(--dim)">Best: ${s.longest_streak||0}d${s.is_active?' · 🔥 Active: '+(s.current_streak||0)+'d':''}</div>
      </div>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🔥 Streak Tracker</p>
  <div class="card" style="padding:4px 12px">${stRows}</div>
</div>`;
    }

    // 5. Taste DNA / Head-to-Head
    const userOpts = lb.map(e=>`<option value="${esc(e.username)}">${esc(slapName(e.username))}</option>`).join('');
    html += `<div class="pip-section">
  <p class="pip-title">🧬 Taste DNA — Head to Head</p>
  <div class="card" style="padding:14px 16px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <select id="slap-h2h-u1" onchange="slapH2H()" style="background:rgba(255,255,255,.06);border:1px solid rgba(34,230,255,.3);color:var(--txt);border-radius:8px;padding:6px 10px;font-size:12px;flex:1"><option value="">User 1</option>${userOpts}</select>
      <span style="font-size:16px">⚔️</span>
      <select id="slap-h2h-u2" onchange="slapH2H()" style="background:rgba(255,255,255,.06);border:1px solid rgba(34,230,255,.3);color:var(--txt);border-radius:8px;padding:6px 10px;font-size:12px;flex:1"><option value="">User 2</option>${userOpts}</select>
    </div>
    <div id="slap-h2h-out" style="color:var(--dim);font-size:12px;text-align:center;padding:8px 0">Select two users to compare</div>
  </div>
</div>`;

    // 6. AI Recommendations
    const recBtns = lb.slice(0,7).map(e=>`<button onclick="slapRec('${esc(e.username)}')" id="slap-rb-${esc(e.username)}" style="padding:5px 10px;border-radius:20px;border:1px solid rgba(255,255,255,.15);background:transparent;color:var(--dim);font-size:11px;cursor:pointer;font-family:'Rajdhani',sans-serif">${esc(slapName(e.username))}</button>`).join('');
    html += `<div class="pip-section">
  <p class="pip-title">🤖 AI Recommendations <span style="font-size:10px;color:var(--dim)">powered by Claude</span></p>
  <div class="card" style="padding:12px 16px">
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">${recBtns}</div>
    <div id="slap-rec-out" style="color:var(--dim);font-size:12px;text-align:center">Pick a user for AI recommendations</div>
  </div>
</div>`;

    // 7. Timeline (pure CSS bars)
    if(timeline.length){
      const tlMax = Math.max(...timeline.map(t=>t.count),1);
      const tlBars = timeline.map(t=>{
        const h = Math.round((t.count/tlMax)*60);
        return `<div title="${esc(t.date)}: ${t.count}" style="display:flex;flex-direction:column;align-items:center;gap:2px;cursor:default">
        <div style="width:14px;background:linear-gradient(to top,var(--violet),var(--neon));border-radius:3px 3px 0 0;height:${h}px;min-height:${t.count?2:0}px;opacity:.85"></div>
        <div style="font-size:8px;color:var(--dim);writing-mode:vertical-rl;transform:rotate(180deg);max-height:30px;overflow:hidden">${esc((t.date||'').slice(5))}</div>
      </div>`;
      }).join('');
      html += `<div class="pip-section">
  <p class="pip-title">📈 Submissions Over Time</p>
  <div class="card" style="padding:12px 16px;overflow-x:auto">
    <div style="display:flex;align-items:flex-end;gap:4px;min-height:80px;padding-bottom:34px">${tlBars}</div>
  </div>
</div>`;
    }

    // 8. Platform Breakdown
    if(genres.length){
      const gMax = Math.max(...genres.map(g=>g.count),1);
      const gClrs = ['var(--neon)','var(--cyan)','var(--violet)','var(--gold)','var(--lime)','#ec4899','#ef4444','#10b981'];
      const gRows = genres.map((g,i)=>`<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${esc(g.name)}</span><span style="color:var(--dim)">${g.count}</span></div>
      <div style="background:rgba(255,255,255,.06);border-radius:4px;height:6px;overflow:hidden"><div style="height:100%;width:${Math.round((g.count/gMax)*100)}%;background:${gClrs[i%gClrs.length]};border-radius:4px"></div></div>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🍩 Platform Breakdown</p>
  <div class="card" style="padding:12px 16px">${gRows}</div>
</div>`;
    }

    // 9. Activity Heatmap (pure HTML grid)
    {
      const cells = heatmap.cells||[];
      const hMax = heatmap.max_count||1;
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const lookup = {};
      cells.forEach(c=>{ lookup[c.day+'-'+c.hour]=c.count; });
      const hmRows = days.map((d,di)=>{
        const cols = Array.from({length:24},(_,h)=>{
          const cnt = lookup[di+'-'+h]||0;
          const bg = cnt?`rgba(157,92,255,${(0.15+Math.min(cnt/hMax,1)*0.75).toFixed(2)})`:'rgba(255,255,255,.04)';
          return `<div title="${d} ${h}:00 — ${cnt} songs" style="width:14px;height:14px;border-radius:3px;background:${bg};flex-shrink:0"></div>`;
        }).join('');
        return `<div style="display:flex;align-items:center;gap:3px;margin-bottom:3px"><div style="width:26px;font-size:9px;color:var(--dim);text-align:right;flex-shrink:0">${d}</div>${cols}</div>`;
      }).join('');
      const hmLbls = Array.from({length:8},(_,i)=>`<div style="flex:1;font-size:8px;color:var(--dim);text-align:center">${i*3}h</div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">📊 Activity Heatmap <span style="font-size:10px;color:var(--dim)">hour × day</span></p>
  <div class="card" style="padding:12px 16px;overflow-x:auto">
    <div style="min-width:400px">
      <div style="display:flex;margin-left:29px;margin-bottom:4px">${hmLbls}</div>
      ${hmRows}
    </div>
  </div>
</div>`;
    }

    // 10. Top Artists
    if(artists.length){
      const aMax = artists[0].count||1;
      const aRows = artists.map((a,i)=>`<div style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid rgba(255,255,255,.04)">
      <span style="font-family:'Orbitron',sans-serif;font-size:10px;color:var(--dim);width:18px;text-align:right;flex-shrink:0">${i+1}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</div>
        <div style="height:4px;background:rgba(255,255,255,.06);border-radius:2px;margin-top:4px;overflow:hidden"><div style="height:100%;width:${Math.round((a.count/aMax)*100)}%;background:linear-gradient(90deg,var(--violet),var(--cyan));border-radius:2px"></div></div>
      </div>
      <span style="font-family:'Orbitron',sans-serif;font-size:12px;color:var(--violet);flex-shrink:0">${a.count}</span>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🎤 Top Artists</p>
  <div class="card" style="padding:4px 12px">${aRows}</div>
</div>`;
    }

    // 11. Achievements
    if(achieves.length){
      const achHtml = achieves.map(a=>`<div title="${esc(a.description||'')}${a.unlocked?' — '+(a.unlocked_by||[]).join(', '):'  — Locked'}" style="border-radius:10px;padding:10px 8px;text-align:center;background:${a.unlocked?'rgba(255,255,255,.05)':'rgba(0,0,0,.3)'};border:1px solid ${a.unlocked?'rgba(157,92,255,.35)':'rgba(255,255,255,.05)'};opacity:${a.unlocked?'1':'.4'}">
      <div style="font-size:22px;filter:${a.unlocked?'none':'grayscale(1)'}">${a.emoji||'🎖️'}</div>
      <div style="font-size:10px;font-weight:600;color:${a.unlocked?'var(--txt)':'var(--dim)'};margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</div>
      <div style="font-size:9px;color:var(--dim);margin-top:2px">${a.unlocked?(a.unlocked_by||[]).join(', '):'🔒'}</div>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🏅 Achievements</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:8px">${achHtml}</div>
</div>`;
    }

    // 12. Hipster Index
    if(hipsters.length){
      const hipRows = hipsters.map((h,i)=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,.04)">
      <span style="font-size:18px">${i===0?'🎩':i===1?'🕶️':'🎧'}</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:${h.color||'var(--txt)'}">${esc(slapName(h.username))}</div>
        <div style="font-size:10px;color:var(--dim)">${h.unique_artists} unique artists</div>
      </div>
      <div style="text-align:right">
        <div style="font-family:'Orbitron',sans-serif;font-size:14px;color:${(h.hipster_score||0)<=2?'var(--violet)':(h.hipster_score||0)<=3?'var(--cyan)':'var(--dim)'}">${(h.hipster_score||0).toFixed(1)}</div>
        <div style="font-size:9px;color:var(--dim)">score</div>
      </div>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🎩 Hipster Index <span style="font-size:10px;color:var(--dim)">lower = more obscure</span></p>
  <div class="card" style="padding:4px 12px">${hipRows}</div>
</div>`;
    }

    // 13. Personality Cards
    if(persons.length){
      const pCards = persons.map(p=>`<div style="border-radius:10px;padding:12px;border:1px solid ${p.color||'var(--neon)'}33;background:linear-gradient(135deg,${p.color||'var(--neon)'}11,transparent)">
      <div style="font-size:12px;font-weight:700;color:${p.color||'var(--txt)'};margin-bottom:4px">${esc(slapName(p.username))}</div>
      <div style="font-size:13px;font-weight:600">${esc(p.personality||'')}</div>
      <div style="font-size:11px;color:var(--dim);margin-top:4px">${esc(p.description||'')}</div>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🎭 Personality Cards</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${pCards}</div>
</div>`;
    }

    // 14. Hall of Fame
    if(hof.length){
      const hofCards = hof.map(f=>`<div style="background:linear-gradient(135deg,rgba(255,210,74,.07),rgba(255,210,74,.02));border:1px solid rgba(255,210,74,.25);border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:26px;margin-bottom:6px">${f.emoji||'🏆'}</div>
      <div style="font-size:11px;font-weight:700;color:var(--gold)">${esc(f.title||'')}</div>
      <div style="font-size:10px;color:var(--dim);margin-top:4px">${esc(f.description||'')}</div>
      <div style="font-size:13px;color:var(--txt);margin-top:6px;font-weight:600">${esc(f.value||'')}</div>
    </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title" style="text-align:center">🏛️ Hall of Fame</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px">${hofCards}</div>
</div>`;
    }

    // 15. Recent Activity Feed
    const recentRows = recent.length ? recent.slice(0,15).map(t=>`<div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,.04)">
      <span style="font-size:14px;flex-shrink:0">${slapPlat(t.source_platform)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((t.title||'').slice(0,32))}</div>
        <div style="font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.artist||'')}${t.album?' · '+esc(t.album):''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <span style="font-size:10px;padding:2px 6px;border-radius:10px;background:${t.color||'var(--neon)'}22;color:${t.color||'var(--neon)'}">${esc(slapName(t.username||''))}</span>
        <div style="font-size:9px;color:var(--dim);margin-top:2px">${slapAgo(t.created_at)}</div>
      </div>
    </div>`).join('') : '<div class="empty" style="padding:12px">No recent tracks</div>';
    html += `<div class="pip-section">
  <p class="pip-title" style="display:flex;align-items:center;justify-content:space-between">
    <span>📜 Recent Activity</span>
    <a href="https://slap.qureshi.io/dashboard" target="_blank" rel="noopener" style="font-size:10px;color:var(--cyan);text-decoration:none;opacity:.7">Full dashboard ↗</a>
  </p>
  <div class="card" style="padding:4px 12px">${recentRows}</div>
</div>`;

    $('slap-inner').innerHTML = html;

    // Non-blocking: AI vibe check
    fetch(SLAP_BASE+'/ai/vibe-check').then(r=>r.json()).then(d=>{
      if(d.vibe&&!d.vibe.includes('unavailable')){
        const el=$('slap-vibe');
        el.style.display='block';
        el.innerHTML=`<span style="font-size:18px">${d.mood_emoji||'✨'}</span> <strong style="color:var(--neon)">${esc(d.vibe)}</strong>`+
          (d.description?`<div style="margin-top:4px;font-size:12px">${esc(d.description)}</div>`:'');
      }
    }).catch(()=>{});

    // Non-blocking: weekly digest
    fetch(SLAP_BASE+'/ai/digest').then(r=>r.json()).then(d=>{
      if(d.digest&&!d.digest.includes('unavailable')){
        const el=$('slap-digest');
        el.style.display='block';
        const hi=(d.highlights||[]).map(h=>`<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;background:rgba(157,92,255,.1);color:var(--violet);border:1px solid rgba(157,92,255,.2);margin:2px">${esc(h)}</span>`).join('');
        el.innerHTML=`<div style="display:flex;gap:8px;align-items:flex-start"><span style="font-size:16px">📰</span><div><div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Weekly Digest</div><div style="font-size:13px;line-height:1.5">${esc(d.digest)}</div>${hi?`<div style="margin-top:6px">${hi}</div>`:''}</div></div>`;
      }
    }).catch(()=>{});

    // Non-blocking: scrobble/listening stats
    fetch(SLAP_BASE+'/listening').then(r=>r.json()).then(d=>{
      if(!d.enabled||(!(d.top_artists||[]).length&&!(d.top_tracks||[]).length)) return;
      const aH=(d.top_artists||[]).slice(0,5).map((a,i)=>`<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)"><span style="font-size:10px;color:var(--dim);width:14px">${i+1}</span><span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</span><span style="font-size:10px;color:var(--violet)">${a.scrobbles}×</span></div>`).join('');
      const tH=(d.top_tracks||[]).slice(0,5).map((t,i)=>`<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)"><span style="font-size:10px;color:var(--dim);width:14px">${i+1}</span><div style="flex:1;min-width:0"><div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</div><div style="font-size:10px;color:var(--dim)">${esc(t.artist||'')}</div></div><span style="font-size:10px;color:var(--violet)">${t.scrobbles}×</span></div>`).join('');
      const sec=document.createElement('div');
      sec.className='pip-section';
      sec.innerHTML=`<p class="pip-title">🎧 On Repeat IRL <span style="font-size:10px;color:var(--dim)">Last ${d.period_days||7}d · ${d.total_scrobbles||0} plays</span></p><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div class="card" style="padding:8px 10px"><div style="font-size:10px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Top Artists</div>${aH}</div><div class="card" style="padding:8px 10px"><div style="font-size:10px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Top Tracks</div>${tH}</div></div>`;
      const inner=$('slap-inner');
      if(inner) inner.insertBefore(sec,inner.firstChild);
    }).catch(()=>{});

  } catch(e) {
    $('slap-inner').innerHTML='<div class="card"><div class="empty">Could not load Slapshare.</div></div>';
  }
}

async function slapH2H(){
  const u1=document.getElementById('slap-h2h-u1')?.value;
  const u2=document.getElementById('slap-h2h-u2')?.value;
  const el=document.getElementById('slap-h2h-out');
  if(!el) return;
  if(!u1||!u2||u1===u2){ el.innerHTML='<span style="color:var(--dim)">Select two different users</span>'; return; }
  el.innerHTML='<div class="spin" style="margin:8px auto"></div>';
  try {
    const [d,ai]=await Promise.all([
      fetch(`${SLAP_BASE}/head-to-head/${u1}/${u2}`).then(r=>r.json()),
      fetch(`${SLAP_BASE}/taste-dna/${u1}/${u2}`).then(r=>r.json()).catch(()=>null),
    ]);
    const tot=Math.max((d.user1_songs||0)+(d.user2_songs||0),1);
    const p1=Math.round((d.user1_songs||0)/tot*100);
    const shared=(d.shared_artists||[]).slice(0,6).map(a=>`<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;background:rgba(157,92,255,.1);color:var(--violet);border:1px solid rgba(157,92,255,.2);margin:2px">${esc(a)}</span>`).join('');
    let out=`<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="color:${d.user1_color||'var(--neon)'}">${esc(slapName(u1))} — ${d.user1_songs||0}</span><span style="color:${d.user2_color||'var(--cyan)'}">${d.user2_songs||0} — ${esc(slapName(u2))}</span></div><div style="height:8px;border-radius:4px;overflow:hidden;display:flex"><div style="height:100%;width:${p1}%;background:${d.user1_color||'var(--neon)'}"></div><div style="height:100%;width:${100-p1}%;background:${d.user2_color||'var(--cyan)'}"></div></div></div>${shared?`<div style="margin-bottom:8px"><div style="font-size:10px;color:var(--dim);margin-bottom:4px">🧬 ${(d.shared_artists||[]).length} artists in common:</div>${shared}</div>`:''}`;
    if(ai&&ai.analysis) out+=`<div style="background:rgba(157,92,255,.08);border:1px solid rgba(157,92,255,.2);border-radius:10px;padding:12px;margin-top:8px"><div style="font-size:10px;color:var(--violet);margin-bottom:6px">🤖 AI Taste Analysis</div><div style="font-size:12px;line-height:1.5">${esc(ai.analysis)}</div>${ai.compatibility_score!=null?`<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><span style="font-size:10px;color:var(--dim)">Compatibility:</span><div style="flex:1;height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden"><div style="height:100%;width:${ai.compatibility_score}%;background:linear-gradient(90deg,var(--violet),var(--neon));border-radius:3px"></div></div><span style="font-size:12px;font-family:'Orbitron',sans-serif;color:var(--violet)">${ai.compatibility_score}%</span></div>`:''}</div>`;
    el.innerHTML=out;
  } catch(err){ el.innerHTML='<span style="color:var(--dim)">Could not load comparison.</span>'; }
}

async function slapRec(username){
  const el=document.getElementById('slap-rec-out');
  if(!el) return;
  document.querySelectorAll('[id^="slap-rb-"]').forEach(b=>{ b.style.background='transparent';b.style.borderColor='rgba(255,255,255,.15)';b.style.color='var(--dim)'; });
  const btn=document.getElementById('slap-rb-'+username);
  if(btn){ btn.style.background='rgba(157,92,255,.2)';btn.style.borderColor='var(--violet)';btn.style.color='var(--violet)'; }
  el.innerHTML='<div class="spin" style="margin:8px auto"></div>';
  try {
    const d=await fetch(`${SLAP_BASE}/ai/recommendations/${username}`).then(r=>r.json());
    const icons=['🎵','🎶','🎧','🎤','🎸','🎹'];
    el.innerHTML=(d.reasoning?`<div style="font-size:11px;color:var(--dim);font-style:italic;margin-bottom:8px">${esc(d.reasoning)}</div>`:'')+
      (d.recommendations||[]).slice(0,6).map((r,i)=>`<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;background:rgba(255,255,255,.03);margin-bottom:4px"><span>${icons[i]||'🎵'}</span><span style="font-size:12px">${esc(r)}</span></div>`).join('');
  } catch(err){ el.innerHTML='<span style="color:var(--dim)">Could not load recommendations.</span>'; }
}

function toggleUserMenu(){
  const m=$('userMenu'); if(!m) return; m.classList.toggle('open');
}
document.addEventListener('click', e => {
  const btn=$('userBtn'), menu=$('userMenu');
  if(btn && menu && !btn.contains(e.target) && !menu.contains(e.target))
    menu.classList.remove('open');
});

// ── Passkey registration ────────────────────────────────────────────────────
function _b64url(buf){
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function _fromB64url(s){
  const pad='='.repeat((4-s.length%4)%4);
  return Uint8Array.from(atob((s+pad).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)).buffer;
}
async function _doRegisterPasskey(onSuccess) {
  if(!window.PublicKeyCredential) throw new Error('Passkeys not supported in this browser');
  const br = await fetch('/auth/passkey/register/begin',{method:'POST'});
  if(!br.ok) throw new Error((await br.json()).error || 'Failed to start');
  const {passkeyId, options} = await br.json();

  options.challenge = _fromB64url(options.challenge);
  options.user.id   = _fromB64url(options.user.id);
  if(options.excludeCredentials)
    options.excludeCredentials = options.excludeCredentials.map(c=>({...c,id:_fromB64url(c.id)}));

  const cred = await navigator.credentials.create({publicKey: options});
  const credential = {
    id: cred.id, rawId: _b64url(cred.rawId), type: cred.type,
    response: {
      clientDataJSON:   _b64url(cred.response.clientDataJSON),
      attestationObject:_b64url(cred.response.attestationObject),
    },
  };
  const passkeyName = (navigator.userAgentData?.platform || navigator.platform || 'Device') + ' passkey';
  const cr = await fetch('/auth/passkey/register/complete',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({passkeyId, credential, passkeyName}),
  });
  if(!cr.ok) throw new Error('Registration failed');
  if(onSuccess) onSuccess();
}

// Legacy shortcut (called from old spots if any)
async function registerPasskey(){
  $('userMenu')?.classList.remove('open');
  try { await _doRegisterPasskey(); toast('🔑 Passkey added!'); }
  catch(e){ if(e.name!=='NotAllowedError') toast('Error: '+e.message); }
}

// ── Settings modal ─────────────────────────────────────────────────────────
let _adminChecked = false;
function openSettings(){
  $('userMenu')?.classList.remove('open');
  $('settingsOverlay').classList.add('open');
  loadPasskeys();
  if(!_adminChecked){ _adminChecked=true;
    fetch('/api/admin/check').then(r=>r.json()).then(d=>{
      if(d.admin){ const tb=$('tabUsersBtn'); if(tb) tb.style.display=''; }
    }).catch(()=>{});
  }
}
function closeSettings(){ $('settingsOverlay').classList.remove('open'); }

function switchTab(name){
  document.querySelectorAll('.stab').forEach(t=>{
    t.classList.toggle('active', t.dataset.tab===name);
  });
  document.querySelectorAll('.spanel').forEach(p=>{
    p.classList.toggle('active', p.id==='tab-'+name);
  });
  if(name==='psn') loadPsnStatus();
  if(name==='users') loadAdminUsers();
}

async function loadPsnStatus(){
  const el=$('psnStatus');
  if(!el) return;
  el.innerHTML='<span style="color:var(--dim)">Loading…</span>';
  try {
    const r = await fetch('/auth/settings/psn');
    const d = await r.json();

    // ── My account (everyone including admin, once claimed) ───────────
    if(d.linked){
      const linked = d.linked_at ? new Date(d.linked_at*1000).toLocaleDateString() : null;
      const expiry = d.refresh_expires_at ? new Date(d.refresh_expires_at*1000) : null;
      const expired = expiry && expiry < new Date();
      let html =
        `<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <span style="font-size:28px">🎮</span>
          <div>
            <div style="color:#fff;font-weight:700;font-size:16px">${d.online_id||'—'}</div>
            ${linked?`<div style="font-size:11px;color:var(--dim)">Linked ${linked}</div>`:''}
          </div>
          <span style="margin-left:auto;font-size:12px;padding:3px 9px;border-radius:20px;font-weight:700;
            background:${expired?'rgba(255,60,60,.15)':'rgba(0,220,120,.12)'};
            color:${expired?'#ff6060':'#00dc78'};
            border:1px solid ${expired?'rgba(255,60,60,.3)':'rgba(0,220,120,.3)'}">
            ${expired?'Expired':'Active'}
          </span>
        </div>
        ${expired?'<div style="font-size:12.5px;color:#ff9060;margin-bottom:10px">⚠️ Token expired — re-link to refresh.</div>':''}`;
      // Admin: also show all accounts below + reveal Users tab
      if(d.admin){
        const tb=$('tabUsersBtn'); if(tb) tb.style.display='';
        if(d.users && d.users.length) html += _adminUsersHtml(d.users);
      }
      el.innerHTML = html;
      // Show re-link button, hide inline flow
      const flow=$('psnLinkFlow'), relinkBtn=$('psnRelinkBtn');
      if(flow) flow.style.display='none';
      if(relinkBtn){ relinkBtn.style.display='block'; relinkBtn.textContent='Re-link PSN account'; }
      return;
    }

    // ── Not yet claimed — show inline link flow + unclaimed list ──────
    const flow2=$('psnLinkFlow'), relinkBtn2=$('psnRelinkBtn');
    if(flow2){ flow2.style.display='block'; _psnStep=1; psnAdvance(1); }
    if(relinkBtn2) relinkBtn2.style.display='none';
    const unclaimed = d.unclaimed || [];
    let html = '';
    if(unclaimed.length){
      html += `<p style="font-size:12.5px;color:var(--dim);margin:0 0 12px">Is one of these yours? Tap to claim it.</p>`;
      html += unclaimed.map(u => {
        const dt = u.linked_at ? new Date(u.linked_at*1000).toLocaleDateString() : '';
        return `<div class="pk-row" style="margin-bottom:8px">
          <div class="pk-info">
            <span class="pk-name">${u.online_id||u.mm_username||'Unknown'}</span>
            ${dt?`<span class="pk-date">Linked ${dt}</span>`:''}
          </div>
          <button class="smodal-btn" style="width:auto;margin:0;padding:6px 13px;font-size:12px"
            onclick="claimPsn('${u.key}','${u.online_id||u.mm_username||''}')">This is mine</button>
        </div>`;
      }).join('');
    } else {
      html = '<span style="color:var(--dim);font-size:13.5px">No unassigned accounts found.<br>Use the button below to link a new one.</span>';
    }
    // Admin: also show full list below the claim section + reveal Users tab
    if(d.admin){
      const tb=$('tabUsersBtn'); if(tb) tb.style.display='';
    }
    if(d.admin && d.users && d.users.length){
      html += _adminUsersHtml(d.users);
    }
    el.innerHTML = html;
  } catch(e){ el.innerHTML='<span style="color:#ff7070">Could not load PSN status.</span>'; }
}

function _adminUsersHtml(users){
  if(!users.length) return '';
  return `<div style="margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)">
    <p style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin:0 0 10px">All accounts</p>` +
    users.map(u => {
      const expiry = u.refresh_expires_at ? new Date(u.refresh_expires_at*1000) : null;
      const expired = expiry && expiry < new Date();
      const claimed = !!u.zitadel_user_id;
      const dt = u.linked_at ? new Date(u.linked_at*1000).toLocaleDateString() : '';
      return `<div class="pk-row" style="margin-bottom:8px">
        <div class="pk-info">
          <span class="pk-name">${u.online_id||u.mm_username||'Unknown'}</span>
          <span class="pk-date">${dt?'Linked '+dt:''}${claimed?' · claimed':' · unclaimed'}</span>
        </div>
        <span style="font-size:11px;padding:3px 8px;border-radius:20px;font-weight:700;white-space:nowrap;
          background:${expired?'rgba(255,60,60,.15)':'rgba(0,220,120,.12)'};
          color:${expired?'#ff6060':'#00dc78'};
          border:1px solid ${expired?'rgba(255,60,60,.3)':'rgba(0,220,120,.3)'}">
          ${expired?'Expired':'Active'}
        </span>
      </div>`;
    }).join('') + `</div>`;
}

// ── Admin: user management ────────────────────────────────────────────────────
async function loadAdminUsers(){
  const el=$('adminUsersList');
  if(!el) return;
  el.innerHTML='<span style="color:var(--dim)">Loading…</span>';
  try{
    const r=await fetch('/api/admin/users');
    if(r.status===403){ el.innerHTML='<span style="color:#ff7070">Not authorised.</span>'; return; }
    const d=await r.json();
    const users=d.users||[];
    if(!users.length){ el.innerHTML='<span style="color:var(--dim)">No users found.</span>'; return; }
    el.innerHTML=users.map(u=>`
      <div class="pk-row" style="margin-bottom:10px;align-items:flex-start;gap:8px">
        <div class="pk-info" style="flex:1;min-width:0">
          <span class="pk-name" style="display:block">${esc(u.displayName||u.userName||u.userId)}</span>
          <span class="pk-date">${esc(u.email||'')}${u.state&&u.state!=='USER_STATE_ACTIVE'?' · '+u.state.replace('USER_STATE_','').toLowerCase():''}</span>
        </div>
        <button class="smodal-btn" style="width:auto;margin:0;padding:6px 13px;font-size:12px;flex-shrink:0"
          onclick="adminResetPassword('${esc(u.userId)}','${esc(u.displayName||u.userName||'')}')">🔑 Reset pw</button>
      </div>`).join('');
  }catch(e){ el.innerHTML='<span style="color:#ff7070">Could not load users.</span>'; }
}

let _adminResetTarget=null;
function adminResetPassword(userId,displayName){
  _adminResetTarget={userId,displayName};
  const el=$('adminUsersList');
  const existing=$('adminResetForm');
  if(existing) existing.remove();
  const form=document.createElement('div');
  form.id='adminResetForm';
  form.style.cssText='margin-top:14px;padding:14px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,47,214,.2)';
  form.innerHTML=`
    <p style="font-size:12px;color:var(--dim);margin:0 0 10px">Reset password for <strong style="color:#fff">${esc(displayName||userId)}</strong></p>
    <div id="adminResetMsg" class="smsg" style="display:none;margin-bottom:8px"></div>
    <label class="sfield-label">New password</label>
    <input class="sfield" type="password" id="adminPwNew" autocomplete="new-password" placeholder="••••••••">
    <label class="sfield-label" style="margin-top:8px">Confirm</label>
    <input class="sfield" type="password" id="adminPwConf" autocomplete="new-password" placeholder="••••••••">
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="smodal-btn" style="flex:1" onclick="adminResetSubmit()">Set password</button>
      <button class="smodal-btn" style="flex:0 0 auto;background:none;border:1px solid rgba(255,255,255,.12);color:var(--dim)" onclick="this.closest('#adminResetForm').remove()">Cancel</button>
    </div>`;
  el.after(form);
  $('adminPwNew').focus();
}

async function adminResetSubmit(){
  if(!_adminResetTarget) return;
  const pw=($('adminPwNew')||{}).value||'';
  const conf=($('adminPwConf')||{}).value||'';
  const msg=$('adminResetMsg');
  const showMsg=(txt,err)=>{ msg.style.display='block'; msg.className='smsg'+(err?' error':''); msg.textContent=txt; };
  if(!pw){ showMsg('Enter a new password.',true); return; }
  if(pw.length<8){ showMsg('Password must be at least 8 characters.',true); return; }
  if(pw!==conf){ showMsg('Passwords do not match.',true); return; }
  try{
    const r=await fetch(`/api/admin/users/${encodeURIComponent(_adminResetTarget.userId)}/reset-password`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({newPassword:pw})
    });
    const d=await r.json();
    if(!r.ok){ showMsg(d.error||'Failed.',true); return; }
    showMsg('Password reset. User will be prompted to change it on next login.', false);
    setTimeout(()=>{ $('adminResetForm')?.remove(); },2500);
  }catch(e){ showMsg('Request failed.',true); }
}

// ── PSN inline link flow ─────────────────────────────────────────────────────
let _psnStep = 1;
function psnAdvance(n){
  if(n > _psnStep) _psnStep = n;
  // Mark completed dots
  [1,2,3].forEach(i=>{
    const dot=$('psdot-'+i);
    if(!dot) return;
    dot.classList.toggle('done', i < _psnStep);
    dot.classList.toggle('active', i === _psnStep);
  });
  // Unlock steps up to current
  const blocks=['psnS1','psnS2','psnS3'];
  blocks.forEach((id,i)=>{
    const el=$(id); if(!el) return;
    el.classList.toggle('locked', i+1 > _psnStep);
  });
  // Scroll the next unlocked step into view
  const next = $('psnS'+_psnStep);
  if(next) setTimeout(()=>next.scrollIntoView({behavior:'smooth',block:'nearest'}),80);
}
function togglePsnRelink(){
  const flow=$('psnLinkFlow'), btn=$('psnRelinkBtn');
  const showing = flow.style.display!=='none';
  flow.style.display = showing ? 'none' : 'block';
  btn.textContent = showing ? 'Re-link PSN account' : 'Cancel';
  if(!showing){ _psnStep=1; psnAdvance(1); }
}
async function psnPasteClipboard(){
  try {
    const t = await navigator.clipboard.readText();
    if(t){ $('psnTokenInput').value=t.trim(); psnAdvance(3); }
  } catch(e){ $('psnTokenInput').focus(); }
}
async function linkPsn(){
  const token = ($('psnTokenInput').value||'').trim();
  if(!token) return;
  const btn=$('psnLinkBtn'), msg=$('psnLinkMsg');
  btn.disabled=true; btn.textContent='Linking…';
  msg.className='smsg'; msg.style.display='none';
  try {
    const r = await fetch('/api/psn/link',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({npsso:token})});
    const d = await r.json();
    if(r.ok){
      msg.className='smsg ok'; msg.style.display='block';
      msg.textContent = '✓ Linked as '+d.online_id+'! Your messages now appear from your PSN account.';
      btn.style.display='none';
      $('psnLinkFlow').style.display='none';
      $('psnRelinkBtn').style.display='none';
      setTimeout(loadPsnStatus, 400);
    } else {
      msg.className='smsg err'; msg.style.display='block';
      msg.textContent = d.error || 'Link failed — try a fresh token.';
      btn.disabled=false; btn.textContent='🔗 Link my account';
    }
  } catch(e){
    msg.className='smsg err'; msg.style.display='block';
    msg.textContent='Network error — try again.';
    btn.disabled=false; btn.textContent='🔗 Link my account';
  }
}

async function claimPsn(key, name){
  if(!confirm('Claim "'+name+'" as your PlayStation account?')) return;
  const r = await fetch('/auth/settings/psn/claim',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({key}),
  });
  if(r.ok){ loadPsnStatus(); }
  else { alert('Could not claim — it may already be assigned.'); }
}

function _pkMsg(msg, type){ const el=$('pkMsg'); el.className='smsg '+type; el.textContent=msg; }
function _pwMsg(msg, type){ const el=$('pwMsg'); el.className='smsg '+type; el.textContent=msg; }

async function loadPasskeys(){
  const el=$('pkList'); el.innerHTML='<div class="pk-empty">Loading…</div>';
  try {
    const r = await fetch('/auth/settings/passkeys');
    if(!r.ok){ el.innerHTML='<div class="pk-empty">Could not load passkeys.</div>'; return; }
    const {passkeys} = await r.json();
    if(!passkeys || !passkeys.length){ el.innerHTML='<div class="pk-empty">No passkeys yet.</div>'; return; }
    el.innerHTML = passkeys.map(pk => {
      const dt = pk.changeDate ? new Date(pk.changeDate).toLocaleDateString() : '';
      return `<div class="pk-row">
        <div class="pk-info">
          <span class="pk-name">${pk.name||'Passkey'}</span>
          ${dt?`<span class="pk-date">Added ${dt}</span>`:''}
        </div>
        <button class="pk-del" onclick="deletePasskey('${pk.id}')">Remove</button>
      </div>`;
    }).join('');
  } catch(e){ el.innerHTML='<div class="pk-empty">Error loading passkeys.</div>'; }
}

async function deletePasskey(id){
  if(!confirm('Remove this passkey?')) return;
  const r = await fetch('/auth/settings/passkeys/'+id, {method:'DELETE'});
  if(r.ok){ _pkMsg('Passkey removed.','ok'); loadPasskeys(); }
  else { _pkMsg('Could not remove passkey.','err'); }
}

async function addPasskeyFromSettings(){
  _pkMsg('','');
  try {
    await _doRegisterPasskey(()=>{ _pkMsg('Passkey added!','ok'); loadPasskeys(); });
  } catch(e){
    if(e.name!=='NotAllowedError') _pkMsg('Error: '+e.message,'err');
  }
}

async function changePassword(){
  _pwMsg('','');
  const cur=$('pwCur').value, nw=$('pwNew').value, conf=$('pwConf').value;
  if(!cur||!nw){ _pwMsg('Fill in all fields.','err'); return; }
  if(nw!==conf){ _pwMsg('New passwords do not match.','err'); return; }
  if(nw.length<8){ _pwMsg('Password must be at least 8 characters.','err'); return; }
  const r = await fetch('/auth/settings/password',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({currentPassword:cur, newPassword:nw}),
  });
  const d = await r.json();
  if(r.ok){ _pwMsg('Password updated!','ok'); $('pwCur').value=''; $('pwNew').value=''; $('pwConf').value=''; }
  else { _pwMsg(d.error||'Failed to update password.','err'); }
}

// ── WhatsApp Analytics ────────────────────────────────────────────────────────
let _waLoaded = false;
let _waRange = 'all_time';
let _waStart = '', _waEnd = '';

function waSetRange(btn){
  document.querySelectorAll('.wa-rb').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  _waRange = btn.dataset.r;
  const custom = $('waCustomRange');
  if(custom) custom.style.display = _waRange==='custom' ? 'flex' : 'none';
  if(_waRange !== 'custom') waReload();
}
function waReload(){
  if(_waRange==='custom'){
    _waStart = ($('waStart')||{}).value||'';
    _waEnd   = ($('waEnd')||{}).value||'';
    if(!_waStart||!_waEnd) return;
  }
  _waLoaded = false;
  if($('wa-inner')) $('wa-inner').innerHTML = '<div class="spin">Loading…</div>';
  if($('wa-stats')) $('wa-stats').innerHTML = '';
  loadWa();
}

function _waQs(){
  let qs = '?range='+_waRange;
  if(_waRange==='custom') qs += '&start='+_waStart+'&end='+_waEnd;
  return qs;
}

async function loadWa(){
  if(_waLoaded) return;
  _waLoaded = true;
  try {
    const qs = _waQs();
    const [sR,aR,hmR,wdR,emR,rtR,mbR,awR,ciR] = await Promise.all([
      fetch('/api/whatsapp/stats'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/activity'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/heatmap'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/words'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/emojis'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/response-times'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/members'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/awards'+qs).then(r=>r.json()),
      fetch('/api/whatsapp/can-import').then(r=>r.json()),
    ]);

    // Stat tiles
    const fmtN = n => n>=1000 ? (n/1000).toFixed(1)+'k' : String(n||0);
    $('wa-stats').innerHTML =
      `<div class="stile"><div class="sv">${fmtN(sR.total_messages)}</div><div class="sl">💬 Messages</div></div>`+
      `<div class="stile"><div class="sv">${sR.total_members||0}</div><div class="sl">👥 Members</div></div>`+
      `<div class="stile"><div class="sv">${fmtN(sR.total_videos)}</div><div class="sl">🎬 Videos</div></div>`+
      `<div class="stile"><div class="sv">${fmtN(sR.total_photos)}</div><div class="sl">📷 Photos</div></div>`+
      `<div class="stile"><div class="sv">${sR.conversation_days||0}</div><div class="sl">📅 Days</div></div>`+
      `<div class="stile"><div class="sv" style="font-size:14px">${sR.total_members>0?fmtN(Math.round((sR.total_messages||0)/(sR.total_members||1))):'—'}</div><div class="sl">📊 Msgs/Person</div></div>`;

    if(ciR.can_import) $('wa-import-section').style.display='block';

    let html = '';

    // Empty state
    if(!sR.total_messages){
      html = `<div class="card"><div class="empty">No WhatsApp messages yet.<br>`;
      if(ciR.can_import) html += `Use the import button below to load your chat history.`;
      else html += `Ask Moiz to import the chat history.`;
      html += `</div></div>`;
      $('wa-inner').innerHTML = html;
      return;
    }

    // ── Awards ───────────────────────────────────────────────────────────────
    const aw = awR;
    const awards = [
      {em:'🏆',role:'Certified Yapper',  name: aw.certified_yapper?.name,  stat: aw.certified_yapper?.count+' msgs'},
      {em:'🌙',role:'Night Owl',          name: aw.night_owl?.name,          stat: aw.night_owl?.count+' late msgs'},
      {em:'🌅',role:'Early Bird',         name: aw.early_bird?.name,         stat: aw.early_bird?.count+' morning msgs'},
      {em:'🎬',role:'Video King',         name: aw.video_king?.name,         stat: aw.video_king?.count+' videos'},
      {em:'📷',role:'Photo King',         name: aw.photo_king?.name,         stat: aw.photo_king?.count+' photos'},
      {em:'💀',role:'Most 💀',            name: aw.most_skull?.name,         stat: aw.most_skull?.count+' skulls'},
      {em:'😂',role:'Most 😂',            name: aw.most_laugh?.name,         stat: aw.most_laugh?.count+' laughs'},
      {em:'🔥',role:'Most 🔥',            name: aw.most_fire?.name,          stat: aw.most_fire?.count+' fires'},
      {em:'⚡',role:'Fastest Replier',    name: aw.fastest_replier?.name,    stat: aw.fastest_replier?.avg_minutes ? aw.fastest_replier.avg_minutes+'m avg' : null},
      {em:'👻',role:'Ghost of Month',     name: aw.ghost_of_month?.name,     stat: aw.ghost_of_month?.count+' msgs'},
    ].filter(a=>a.name);

    if(awards.length){
      const cards = awards.map(a=>`<div class="wa-award">
        <div class="aw-em">${a.em}</div>
        <div class="aw-role">${esc(a.role)}</div>
        <div class="aw-name">${esc(a.name||'—')}</div>
        ${a.stat?`<div class="aw-stat">${esc(String(a.stat))}</div>`:''}
      </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🏅 Awards</p>
  <div class="wa-award-grid">${cards}</div>
</div>`;
    }

    // Fun facts row
    const facts = [];
    if(aw.most_used_emoji) facts.push(`Most used emoji: ${aw.most_used_emoji.emoji} (${aw.most_used_emoji.count}×)`);
    if(aw.peak_hour!=null) facts.push(`Peak hour: ${aw.peak_hour.hour}:00 (${aw.peak_hour.count} msgs)`);
    if(aw.biggest_day)    facts.push(`Biggest day: ${aw.biggest_day.date} — ${aw.biggest_day.count} msgs`);
    if(aw.longest_streak_days>1) facts.push(`Longest streak: ${aw.longest_streak_days} days`);
    if(facts.length){
      html += `<div class="pip-section">
  <div class="card" style="padding:10px 16px">
    <div style="display:flex;flex-wrap:wrap;gap:8px">
    ${facts.map(f=>`<span style="font-size:12px;padding:4px 10px;border-radius:20px;background:rgba(34,230,255,.08);border:1px solid rgba(34,230,255,.2);color:var(--cyan)">${esc(f)}</span>`).join('')}
    </div>
  </div>
</div>`;
    }

    // ── Activity Timeline (bar chart) ────────────────────────────────────────
    const daily = (aR.daily||[]).slice(-60);
    if(daily.length>1){
      const dMax = Math.max(...daily.map(d=>d.count),1);
      const bars = daily.map(d=>{
        const h = Math.max(2, Math.round((d.count/dMax)*60));
        return `<div title="${esc(d.date)}: ${d.count}" style="display:flex;flex-direction:column;align-items:center;gap:2px">
          <div style="width:7px;background:linear-gradient(to top,var(--cyan),var(--neon));border-radius:2px 2px 0 0;height:${h}px;opacity:.8"></div>
        </div>`;
      }).join('');
      const labels = daily.filter((_,i)=>i%10===0).map(d=>`<span style="font-size:8px;color:var(--dim)">${d.date.slice(5)}</span>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">📈 Activity Timeline <span style="font-size:10px;color:var(--dim)">last 60 days</span></p>
  <div class="card" style="padding:12px 16px;overflow-x:auto">
    <div style="display:flex;align-items:flex-end;gap:2px;min-height:80px">${bars}</div>
  </div>
</div>`;
    }

    // ── Monthly timeline ─────────────────────────────────────────────────────
    const monthly = aR.monthly||[];
    if(monthly.length>1){
      const mMax = Math.max(...monthly.map(m=>m.count),1);
      const mBars = monthly.map(m=>{
        const h = Math.max(2, Math.round((m.count/mMax)*60));
        return `<div title="${esc(m.month)}: ${m.count}" style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0">
          <div style="width:100%;background:linear-gradient(to top,var(--violet),var(--neon));border-radius:3px 3px 0 0;height:${h}px;opacity:.85"></div>
          <div style="font-size:8px;color:var(--dim);writing-mode:vertical-rl;transform:rotate(180deg);max-height:28px;overflow:hidden">${esc(m.month.slice(2))}</div>
        </div>`;
      }).join('');
      html += `<div class="pip-section">
  <p class="pip-title">📅 Monthly Activity</p>
  <div class="card" style="padding:12px 16px">
    <div style="display:flex;align-items:flex-end;gap:3px;min-height:80px">${mBars}</div>
  </div>
</div>`;
    }

    // ── Activity by Hour ─────────────────────────────────────────────────────
    const byHour = aR.by_hour||[];
    if(byHour.length){
      const hMax = Math.max(...byHour.map(h=>h.count),1);
      const hBars = byHour.map(h=>{
        const ht = Math.max(1, Math.round((h.count/hMax)*48));
        return `<div title="${h.hour}:00 — ${h.count}" style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1">
          <div style="width:100%;background:linear-gradient(to top,var(--cyan),rgba(34,230,255,.4));border-radius:2px 2px 0 0;height:${ht}px"></div>
          <div style="font-size:7px;color:var(--dim)">${h.hour}</div>
        </div>`;
      }).join('');
      html += `<div class="pip-section">
  <p class="pip-title">⏰ Activity by Hour</p>
  <div class="card" style="padding:12px 16px">
    <div style="display:flex;align-items:flex-end;gap:2px;min-height:66px">${hBars}</div>
  </div>
</div>`;
    }

    // ── Day of Week ──────────────────────────────────────────────────────────
    const byDow = aR.by_dow||[];
    if(byDow.length){
      const dMax2 = Math.max(...byDow.map(d=>d.count),1);
      const dowBars = byDow.map(d=>{
        const w2 = Math.round((d.count/dMax2)*100);
        return `<div class="wa-bar-row">
          <div class="wa-bar-name">${esc(d.label)}</div>
          <div class="wa-bar-track"><div class="wa-bar-fill" style="width:${w2}%"></div></div>
          <div class="wa-bar-val">${d.count}</div>
        </div>`;
      }).join('');
      html += `<div class="pip-section">
  <p class="pip-title">📆 Activity by Day of Week</p>
  <div class="card" style="padding:8px 16px">${dowBars}</div>
</div>`;
    }

    // ── Activity Heatmap ─────────────────────────────────────────────────────
    {
      const cells = hmR.cells||[];
      const hMax2 = hmR.max_count||1;
      const lookup = {};
      cells.forEach(c=>{ lookup[c.dow+'-'+c.hour]=c.count; });
      const days7 = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      const hmRows = days7.map((d,di)=>{
        const cols = Array.from({length:24},(_,h)=>{
          const cnt = lookup[di+'-'+h]||0;
          const bg = cnt ? `rgba(157,92,255,${(0.15+Math.min(cnt/hMax2,1)*0.75).toFixed(2)})` : 'rgba(255,255,255,.04)';
          return `<div title="${d} ${h}:00 — ${cnt} msgs" style="width:13px;height:13px;border-radius:2px;background:${bg};flex-shrink:0"></div>`;
        }).join('');
        return `<div style="display:flex;align-items:center;gap:3px;margin-bottom:3px"><div style="width:26px;font-size:9px;color:var(--dim);text-align:right;flex-shrink:0">${d}</div>${cols}</div>`;
      }).join('');
      const hmLbls = Array.from({length:8},(_,i)=>`<div style="flex:1;font-size:8px;color:var(--dim);text-align:center">${i*3}h</div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">🌡️ Activity Heatmap <span style="font-size:10px;color:var(--dim)">day × hour</span></p>
  <div class="card" style="padding:12px 16px;overflow-x:auto">
    <div style="min-width:380px">
      <div style="display:flex;margin-left:29px;margin-bottom:4px">${hmLbls}</div>
      ${hmRows}
    </div>
  </div>
</div>`;
    }

    // ── Member Activity ──────────────────────────────────────────────────────
    const mbs = mbR.members||[];
    if(mbs.length){
      const mMax2 = mbs[0]?.messages||1;
      const mRows = mbs.map((m,i)=>{
        const pct = Math.round((m.messages/mMax2)*100);
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
        return `<div style="display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid rgba(255,255,255,.04)">
          <div style="font-size:14px;width:24px;text-align:center;flex-shrink:0">${medal||String(i+1)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</div>
            <div style="height:4px;background:rgba(255,255,255,.06);border-radius:2px;margin-top:4px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--cyan),var(--neon));border-radius:2px"></div>
            </div>
            <div style="font-size:10px;color:var(--dim);margin-top:2px">${m.total_words} words · ${m.avg_words_per_msg} avg/msg</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-family:'Orbitron',sans-serif;font-size:13px;color:var(--cyan)">${m.messages}</div>
            <div style="font-size:9px;color:var(--dim)">msgs</div>
          </div>
        </div>`;
      }).join('');
      html += `<div class="pip-section">
  <p class="pip-title">👥 Member Activity</p>
  <div class="card" style="padding:4px 12px">${mRows}</div>
</div>`;
    }

    // ── Emoji Analysis ───────────────────────────────────────────────────────
    const topEm = emR.top_emoji||[];
    if(topEm.length){
      const emCards = topEm.slice(0,12).map(e=>`<div style="text-align:center;padding:10px 6px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px">
        <div style="font-size:26px">${e.emoji}</div>
        <div style="font-family:'Orbitron',sans-serif;font-size:11px;color:var(--gold);margin-top:4px">${e.count}</div>
        <div style="font-size:9px;color:var(--dim)">${e.pct}%</div>
      </div>`).join('');
      html += `<div class="pip-section">
  <p class="pip-title">😂 Top Emoji <span style="font-size:10px;color:var(--dim)">${emR.total_emoji||0} total</span></p>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:7px;margin-bottom:10px">${emCards}</div>`;

      // Emoji by member
      const memberEmKeys = Object.keys(emR.member_top_emoji||{});
      if(memberEmKeys.length){
        const memEm = memberEmKeys.map(name=>{
          const tops = (emR.member_top_emoji[name]||[]).slice(0,5).map(e=>`<span title="${e.count}" style="font-size:18px">${e.emoji}</span>`).join(' ');
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04)">
            <div style="font-size:12px;font-weight:600;flex-shrink:0;width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
            <div>${tops}</div>
          </div>`;
        }).join('');
        html += `<div class="card" style="padding:8px 12px;margin-top:8px">${memEm}</div>`;
      }
      html += `</div>`;
    }

    // ── Word Analysis ────────────────────────────────────────────────────────
    const topWords = wdR.top_words||[];
    if(topWords.length){
      const wMax = topWords[0]?.count||1;
      const wRows = topWords.slice(0,20).map((w,i)=>{
        const pct = Math.round((w.count/wMax)*100);
        return `<div class="wa-bar-row">
          <div class="wa-bar-name" style="width:90px;font-size:12px">${esc(w.word)}</div>
          <div class="wa-bar-track"><div class="wa-bar-fill" style="width:${pct}%;background:linear-gradient(90deg,var(--violet),var(--cyan))"></div></div>
          <div class="wa-bar-val">${w.count}</div>
        </div>`;
      }).join('');

      // Word cloud
      const cloudMax = topWords[0]?.count||1;
      const cloud = topWords.slice(0,50).map(w=>{
        const sz = Math.round(10 + (w.count/cloudMax)*16);
        const op = (0.4 + (w.count/cloudMax)*0.6).toFixed(2);
        const colors = ['var(--cyan)','var(--neon)','var(--violet)','var(--lime)','var(--gold)'];
        const col = colors[w.word.charCodeAt(0)%colors.length];
        return `<span style="font-size:${sz}px;opacity:${op};color:${col};cursor:default" title="${w.count}">${esc(w.word)}</span>`;
      }).join(' ');

      html += `<div class="pip-section">
  <p class="pip-title">📝 Word Analysis</p>
  <div class="wa-word-grid">
    <div class="card" style="padding:8px 12px">${wRows}</div>
    <div class="card" style="padding:12px 14px;line-height:1.9"><div class="wa-cloud">${cloud}</div></div>
  </div>
</div>`;
    }

    // ── Response Times ───────────────────────────────────────────────────────
    const rtData = rtR.member_avg_minutes||[];
    if(rtData.length){
      const rtMax = rtData[rtData.length-1]?.avg_minutes||60;
      const rtRows = rtData.map((r,i)=>{
        const pct = Math.round((r.avg_minutes/Math.max(rtMax,1))*100);
        return `<div class="wa-bar-row">
          <div class="wa-bar-name" style="width:90px">${esc(r.name)}</div>
          <div class="wa-bar-track"><div class="wa-bar-fill" style="width:${pct}%;background:linear-gradient(90deg,var(--lime),var(--cyan))"></div></div>
          <div class="wa-bar-val">${r.avg_minutes}m</div>
        </div>`;
      }).join('');
      const distData = rtR.distribution||[];
      const distMax = Math.max(...distData.map(d=>d.count),1);
      const distBars = distData.map(d=>{
        const h = Math.max(2, Math.round((d.count/distMax)*50));
        return `<div title="${esc(d.label)}: ${d.count}" style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">
          <div style="width:100%;background:linear-gradient(to top,var(--violet),var(--neon));border-radius:3px 3px 0 0;height:${h}px"></div>
          <div style="font-size:9px;color:var(--dim);white-space:nowrap">${esc(d.label)}</div>
        </div>`;
      }).join('');
      html += `<div class="pip-section">
  <p class="pip-title">⚡ Response Times <span style="font-size:10px;color:var(--dim)">${rtR.event_count||0} exchanges</span></p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div class="card" style="padding:8px 12px">${rtRows}</div>
    <div class="card" style="padding:12px 16px">
      <div style="display:flex;align-items:flex-end;gap:4px;min-height:60px">${distBars}</div>
    </div>
  </div>
</div>`;
    }

    // ── Export button ────────────────────────────────────────────────────────
    html += `<div class="pip-section">
  <a href="/api/whatsapp/export${_waQs()}" download style="display:block;text-align:center;padding:11px;border-radius:12px;background:rgba(255,47,214,.1);border:1px solid rgba(255,47,214,.3);color:var(--neon);font-size:13.5px;font-weight:700;text-decoration:none">📊 Export as Excel</a>
</div>`;

    $('wa-inner').innerHTML = html;

  } catch(err) {
    if($('wa-inner')) $('wa-inner').innerHTML = '<div class="card"><div class="empty">Could not load WhatsApp analytics.</div></div>';
  }
}

async function waDoImport(){
  const fi = $('waImportFile');
  if(!fi||!fi.files.length) return;
  const file = fi.files[0];
  const msg = $('waImportMsg');
  const btn = fi.previousElementSibling;
  if(msg){ msg.style.display='none'; }
  if(btn){ btn.disabled=true; btn.textContent='Uploading…'; }
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/whatsapp/import', {method:'POST', body:fd});
    const d = await r.json();
    if(r.ok){
      const s = d.status==='already_imported'
        ? `Already imported (${d.message_count} messages on file).`
        : `✓ Imported ${d.message_count} messages (${d.duplicate_count} dupes skipped).`;
      if(msg){ msg.className='smsg ok'; msg.textContent=s; msg.style.display='block'; }
      // Reload analytics
      setTimeout(()=>{ _waLoaded=false; loadWa(); }, 800);
    } else {
      if(msg){ msg.className='smsg err'; msg.textContent=d.detail||'Import failed.'; msg.style.display='block'; }
    }
  } catch(e){
    if(msg){ msg.className='smsg err'; msg.textContent='Network error.'; msg.style.display='block'; }
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='📂 Choose Export File'; }
    fi.value='';
  }
}

// ── Giveaway ─────────────────────────────────────────────────────────────────
let _gwLoaded=false, _gwTimer=null, _gwConfettiStop=null;

async function loadGiveaway(){
  if(_gwLoaded) return; _gwLoaded=true;
  const el=$('giveaway-inner');
  try{
    const [d,hist]=await Promise.all([
      fetch('/api/giveaway').then(r=>r.json()),
      fetch('/api/giveaway/history').then(r=>r.json()),
    ]);
    // If reveal date already passed and not yet revealed, auto-trigger immediately
    const g=d.giveaway;
    if(g&&d.is_admin&&['open','locked','drawn'].includes(g.status)&&g.reveal_at&&(gwParseLocalDate(g.reveal_at)||Infinity)<=Date.now()){
      await fetch('/api/giveaway/'+g.id+'/draw-and-reveal',{method:'POST'});
      _gwLoaded=false; loadGiveaway(); return;
    }
    el.innerHTML=gwRender(d,hist);
    gwWireTimers(d);
    if(d.giveaway?.status==='revealed'){
      const key='celebrated_gw_'+d.giveaway.id;
      if(!localStorage.getItem(key)){ gwConfetti(5000); localStorage.setItem(key,'1'); }
    }
  }catch(e){ el.innerHTML='<div class="gw-no-giveaway">Failed to load giveaway.</div>'; }
}

function gwRender(d, hist){
  const g=d.giveaway, r=d.rotation, isAdmin=d.is_admin;
  let html='';
  if(!g){
    html+='<div class="gw-hero"><div class="gw-no-giveaway">No active giveaway right now.</div></div>';
  } else if(g.status==='revealed'||g.status==='closed'){
    const w=g.active_draw;
    html+='<div class="gw-hero"><div class="gw-hero-title">'+(esc(g.title)||'Giveaway')+'</div><div class="gw-winner-reveal"><div style="font-size:13px;color:var(--dim);margin-bottom:8px">🏆 Winner</div><div class="gw-winner-name">'+(esc(w?.winner_name||'—'))+'</div>'+(g.prize?'<div class="gw-winner-prize">🎁 '+esc(g.prize)+'</div>':'')+'</div></div>';
  } else if(g.status==='drawn'&&!isAdmin){
    html+='<div class="gw-hero"><div class="gw-hero-title">'+(esc(g.title)||'Giveaway')+'</div><div class="gw-hero-prize">'+(esc(g.prize)||'')+'</div><div style="font-size:13px;color:var(--dim);margin-bottom:12px">Winner reveal in</div>'+gwTimerHtml('gwReveal')+'</div>';
  } else {
    html+='<div class="gw-hero"><div class="gw-hero-title">'+(esc(g.title)||'Giveaway')+'</div><div class="gw-hero-prize">'+(esc(g.prize)||'Prize TBD')+'</div>'+(g.reveal_at?'<div style="font-size:12px;color:var(--dim);margin-bottom:12px">Reveal '+new Date(g.reveal_at).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})+'</div>'+gwTimerHtml('gwDraw'):'')+'<div class="gw-eligibility '+(d.user_eligible?'eligible':'ineligible')+'">'+(d.user_eligible?'✅ You\'re eligible':d.user_won_this_cycle?'🏆 You won this cycle — rejoining next':'⏸ Not in this draw')+'</div></div>';
  }
  if(r){
    const pct=r.total_members>0?Math.round(r.won_count/r.total_members*100):0;
    html+='<div class="gw-rotation"><div class="gw-rotation-label">Rotation '+r.cycle+' — '+r.eligible_count+' of '+r.total_members+' still eligible</div><div class="gw-bar"><div class="gw-bar-fill" style="width:'+pct+'%"></div></div><div class="gw-rotation-count">'+r.won_count+' member'+(r.won_count!==1?'s':'')+' have won this rotation</div></div>';
  }
  if(hist.length){
    const rows=hist.slice(0,8).map(h=>{
      const w=h.draws?.find(x=>x.status==='active');
      return '<div class="gw-history-row"><div><div style="font-weight:600;color:var(--txt)">'+(esc(w?.winner_name||'—'))+'</div><div style="font-size:11px;color:var(--dim)">'+(esc(h.title)||esc(h.closed_at?.slice(0,7)||''))+'</div></div>'+(h.prize?'<div style="font-size:11px;color:var(--dim)">🎁 '+esc(h.prize)+'</div>':'')+'</div>';
    }).join('');
    html+='<details class="gw-history card" style="padding:14px;margin-bottom:14px"><summary>Past winners ('+hist.length+')</summary>'+rows+'</details>';
  }
  if(isAdmin&&g) html+=gwAdminPanel(g,d);
  else if(isAdmin&&!g) html+=gwAdminCreate();
  return html;
}

function gwTimerHtml(id){
  return '<div class="gw-timer"><div class="gw-unit"><div class="gw-unit-val" id="'+id+'D">--</div><div class="gw-unit-lbl">Days</div></div><div class="gw-unit"><div class="gw-unit-val" id="'+id+'H">--</div><div class="gw-unit-lbl">Hrs</div></div><div class="gw-unit"><div class="gw-unit-val" id="'+id+'M">--</div><div class="gw-unit-lbl">Min</div></div><div class="gw-unit"><div class="gw-unit-val" id="'+id+'S">--</div><div class="gw-unit-lbl">Sec</div></div></div>';
}

function gwParseLocalDate(str){
  // Parse datetime-local strings ("2026-10-01T18:30" or "2026-10-01") as LOCAL
  // time, not UTC — new Date("YYYY-MM-DD") is UTC in browsers and shifts the
  // date by timezone offset. Parsing components explicitly is always local.
  if(!str) return null;
  try{
    const [datePart, timePart='00:00'] = str.split('T');
    const [yr,mo,dy]=datePart.split('-').map(Number);
    const [hr,mn]=(timePart||'00:00').slice(0,5).split(':').map(Number);
    const t=new Date(yr, mo-1, dy, hr||0, mn||0, 0, 0).getTime();
    return isNaN(t)?null:t;
  }catch(e){ return null; }
}

function gwStartCountdown(revealAtStr, prefix, isAdmin, giveawayId, status){
  if(_gwTimer){ clearInterval(_gwTimer); _gwTimer=null; }
  if(!prefix) return;
  const target=gwParseLocalDate(revealAtStr);
  if(!target) return;
  function tick(){
    const diff=target-Date.now();
    if(diff<=0){
      clearInterval(_gwTimer); _gwTimer=null;
      ['D','H','M','S'].forEach(u=>{ const el=$(prefix+u); if(el) el.textContent='0'; });
      if(isAdmin&&status!=='revealed'&&status!=='closed'){
        fetch('/api/giveaway/'+giveawayId+'/draw-and-reveal',{method:'POST'})
          .then(()=>setTimeout(_gwReload,600));
      } else {
        setTimeout(_gwReload,800);
      }
      return;
    }
    const dd=Math.floor(diff/86400000),h=Math.floor((diff%86400000)/3600000);
    const m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);
    if($(prefix+'D')) $(prefix+'D').textContent=dd;
    if($(prefix+'H')) $(prefix+'H').textContent=String(h).padStart(2,'0');
    if($(prefix+'M')) $(prefix+'M').textContent=String(m).padStart(2,'0');
    if($(prefix+'S')) $(prefix+'S').textContent=String(s).padStart(2,'0');
  }
  tick(); _gwTimer=setInterval(tick,1000);
}

function gwWireTimers(d){
  const g=d.giveaway; if(!g) return;
  let prefix=null;
  if(g.status==='drawn'&&!d.is_admin) prefix='gwReveal';
  else if(['open','locked','draft','drawn'].includes(g.status)) prefix='gwDraw';
  gwStartCountdown(g.reveal_at, prefix, d.is_admin, g.id, g.status);
}

function gwAdminCreate(){
  return '<div class="gw-admin" id="gwAdmin"><h3>Admin — New Giveaway</h3>'
    +'<div class="gw-admin-field"><label>Title</label><input type="text" id="gwNewTitle" placeholder="October Giveaway"></div>'
    +'<div class="gw-admin-field"><label>Prize</label><input type="text" id="gwNewPrize" placeholder="PS5 game, $50 PSN card..."></div>'
    +'<div class="gw-admin-field"><label>Reveal date &amp; time</label><input type="datetime-local" id="gwNewReveal"></div>'
    +'<div class="gw-admin-actions"><button class="gw-btn-primary" onclick="gwCreate()">🎁 Start Giveaway</button></div>'
    +'<hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:18px 0">'
    +'<div style="font-size:11px;color:var(--dim);margin-bottom:8px">Danger zone — reset all giveaway data</div>'
    +'<div class="gw-admin-field"><label>Past winner name</label><input type="text" id="gwSeedQuery" placeholder="e.g. mutasif"></div>'
    +'<div class="gw-admin-field"><label>Giveaway title (optional)</label><input type="text" id="gwSeedTitle" placeholder="e.g. October 2026 Giveaway"></div>'
    +'<div class="gw-admin-field"><label>Prize (optional)</label><input type="text" id="gwSeedPrize" placeholder="e.g. Battlefield 6"></div>'
    +'<button class="gw-btn-danger" onclick="gwResetAndSeed()">Reset &amp; Seed</button>'
    +'<div id="gwMsg" style="font-size:12px;margin-top:8px;color:var(--dim)"></div></div>';
}

function gwAdminPanel(g, d){
  const status=g.status;
  const badge='<div class="gw-status-badge gw-status-'+status+'">'+status+'</div>';
  let inner='';
  // Winner preview for drawn/revealed
  if(status==='drawn'||status==='revealed'){
    const w=g.active_draw;
    if(w) inner+='<div class="gw-admin-preview"><div class="gw-ap-lbl">🔒 Winner (admin preview)</div><div class="gw-ap-name">'+esc(w.winner_name)+'</div><div style="font-size:11px;color:var(--dim);margin-top:2px">Draw #'+w.draw_number+' · '+esc(w.manifest_hash||'')+(w.drawn_at?' · '+w.drawn_at.slice(0,10):'')+'</div></div>';
  }
  // Edit form always visible (except closed)
  if(status!=='closed'){
    inner+='<div class="gw-admin-field"><label>Title</label><input type="text" id="gwEditTitle" value="'+esc(g.title||'')+'"></div>'
      +'<div class="gw-admin-field"><label>Prize</label><input type="text" id="gwEditPrize" value="'+esc(g.prize||'')+'"></div>'
      +'<div class="gw-admin-field"><label>Reveal date &amp; time</label><input type="datetime-local" id="gwEditReveal" value="'+(g.reveal_at?g.reveal_at.slice(0,16):'')+'"></div>'
      +'<button class="gw-btn-secondary" onclick="gwUpdate('+g.id+')" style="margin-bottom:12px">Save</button>';
    // Entry management always visible (except closed)
    inner+='<div style="font-size:11px;color:var(--dim);margin-bottom:6px">Entries ('+g.entries.length+')</div>'
      +'<div class="gw-entry-list">'+(g.entries.map(e=>'<div class="gw-entry-row"><span>'+esc(e.display_name)+'</span><button class="gw-entry-remove" onclick="gwRemoveEntry('+g.id+',\''+esc(e.member_id)+'\',\''+esc(e.display_name)+'\')">×</button></div>').join('')||'<div style="font-size:12px;color:var(--dim);padding:4px">No entries yet — publish to auto-populate from rotation</div>')+'</div>';
    const allPortal=(d.rotation?.all_members||d.rotation?.eligible||[]);
    const avail=allPortal.filter(m=>!g.entries.find(e=>e.member_id===m.id));
    if(avail.length) inner+='<div class="gw-admin-field"><label>Add member</label><select id="gwAddEntry">'+avail.map(m=>'<option value="'+esc(m.id)+'" data-display="'+esc(m.display)+'">'+esc(m.display)+'</option>').join('')+'</select></div><button class="gw-btn-secondary" onclick="gwAddEntry('+g.id+')" style="margin-bottom:12px">Add to draw</button>';
  }
  // State actions
  const actions=[];
  if(status==='draft') actions.push('<button class="gw-btn-primary" onclick="gwPublish('+g.id+')">Publish Giveaway</button>');
  if(status==='open'||status==='locked') actions.push('<button class="gw-btn-primary" onclick="gwDrawAndReveal('+g.id+')">🎲 Draw &amp; Reveal Winner</button>');
  if(status==='drawn') actions.push('<button class="gw-btn-primary" onclick="gwDrawAndReveal('+g.id+')">🎉 Reveal Winner Now</button>');
  if(status==='revealed') actions.push('<button class="gw-btn-secondary" onclick="gwClose('+g.id+')">Close Giveaway</button>','<button class="gw-btn-danger" onclick="gwRedraw('+g.id+')">Disqualify &amp; Redraw</button>');
  return '<div class="gw-admin" id="gwAdmin"><h3>Admin</h3>'+badge+inner+'<div class="gw-admin-actions">'+actions.join('')+'</div><div id="gwMsg" style="font-size:12px;margin-top:8px;color:var(--dim)"></div></div>';
}

function gwConfetti(durationMs){
  if(_gwConfettiStop){ _gwConfettiStop(); _gwConfettiStop=null; }
  const canvas=document.createElement('canvas');
  canvas.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9000';
  document.body.appendChild(canvas);
  const ctx=canvas.getContext('2d');
  canvas.width=window.innerWidth; canvas.height=window.innerHeight;
  const colors=['#ff2fd6','#9d5cff','#22e6ff','#ffd700','#ff6b6b','#51cf66'];
  const particles=Array.from({length:160},()=>({
    x:Math.random()*canvas.width, y:Math.random()*canvas.height-canvas.height,
    r:5+Math.random()*7, spd:1.5+Math.random()*3,
    color:colors[Math.floor(Math.random()*colors.length)],
    tiltA:0, tiltSpd:.08+Math.random()*.1, shape:Math.random()>.5?'rect':'circle',
  }));
  let running=true, frame, startTime=Date.now();
  function draw(){
    if(!running) return;
    if(Date.now()-startTime>durationMs){ _gwConfettiStop(); return; }
    ctx.clearRect(0,0,canvas.width,canvas.height);
    particles.forEach(p=>{
      p.tiltA+=p.tiltSpd; p.y+=p.spd; p.x+=Math.sin(p.tiltA);
      if(p.y>canvas.height+20){ p.y=-10; p.x=Math.random()*canvas.width; }
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(Math.sin(p.tiltA)*.3);
      ctx.fillStyle=p.color; ctx.globalAlpha=.85;
      if(p.shape==='rect') ctx.fillRect(-p.r/2,-p.r*.3,p.r,p.r*.6);
      else{ ctx.beginPath(); ctx.arc(0,0,p.r*.5,0,Math.PI*2); ctx.fill(); }
      ctx.restore();
    });
    frame=requestAnimationFrame(draw);
  }
  draw();
  _gwConfettiStop=()=>{ running=false; cancelAnimationFrame(frame); canvas.remove(); };
}

async function gwMsg(msg,ok=true){
  const el=$('gwMsg'); if(!el)return;
  el.style.color=ok?'var(--neon)':'#ff8080'; el.textContent=msg;
  setTimeout(()=>{ if(el) el.textContent=''; },3500);
}
function _gwReload(){ _gwLoaded=false; $('giveaway-inner').innerHTML='<div class="spin">Loading...</div>'; loadGiveaway(); }

async function gwCreate(){
  const title=($('gwNewTitle')||{}).value?.trim()||'',prize=($('gwNewPrize')||{}).value?.trim()||'';
  const reveal_at=($('gwNewReveal')||{}).value||'';
  const r=await fetch('/api/giveaway',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,prize,reveal_at:reveal_at||null})});
  const d=await r.json();
  if(!r.ok){ gwMsg(d.detail||'Error',false); return; }
  // Auto-publish so countdown starts immediately
  const r2=await fetch('/api/giveaway/'+d.id+'/publish',{method:'POST'});
  const d2=await r2.json();
  if(r2.ok){ gwMsg('Giveaway started — '+d2.entries+' members entered ✓'); _gwReload(); }
  else gwMsg(d2.detail||d2.error||'Error publishing',false);
}
async function gwUpdate(id){
  const title=($('gwEditTitle')||{}).value?.trim()||'',prize=($('gwEditPrize')||{}).value?.trim()||'';
  const reveal_at=($('gwEditReveal')||{}).value||'';
  const r=await fetch('/api/giveaway/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,prize,reveal_at:reveal_at||null})});
  const d=await r.json();
  if(r.ok){
    gwMsg('Saved ✓');
    // Restart countdown immediately with new date — don't wait for full reload
    if(reveal_at){
      const g=d; // PUT returns updated giveaway
      const prefix=['open','locked','draft','drawn'].includes(g.status)?'gwDraw':null;
      gwStartCountdown(reveal_at, prefix, true, id, g.status);
    }
    _gwReload();
  } else gwMsg(d.detail||'Error',false);
}
async function gwPublish(id){ const r=await fetch('/api/giveaway/'+id+'/publish',{method:'POST'}); const d=await r.json(); if(r.ok){ gwMsg('Published — '+d.entries+' members eligible ✓'); _gwReload(); } else gwMsg(d.detail||d.error||'Error',false); }
async function gwLock(id){ const r=await fetch('/api/giveaway/'+id+'/lock',{method:'POST'}); if(r.ok){ gwMsg('Entries locked ✓'); _gwReload(); } else{ const d=await r.json(); gwMsg(d.detail||'Error',false); } }
async function gwDraw(id){ const r=await fetch('/api/giveaway/'+id+'/draw',{method:'POST'}); const d=await r.json(); if(r.ok){ gwMsg('Winner drawn ✓'); _gwReload(); } else gwMsg(d.detail||d.error||'Error',false); }
async function gwReveal(id){ const r=await fetch('/api/giveaway/'+id+'/reveal',{method:'POST'}); if(r.ok){ gwMsg('Winner revealed! 🎉'); _gwReload(); } else{ const d=await r.json(); gwMsg(d.detail||'Error',false); } }
async function gwDrawAndReveal(id){ const r=await fetch('/api/giveaway/'+id+'/draw-and-reveal',{method:'POST'}); if(r.ok){ gwMsg('Winner revealed! 🎉'); _gwReload(); } else{ const d=await r.json(); gwMsg(d.detail||d.error||'Error',false); } }
async function gwClose(id){ if(!confirm('Close this giveaway?')) return; const r=await fetch('/api/giveaway/'+id+'/close',{method:'POST'}); if(r.ok){ gwMsg('Closed ✓'); _gwReload(); } else{ const d=await r.json(); gwMsg(d.detail||'Error',false); } }
async function gwRedraw(id){
  const reason=prompt('Reason for redraw?\n\n- Winner declined\n- Winner ineligible\n- Testing\n- Other');
  if(!reason) return;
  const r=await fetch('/api/giveaway/'+id+'/redraw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});
  const d=await r.json(); if(r.ok){ gwMsg('Redrawn ✓'); _gwReload(); } else gwMsg(d.detail||d.error||'Error',false);
}
async function gwAddEntry(id){
  const sel=$('gwAddEntry'); if(!sel||!sel.value) return;
  const mid=sel.value, display=sel.selectedOptions[0]?.dataset?.display||sel.selectedOptions[0]?.textContent||mid;
  const r=await fetch('/api/giveaway/'+id+'/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({member_id:mid,display_name:display})});
  if(r.ok){ gwMsg('Added ✓'); _gwReload(); } else gwMsg('Error',false);
}
async function gwRemoveEntry(id,mid,name){
  if(!confirm('Remove '+name+' from this draw?')) return;
  const r=await fetch('/api/giveaway/'+id+'/entries/'+encodeURIComponent(mid),{method:'DELETE'});
  if(r.ok){ gwMsg('Removed ✓'); _gwReload(); } else gwMsg('Error',false);
}
async function gwResetAndSeed(){
  const q=($('gwSeedQuery')||{}).value?.trim();
  if(!q) return;
  const title=($('gwSeedTitle')||{}).value?.trim()||'';
  const prize=($('gwSeedPrize')||{}).value?.trim()||'';
  if(!confirm('This will DELETE all giveaway data and rotation history, then add "'+q+'" as the only past winner. Are you sure?')) return;
  const r=await fetch('/api/giveaway/admin/reset-and-seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({winner_query:q,title,prize})});
  const d=await r.json();
  if(r.ok){ gwMsg('Reset complete. Seeded: '+d.seeded_winner.display+' ✓'); _gwReload(); }
  else if(d.error==='ambiguous'){ gwMsg('Multiple matches: '+d.matches.map(m=>m.display).join(', ')+' — be more specific',false); }
  else if(d.error==='no_match'){ gwMsg('No member found matching "'+q+'"',false); }
  else gwMsg(d.detail||d.error||'Error',false);
}

// ── Watch Party ──────────────────────────────────────────────────────────────
// Identity is never asserted here. We ask the server for a short-lived signed
// Watch Ticket and hand it to WatchParty in the Socket.IO handshake; the display
// name and viewer id both come back from the server, never from this page.
const WP = {
  cfg:null, sock:null, room:'', clientId:'', names:{}, roster:[], me:'', myName:'Viewer',
  video:'', kind:'', yt:null, ytLoading:null, hls:null, hlsLoading:null, applying:0, tsTimer:null,
  booted:false, tries:0, reconnectTimer:null, presence:null, chat:[], pendingTS:0,
};
const WP_MAX_TRIES = 6;

function wpErr(msg){
  const e=$('wpErr'); if(!e) return;
  e.textContent = msg || ''; e.classList.toggle('on', !!msg);
}
function wpStatus(txt, live){
  const p=$('wpPresence'), t=$('wpPresenceTxt');
  if(t) t.textContent = txt;
  if(p) p.classList.toggle('off', !live);
}

// Per-*tab* client id: WatchParty kicks an older socket sharing a clientId, and
// one person with two tabs is still one viewer (that's the ticket's viewerId).
function wpClientId(){
  let id = sessionStorage.getItem('crcmzWatchClientId');
  if(!id){
    id = (crypto.randomUUID ? crypto.randomUUID()
      : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>
          (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c/4)))).toString(16)));
    sessionStorage.setItem('crcmzWatchClientId', id);
  }
  return id;
}
function wpSessionId(){
  let id = localStorage.getItem('crcmzWatchSessionId');
  if(!id){ id = wpClientId(); localStorage.setItem('crcmzWatchSessionId', id); }
  return id;
}

function wpScript(src){
  return new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=src; s.async=true; s.onload=res; s.onerror=()=>rej(new Error('load '+src));
    document.head.appendChild(s);
  });
}

async function loadWatch(){
  if(WP.booted){
    if(WP.sock && !WP.sock.connected){ WP.tries=0; wpConnect(); }
    else if(!WP.sock){ WP.booted=false; loadWatch(); } // failed before socket was created
    return;
  }
  WP.booted = true;
  wpStatus('connecting…', false);
  let cfg;
  try{
    const r = await fetch('/api/watch/config', {headers:{'Accept':'application/json'}});
    if(r.status===401){ location.href='/auth/login?next='+encodeURIComponent('/?p=watch'); return; }
    if(!r.ok) throw new Error('config '+r.status);
    cfg = await r.json();
  }catch(e){
    WP.booted=false; wpStatus('offline', false);
    wpErr('Watch Party is not available right now.'); return;
  }
  WP.cfg = cfg;
  WP.room = cfg.defaultRoom || 'crcmz';
  WP.me = cfg.viewer?.id || '';
  WP.myName = cfg.viewer?.name || 'Viewer';
  WP.clientId = wpClientId();
  if(typeof window.io === 'undefined'){
    const base = (cfg.origin||'') + (cfg.socketPath||'/socket.io');
    try{ await wpScript(base + '/socket.io.js'); }
    catch(e){
      WP.booted=false; wpStatus('offline', false);
      wpErr('Could not load the watch party client.'); return;
    }
  }
  wpConnect();
}

async function wpTicket(){
  const r = await fetch('/api/watch/join', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({roomId: WP.room}),
  });
  if(r.status===401){ location.href='/auth/login?next='+encodeURIComponent('/?p=watch'); return null; }
  if(!r.ok){
    let detail=''; try{ detail=(await r.json()).detail||''; }catch(e){}
    throw new Error(detail || ('join '+r.status));
  }
  const d = await r.json();
  if(d.viewer?.name) WP.myName = d.viewer.name;
  return d.ticket;
}

async function wpConnect(){
  clearTimeout(WP.reconnectTimer); WP.reconnectTimer=null;
  let ticket;
  try{ ticket = await wpTicket(); }
  catch(e){ wpErr(e.message || 'Could not join the watch party.'); wpRetry(e.message||''); return; }
  if(!ticket){ WP.booted=false; return; } // 401 → navigating to login
  wpErr('');

  if(WP.sock){ WP.sock.removeAllListeners(); WP.sock.close(); WP.sock=null; }
  const ns = (WP.cfg.origin||'') + '/' + WP.room;
  WP.sock = io(ns, {
    transports:['websocket'],
    path: WP.cfg.socketPath || '/socket.io',
    // Ticket goes in the handshake auth payload — never a query param or URL.
    auth: { watchTicket: ticket, sessionId: wpSessionId() },
    query: { clientId: WP.clientId, roomId: WP.room, password:'', shard:'' },
    reconnection: false,   // we re-ticket ourselves, with bounded backoff
    withCredentials: true,
  });
  wpBind(WP.sock);
}

function wpRetry(reason){
  if(WP.reconnectTimer) return;
  if(WP.tries >= WP_MAX_TRIES){
    wpStatus('disconnected', false);
    wpErr('Lost the connection to the watch party. ' + (reason||''));
    wpChatSys('Disconnected. Switch tabs back to Watch to retry.');
    WP.booted = false;   // next loadWatch() starts over
    return;
  }
  const delay = Math.min(30000, 1000 * Math.pow(2, WP.tries));
  WP.tries += 1;
  wpStatus('reconnecting…', false);
  WP.reconnectTimer = setTimeout(()=>{ WP.reconnectTimer=null; wpConnect(); }, delay);
}

function wpBind(s){
  // Watchdog: if the socket is created but neither connect nor connect_error
  // fires within 15s (e.g. WebSocket upgrade silently hangs on mobile), force
  // a retry so the user isn't stuck on "connecting" indefinitely.
  const watchdog = setTimeout(()=>{
    if(WP.sock === s && !s.connected) wpRetry('Connection timed out');
  }, 15000);
  const clearWatchdog = ()=> clearTimeout(watchdog);

  s.on('connect', ()=>{
    clearWatchdog();
    WP.tries = 0; wpErr('');
    wpStatus('connected', true);
    wpMiniSync();
    s.emit('watch:presence:get');
    s.emit('CMD:askHost');
    if(WP.tsTimer) clearInterval(WP.tsTimer);
    WP.tsTimer = setInterval(()=>{
      if(!s.connected) return;
      const t = wpTime(); if(t !== null) s.emit('CMD:ts', t);
    }, 1000);
  });
  s.on('connect_error', (err)=>{
    clearWatchdog();
    const code = String(err?.message||'');
    if(code==='AUTH_REQUIRED' || code==='INVALID_WATCH_TICKET' || code==='WRONG_ROOM'){
      // Ticket problem, not a network problem: a fresh one may work once.
      wpErr('Watch pass rejected — refreshing your sign-in.');
      wpRetry('');
      return;
    }
    wpRetry(code);
  });
  s.on('disconnect', ()=>{
    clearWatchdog();
    if(WP.tsTimer){ clearInterval(WP.tsTimer); WP.tsTimer=null; }
    // Peer connections are addressed by socket id server-side, so they're all
    // dead now. Our own camera stays on and re-announces once we're back.
    WP.roster = [];
    wpDropAllPeers();
    wpStatus('reconnecting…', false);
    wpMiniSync();
    wpRetry('');
  });
  s.on('errorMessage', m => wpErr(String(m||'')));
  s.on('watch:presence', d => { WP.presence = d; wpRenderPresence(); });
  // nameMap only supplies display names — it is never pruned, so it must not
  // decide who is in the room. `roster` is the live list.
  s.on('REC:nameMap', m => { WP.names = m||{}; wpRenderChat(); wpRenderOrbs(); });
  s.on('roster', arr => {
    WP.roster = Array.isArray(arr) ? arr : [];
    wpReconcilePeers(); wpRenderOrbs();
  });
  // WebRTC handshake for the camera orbs, relayed by clientId.
  s.on('signal', d => wpOnSignal(d && d.from, d && d.msg));
  s.on('REC:host', h => wpApplyHost(h||{}));
  s.on('REC:play', url => { if(url && url!==WP.video) wpMount(url); wpRemote(()=>wpPlay()); });
  s.on('REC:pause', () => wpRemote(()=>wpPause()));
  s.on('REC:seek', ts => wpRemote(()=>wpSeek(Number(ts))));
  s.on('REC:playbackRate', r => { const v=$('wpVideo'); if(v && Number(r)) v.playbackRate=Number(r); });
  s.on('chatinit', arr => { WP.chat = Array.isArray(arr)?arr.slice(-60):[]; wpRenderChat(); });
  s.on('REC:chat', m => { WP.chat.push(m); WP.chat=WP.chat.slice(-60); wpRenderChat(); });
}

// ── presence ────────────────────────────────────────────────────────────────
function wpRenderPresence(){
  const d = WP.presence || {count:0, viewers:[]};
  wpStatus(d.count===1 ? '1 watching' : d.count+' watching', d.count>0);
  wpRenderOrbs();
  wpMiniSync();
}

// ── camera orbs ─────────────────────────────────────────────────────────────
// Peer-to-peer video between viewers, meshed. WatchParty already relays a
// `signal` event between clientIds, so this needs no server-side change; we
// just define our own message types on top of it. Mesh (rather than an SFU)
// is the right call for a watch party: everyone uploads to everyone, which is
// fine at party scale and needs no media server.
const WPC = {
  stream:null,      // our local MediaStream (video + mic)
  on:false,         // are we publishing
  muted:false,      // is our mic muted
  peers:{},         // clientId -> {pc, polite, makingOffer, ignoreOffer, stream}
  remoteCam:{},     // clientId -> did they announce a camera
  levels:{},        // 'me'|clientId -> {ctx, an, data, loud}  (speaking detection)
  timer:0,
  busy:false,
  gesture:false,
  camFs:false,      // is the fullscreen camera grid open
  facingMode:'user',// 'user' (front) or 'environment' (back)
};
const WP_ICE = [{ urls:[
  'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302',
]}];
// The orbs are ~66px, so a tiny stream looks identical to a big one and keeps
// the mesh affordable on phone uplinks.
const WP_CAM_BITRATE = 260000;

function wpSignal(to, msg){
  if(WP.sock && WP.sock.connected) WP.sock.emit('signal', {to, msg});
}

// Live peers, excluding ourselves.
//
// This MUST come from `roster`, which the server adds to on connect and splices
// on disconnect. `REC:nameMap` looks similar but is chat attribution: it is
// never pruned and is even persisted across restarts, so it lists everyone who
// has *ever* been in the room.
function wpLive(){
  return (WP.roster||[])
    .map(u => u && u.id)
    .filter(id => id && id !== WP.clientId);
}

function wpAnnounceCam(on){
  wpLive().forEach(id=> wpSignal(id, {t:'cam', on:!!on}));
}

// ── local camera ────────────────────────────────────────────────────────────
async function wpToggleCam(){
  if(WPC.busy) return;
  WPC.busy = true;
  try{
    if(WPC.on){ wpCamStop(); return; }
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia
       || !window.RTCPeerConnection){
      wpCamNote('This browser can\'t share a camera.'); return;
    }
    wpCamNote('Asking for camera permission…');
    let stream;
    try{
      stream = await navigator.mediaDevices.getUserMedia({
        video:{ width:{ideal:320}, height:{ideal:320},
                frameRate:{ideal:15,max:20}, facingMode:'user' },
        audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true },
      });
    }catch(e){
      const n = (e && e.name) || '';
      wpCamNote(
        n==='NotAllowedError' ? 'Camera blocked — allow it in your browser settings.' :
        n==='NotFoundError'   ? 'No camera found on this device.' :
        n==='NotReadableError'? 'Your camera is in use by another app.' :
                                'Could not start the camera.');
      return;
    }
    WPC.muted = false;
    WPC.stream = stream; WPC.on = true;

    // A camera can be revoked from the OS/browser mid-call.
    stream.getVideoTracks().forEach(t=>{
      t.addEventListener('ended', ()=>{ if(WPC.on) wpCamStop(); });
    });
    // The mic can be revoked independently (phone call, iOS background, another
    // app grabbing the mic). When that happens the audio track ends silently —
    // video keeps working so wpCamStop never fires, but no audio transmits.
    // Remount just the mic without touching ICE or the video track.
    stream.getAudioTracks().forEach(t=>{
      t.addEventListener('ended', ()=>{ if(WPC.on) wpRemountMic(); });
    });

    wpMeter('me', stream);
    wpAnnounceCam(true);
    wpLive().forEach(id=> wpPeer(id, true));
    Object.keys(WPC.peers).forEach(id=> wpSyncTracks(WPC.peers[id]));
    wpCamSync();
  } finally { WPC.busy = false; }
}

function wpCamStop(){
  WPC.on = false;
  WPC.muted = false;
  wpAnnounceCam(false);
  Object.keys(WPC.peers).forEach(id=>{
    // Keep the connection if they're still sending us video; otherwise there's
    // nothing left to exchange, so drop it entirely.
    if(WPC.remoteCam[id]) wpSyncTracks(WPC.peers[id]);
    else wpDropPeer(id);
  });
  if(WPC.stream){ WPC.stream.getTracks().forEach(t=>t.stop()); WPC.stream = null; }
  wpMeterStop('me');
  wpCamSync();
}

async function wpRemountMic(){
  if(!WPC.on || !WPC.stream) return;
  let newTrack;
  try{
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true },
    });
    newTrack = fresh.getAudioTracks()[0];
  }catch(e){
    wpCamNote('Mic disconnected — tap 🎤 to refresh.');
    return;
  }
  if(!newTrack || !WPC.on) return;

  // Swap into every sender without renegotiating ICE (video keeps flowing).
  await Promise.all(Object.values(WPC.peers).map(async p=>{
    const s = p.pc.getSenders().find(s=> s.track && s.track.kind==='audio');
    if(s) await s.replaceTrack(newTrack).catch(()=>{});
  }));

  // Replace in the local stream so wpSyncTracks and mute toggle see the right track.
  WPC.stream.getAudioTracks().forEach(t=>{ try{t.stop();}catch(e){} WPC.stream.removeTrack(t); });
  WPC.stream.addTrack(newTrack);

  newTrack.enabled = !WPC.muted;
  newTrack.addEventListener('ended', ()=>{ if(WPC.on) wpRemountMic(); });

  wpMeterStop('me');
  wpMeter('me', WPC.stream);
  wpCamNote('');
}

function wpCamSync(){
  const b=$('wpCamBtn'), p=$('wpPttBtn'), flip=$('wpFlipBtn');
  if(b) b.textContent = WPC.on ? '📷 Turn off camera' : '📷 Turn on camera';
  if(p){
    p.style.display = WPC.on ? '' : 'none';
    p.textContent = WPC.muted ? '🔇 Unmute' : '🎤 Mute';
    p.classList.toggle('hot', WPC.muted);
    if(WPC.on) wpMuteWire();
  }
  if(flip) flip.style.display = WPC.on ? '' : 'none';
  wpCamNote('');
  wpRenderOrbs();
  wpMiniSync();
}
function wpCamNote(msg){
  const n=$('wpCamNote'); if(!n) return;
  n.textContent = msg !== '' ? msg
    : (WPC.on ? (WPC.muted ? 'Mic muted — tap 🔇 to unmute.' : 'Mic live — tap 🎤 to mute.') : '');
}

// ── mute toggle ─────────────────────────────────────────────────────────────
function wpToggleMute(){
  if(!WPC.on || !WPC.stream) return;
  WPC.muted = !WPC.muted;
  WPC.stream.getAudioTracks().forEach(t=>{ t.enabled = !WPC.muted; });
  wpCamSync();
  wpOrbState();
}
function wpMuteWire(){
  const b=$('wpPttBtn');
  if(!b || b.dataset.wired) return;
  b.dataset.wired = '1';
  b.addEventListener('click', ()=> wpToggleMute());
  addEventListener('keydown', e=>{
    if(e.repeat || String(e.key).toLowerCase()!=='m') return;
    const t=e.target; if(t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    wpToggleMute();
  });
}

// ── Watch Party mini-bar ─────────────────────────────────────────────────────
function wpMiniSync(){
  const bar = $('wpMiniBar'); if(!bar) return;
  const watchActive = !!($('p-watch') && $('p-watch').classList.contains('on'));
  const connected = !!(WP.sock && WP.sock.connected);
  const shouldShow = connected && !watchActive;

  const wasOn = bar.classList.contains('on');
  bar.classList.toggle('on', shouldShow);

  if(shouldShow){
    const sub = $('wpMiniSub');
    if(sub){
      const viewers = (WP.presence && WP.presence.viewers) || [];
      const others = viewers.filter(v => v.id !== WP.clientId);
      if(!others.length){
        sub.textContent = 'just you';
      } else {
        const names = others.map(v => v.name || 'Viewer').slice(0, 2);
        const extra = others.length - names.length;
        sub.textContent = names.join(', ') + (extra > 0 ? ' +'+extra : '');
      }
    }
    const mBtn = $('wpMiniMute');
    if(mBtn){
      mBtn.style.display = WPC.on ? '' : 'none';
      mBtn.textContent = WPC.muted ? '🔇 Muted' : '🎤 Live';
      mBtn.classList.toggle('muted', WPC.muted);
    }
  }

  if(wasOn !== shouldShow) syncBoardHeight();
}

function wpMiniGoWatch(){
  const btn = document.querySelector('.nav-item[data-p="watch"]');
  if(btn) { btn.click(); loadWatch(); }
}

// Hook tab() so the mini-bar shows/hides on every navigation.
// tab() is a function declaration; reassigning after parse-time is safe in JS.
(function(){
  const _origTab = tab;
  tab = function(btn, skipHash){ _origTab(btn, skipHash); wpMiniSync(); };
})();

// ── camera fullscreen grid ────────────────────────────────────────────────────
function wpFsOpen(){
  const el=$('wpCamFs'); if(!el) return;
  WPC.camFs = true;
  el.classList.add('open');
  const flip=$('wpFlipBtn'); if(flip) flip.style.display = WPC.on ? '' : 'none';
  wpRenderOrbs();
  document.body.style.overflow = 'hidden';
}
function wpFsClose(){
  const el=$('wpCamFs'); if(!el) return;
  WPC.camFs = false;
  el.classList.remove('open');
  // Detach srcObjects so they don't linger; the compact strip keeps its own copies.
  const fsBox=$('wpOrbsFs');
  if(fsBox){ fsBox.querySelectorAll('video').forEach(v=>{ v.srcObject=null; }); fsBox.innerHTML=''; }
  document.body.style.overflow = '';
}

// ESC closes the fullscreen grid
addEventListener('keydown', e=>{ if(e.key==='Escape' && WPC.camFs) wpFsClose(); });

async function wpFlipCam(){
  if(!WPC.on || WPC.busy) return;
  WPC.busy = true;
  const next = WPC.facingMode === 'environment' ? 'user' : 'environment';
  try{
    let newTrack;
    try{
      // Use {exact} first so we get the true back/front camera on multi-camera phones.
      const s = await navigator.mediaDevices.getUserMedia({
        video:{ width:{ideal:320}, height:{ideal:320},
                frameRate:{ideal:15,max:20}, facingMode:{exact:next} }
      });
      newTrack = s.getVideoTracks()[0];
    }catch(e){
      // Single-camera device or permission issue — try without exact.
      try{
        const s2 = await navigator.mediaDevices.getUserMedia({
          video:{ width:{ideal:320}, height:{ideal:320},
                  frameRate:{ideal:15,max:20}, facingMode:next }
        });
        newTrack = s2.getVideoTracks()[0];
      }catch(e2){ wpCamNote('Could not flip camera.'); return; }
    }
    if(!newTrack) return;

    // Swap into every peer sender — no ICE renegotiation needed.
    await Promise.all(Object.values(WPC.peers).map(async p=>{
      const s = p.pc.getSenders().find(s=> s.track && s.track.kind==='video');
      if(s) await s.replaceTrack(newTrack).catch(()=>{});
    }));

    // Replace in the local stream so the preview video picks up the new track.
    WPC.stream.getVideoTracks().forEach(t=>{ try{t.stop();}catch(e){} WPC.stream.removeTrack(t); });
    WPC.stream.addTrack(newTrack);
    newTrack.addEventListener('ended', ()=>{ if(WPC.on) wpCamStop(); });

    WPC.facingMode = next;
    // Mirror front camera, don't mirror back camera.
    document.querySelectorAll('[data-k="me"]').forEach(el=>{
      el.classList.toggle('no-mirror', next === 'environment');
    });
  }finally{ WPC.busy = false; }
}

// ── peer connections (perfect negotiation) ──────────────────────────────────
function wpPeer(id, create){
  let p = WPC.peers[id];
  if(p) return p;
  if(!create || !id || id===WP.clientId) return null;

  const pc = new RTCPeerConnection({ iceServers:WP_ICE, bundlePolicy:'max-bundle' });
  // "Polite" peer yields on an offer collision. Comparing clientIds gives both
  // sides the same answer without another round trip.
  p = { pc, polite: WP.clientId > id, makingOffer:false, ignoreOffer:false, stream:null };
  WPC.peers[id] = p;

  pc.onnegotiationneeded = async ()=>{
    try{
      p.makingOffer = true;
      await pc.setLocalDescription();
      wpSignal(id, {t:'sdp', sdp:pc.localDescription});
    }catch(e){}
    finally{ p.makingOffer = false; }
  };
  pc.onicecandidate = (ev)=>{
    if(ev.candidate) wpSignal(id, {t:'ice', ice:ev.candidate});
  };
  pc.ontrack = (ev)=>{
    p.stream = ev.streams[0] || p.stream;
    // A remote track arrives muted and unmutes once media actually flows, so
    // the orb has to re-render then or it would sit on the initials forever.
    ['unmute','mute','ended'].forEach(n=>
      ev.track.addEventListener(n, ()=> wpRenderOrbs()));
    if(p.stream){ wpMeter(id, p.stream); wpRenderOrbs(); }
  };
  pc.onconnectionstatechange = ()=>{
    if(pc.connectionState==='failed'){ wpDropPeer(id); }
    wpRenderOrbs();
  };
  wpSyncTracks(p);
  return p;
}

// Idempotent: makes the peer's published tracks match what we're sending now.
// Adding or removing fires onnegotiationneeded, so this is the only thing that
// needs to be called when our camera turns on or off.
function wpSyncTracks(p){
  if(!p) return;
  const want = (WPC.on && WPC.stream) ? WPC.stream.getTracks() : [];
  p.pc.getSenders().forEach(s=>{
    if(s.track && want.indexOf(s.track) === -1){
      try{ p.pc.removeTrack(s); }catch(e){}
    }
  });
  want.forEach(t=>{
    const already = p.pc.getSenders().some(s=> s.track === t);
    if(already) return;
    try{
      const sender = p.pc.addTrack(t, WPC.stream);
      if(t.kind==='video') wpCapBitrate(sender);
    }catch(e){}
  });
}

async function wpCapBitrate(sender){
  try{
    const prm = sender.getParameters();
    prm.encodings = (prm.encodings && prm.encodings.length) ? prm.encodings : [{}];
    prm.encodings[0].maxBitrate = WP_CAM_BITRATE;
    prm.encodings[0].maxFramerate = 20;
    await sender.setParameters(prm);
  }catch(e){}
}

function wpDropPeer(id){
  const p = WPC.peers[id]; if(!p) return;
  try{
    p.pc.onnegotiationneeded=null; p.pc.onicecandidate=null;
    p.pc.ontrack=null; p.pc.onconnectionstatechange=null;
    p.pc.close();
  }catch(e){}
  delete WPC.peers[id];
  wpMeterStop(id);
}
function wpDropAllPeers(){
  Object.keys(WPC.peers).forEach(wpDropPeer);
  WPC.remoteCam = {};
  wpRenderOrbs();
}

async function wpOnSignal(from, msg){
  if(!from || from===WP.clientId || !msg) return;

  if(msg.t==='cam'){
    WPC.remoteCam[from] = !!msg.on;
    if(msg.on) wpPeer(from, true);
    else if(!WPC.on) wpDropPeer(from);
    wpRenderOrbs();
    return;
  }
  // Only negotiate with peers one of us actually wants media from.
  const p = wpPeer(from, WPC.on || !!WPC.remoteCam[from]);
  if(!p) return;
  const pc = p.pc;
  try{
    if(msg.t==='sdp' && msg.sdp){
      const collision = msg.sdp.type==='offer' &&
        (p.makingOffer || pc.signalingState!=='stable');
      p.ignoreOffer = !p.polite && collision;
      if(p.ignoreOffer) return;
      await pc.setRemoteDescription(msg.sdp);
      if(msg.sdp.type==='offer'){
        await pc.setLocalDescription();
        wpSignal(from, {t:'sdp', sdp:pc.localDescription});
      }
    } else if(msg.t==='ice' && msg.ice){
      try{ await pc.addIceCandidate(msg.ice); }
      catch(e){ if(!p.ignoreOffer) throw e; }
    }
  }catch(e){}
}

// Roster changed: drop people who left, greet people who arrived.
function wpReconcilePeers(){
  const alive = {};
  wpLive().forEach(id=>{ alive[id] = 1; });
  Object.keys(WPC.peers).forEach(id=>{ if(!alive[id]) wpDropPeer(id); });
  Object.keys(WPC.remoteCam).forEach(id=>{ if(!alive[id]) delete WPC.remoteCam[id]; });
  if(!WPC.on) return;
  Object.keys(alive).forEach(id=>{
    if(WPC.peers[id]) return;
    wpSignal(id, {t:'cam', on:true});
    wpPeer(id, true);
  });
}

// ── speaking detection ──────────────────────────────────────────────────────
function wpMeter(key, stream){
  if(!stream || !stream.getAudioTracks().length) return;
  const cur = WPC.levels[key];
  if(cur && cur.stream === stream) return;   // ontrack fires per track; only meter once
  wpMeterStop(key);
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return;
    const ctx = new Ctx();
    // A context created outside a user gesture can start suspended.
    if(ctx.state === 'suspended') ctx.resume().catch(()=>{});
    const an = ctx.createAnalyser();
    an.fftSize = 512; an.smoothingTimeConstant = .6;
    ctx.createMediaStreamSource(stream).connect(an);
    WPC.levels[key] = { ctx, an, stream,
      data:new Uint8Array(an.frequencyBinCount), loud:false };
    wpMeterRun();
  }catch(e){}
}
function wpMeterStop(key){
  const m = WPC.levels[key]; if(!m) return;
  try{ m.ctx.close(); }catch(e){}
  delete WPC.levels[key];
}
function wpMeterRun(){
  if(WPC.timer) return;
  // 8 Hz is plenty to drive a glow and costs far less than requestAnimationFrame.
  WPC.timer = setInterval(()=>{
    const keys = Object.keys(WPC.levels);
    if(!keys.length){ clearInterval(WPC.timer); WPC.timer=0; return; }
    let changed = false;
    keys.forEach(k=>{
      const m = WPC.levels[k];
      m.an.getByteFrequencyData(m.data);
      let sum=0; for(let i=0;i<m.data.length;i++) sum += m.data[i];
      const loud = (sum / m.data.length) > 18;
      if(loud !== m.loud){ m.loud = loud; changed = true; }
    });
    if(changed) wpOrbState();
  }, 120);
}

// ── orb rendering ───────────────────────────────────────────────────────────
function wpInitials(name){
  const parts = String(name||'').trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return '?';
  if(parts.length===1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}
function wpTint(seed){
  let h=0; const s=String(seed||'');
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  const a = h % 360;
  return 'linear-gradient(145deg, hsl('+a+' 60% 27%), hsl('+((a+58)%360)+' 55% 15%))';
}
function wpOrbRoster(){
  const names = WP.names || {};
  const out = [{k:'me', id:WP.clientId, name:WP.myName||'You', me:true}];
  wpLive().forEach(id=>{
    out.push({k:id, id, name:names[id]||'Viewer', me:false});
  });
  return out;
}
function wpOrbBadge(v){
  if(v.me) return WPC.on ? (WPC.muted ? '🔇' : '🎤') : '';
  const p = WPC.peers[v.id];
  if(!p) return '';
  if(p.pc.connectionState==='connected') return p.stream ? '📷' : '';
  if(p.pc.connectionState==='failed') return '⚠️';
  return (WPC.remoteCam[v.id] || WPC.on) ? '⋯' : '';
}

// Reconciling render: <video> elements are reused in place, because replacing
// one drops its stream and makes the feed flicker on every roster update.
function wpRenderOrbs(){
  _wpRenderOrbsInto($('wpOrbs'));
  if(WPC.camFs) _wpRenderOrbsInto($('wpOrbsFs'));
  wpOrbState();
}

function _wpRenderOrbsInto(box){
  if(!box) return;
  const roster = wpOrbRoster();
  const existing = {};
  Array.from(box.children).forEach(el=>{
    if(el.dataset && el.dataset.k) existing[el.dataset.k] = el;
  });

  roster.forEach((v,i)=>{
    let el = existing[v.k];
    if(!el){
      el = document.createElement('div');
      el.className = 'wp-orb';
      el.dataset.k = v.k;
      el.innerHTML =
        '<div class="wp-orb-ring"><div class="wp-orb-inner">' +
        '<span class="wp-orb-ini"></span></div>' +
        '<span class="wp-orb-badge"></span></div>' +
        '<div class="wp-orb-name"></div>';
      el.addEventListener('click', ()=> el.classList.toggle('big'));
      existing[v.k] = el;
    }
    if(box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    el.classList.toggle('me', v.me);
    if(v.me) el.classList.toggle('no-mirror', WPC.facingMode === 'environment');

    const label = v.me ? (v.name + ' (you)') : v.name;
    const nameEl = el.querySelector('.wp-orb-name');
    if(nameEl.textContent !== label){ nameEl.textContent = label; el.title = label; }

    const inner = el.querySelector('.wp-orb-inner');
    const ini = el.querySelector('.wp-orb-ini');
    const initials = wpInitials(v.name);
    if(ini.textContent !== initials){
      ini.textContent = initials;
      inner.style.background = wpTint(v.name);
    }

    const stream = v.me ? (WPC.on ? WPC.stream : null)
                        : ((WPC.peers[v.id] && WPC.peers[v.id].stream) || null);
    const hasVideo = !!(stream && stream.getVideoTracks()
      .some(t=> t.readyState==='live' && !t.muted));
    let vid = inner.querySelector('video');
    if(hasVideo){
      if(!vid){
        vid = document.createElement('video');
        vid.autoplay = true; vid.playsInline = true;
        vid.setAttribute('playsinline','');
        inner.insertBefore(vid, inner.firstChild);
      }
      vid.muted = v.me;
      if(vid.srcObject !== stream){
        vid.srcObject = stream;
        const pr = vid.play();
        if(pr && pr.catch) pr.catch(()=> wpNeedGesture());
      }
      ini.style.display = 'none';
    } else {
      if(vid){ vid.srcObject = null; vid.remove(); }
      ini.style.display = '';
    }
    el.classList.toggle('live', hasVideo);

    const badge = el.querySelector('.wp-orb-badge');
    const txt = wpOrbBadge(v);
    if(badge.textContent !== txt) badge.textContent = txt;
    badge.style.display = txt ? '' : 'none';
  });

  const keep = {}; roster.forEach(v=>{ keep[v.k]=1; });
  Array.from(box.children).forEach(el=>{
    const k = el.dataset && el.dataset.k;
    if(k && !keep[k]){
      const v = el.querySelector('video'); if(v) v.srcObject = null;
      el.remove();
    }
  });
}

// Cheap pass for state that changes often — never rebuilds the video elements.
function wpOrbState(){
  document.querySelectorAll('.wp-orb[data-k]').forEach(el=>{
    const k = el.dataset.k; if(!k) return;
    const m = WPC.levels[k];
    const talking = !!(m && m.loud) && (k!=='me' || !WPC.muted);
    el.classList.toggle('talking', talking);
    el.classList.toggle('speaking', talking);
    if(k==='me'){
      const badge = el.querySelector('.wp-orb-badge');
      const txt = WPC.on ? (WPC.muted ? '🔇' : '🎤') : '';
      if(badge && badge.textContent !== txt){
        badge.textContent = txt;
        badge.style.display = txt ? '' : 'none';
      }
    }
  });
  // Pulse the mini-bar 🍿 button when someone is speaking
  const mb = $('wpMiniBar');
  if(mb && mb.classList.contains('on')){
    const anySpeaking = Object.values(WPC.levels).some(l => l && l.loud);
    mb.classList.toggle('speaking', anySpeaking);
  }
}

// Browsers refuse to autoplay audio without user activation; if that bites,
// take the next tap anywhere as the gesture.
function wpNeedGesture(){
  if(WPC.gesture) return;
  WPC.gesture = true;
  wpCamNote('Tap anywhere to hear everyone.');
  const go = ()=>{
    removeEventListener('click', go); removeEventListener('touchend', go);
    WPC.gesture = false;
    document.querySelectorAll('#wpOrbs video').forEach(v=> v.play().catch(()=>{}));
    wpCamNote('');
  };
  addEventListener('click', go); addEventListener('touchend', go);
}

addEventListener('pagehide', ()=>{ if(WPC.on) wpCamStop(); });

// ── chat ────────────────────────────────────────────────────────────────────
function wpChatSys(msg){
  WP.chat.push({id:'', msg, cmd:'sys'}); wpRenderChat();
}
function wpRenderChat(){
  const log=$('wpChatLog'); if(!log) return;
  log.innerHTML = WP.chat.map(m=>{
    if(m.cmd==='sys') return '<div class="wp-msg sys">'+esc(m.msg||'')+'</div>';
    if(m.cmd==='host') return '<div class="wp-msg sys">'+esc(WP.names[m.id]||'Someone')+' started a video</div>';
    if(m.cmd) return '';
    const who = m.id===WP.clientId ? 'You' : (WP.names[m.id] || 'Viewer');
    return '<div class="wp-msg"><span class="who">'+esc(who)+'</span>'+esc(m.msg||'')+'</div>';
  }).join('');
  log.scrollTop = log.scrollHeight;
}
function wpSendChat(){
  const i=$('wpChatIn'); if(!i) return;
  const msg=i.value.trim(); if(!msg) return;
  if(!WP.sock || !WP.sock.connected){ wpErr('Not connected.'); return; }
  WP.sock.emit('CMD:chatV2', {msg});
  i.value='';
}

// ── player ──────────────────────────────────────────────────────────────────
const wpYtId = url => {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : '';
};
function wpRemote(fn){ WP.applying++; try{ fn(); } finally { setTimeout(()=>{ WP.applying=Math.max(0,WP.applying-1); }, 400); } }

function wpTime(){
  if(WP.kind==='file'){ const v=$('wpVideo'); return v && !isNaN(v.currentTime) ? v.currentTime : null; }
  if(WP.kind==='yt' && WP.yt && WP.yt.getCurrentTime) { try{ return WP.yt.getCurrentTime(); }catch(e){} }
  return null;
}
function wpPlay(){
  if(WP.kind==='file'){ const v=$('wpVideo'); v && v.play().catch(()=>{}); }
  else if(WP.kind==='yt' && WP.yt?.playVideo) WP.yt.playVideo();
}
function wpPause(){
  if(WP.kind==='file'){ const v=$('wpVideo'); v && v.pause(); }
  else if(WP.kind==='yt' && WP.yt?.pauseVideo) WP.yt.pauseVideo();
}
function wpSeek(ts){
  if(!isFinite(ts)) return;
  if(WP.kind==='file'){ const v=$('wpVideo'); if(v) v.currentTime=ts; }
  else if(WP.kind==='yt' && WP.yt?.seekTo) WP.yt.seekTo(ts, true);
}

function wpApplyHost(h){
  const url = h.video || '';
  if(url !== WP.video) wpMount(url);
  if(!url) return;
  const ts = Number(h.videoTS)||0;
  const cur = wpTime();
  if(cur !== null && Math.abs(cur - ts) > 2) wpRemote(()=>wpSeek(ts));
  else if(cur === null) WP.pendingTS = ts;
  wpRemote(()=> h.paused ? wpPause() : wpPlay());
}

function wpMount(url){
  WP.video = url || '';
  const vid=$('wpVideo'), ytBox=$('wpYt'), empty=$('wpEmpty');
  const urlIn=$('wpUrl'); if(urlIn && document.activeElement!==urlIn) urlIn.value = WP.video;
  // tear down
  if(WP.yt && WP.yt.destroy){ try{ WP.yt.destroy(); }catch(e){} }
  WP.yt=null;
  if(WP.hls){ try{ WP.hls.destroy(); }catch(e){} WP.hls=null; }
  if(vid){ vid.pause(); vid.removeAttribute('src'); vid.load(); vid.style.display='none'; }
  if(ytBox){ ytBox.style.display='none'; ytBox.innerHTML=''; }
  WP.kind='';
  if(!WP.video){ if(empty){ empty.style.display='grid'; empty.innerHTML='Nothing playing yet.<br>Paste a video link below to start the party.'; } return; }
  if(empty) empty.style.display='none';

  const ytId = wpYtId(WP.video);
  if(ytId){ WP.kind='yt'; wpMountYt(ytId); return; }
  if(/\.m3u8/i.test(WP.video)){
    WP.kind='file'; vid.style.display='block'; wpMountHls(WP.video); return;
  }
  if(/^\/api\/watch\/proxy\?/.test(WP.video) || /^https?:\/\//i.test(WP.video)){
    WP.kind='file'; vid.style.display='block'; vid.src=WP.video;
    if(WP.pendingTS){ const t=WP.pendingTS; WP.pendingTS=0;
      vid.addEventListener('loadedmetadata', ()=>{ vid.currentTime=t; }, {once:true}); }
    return;
  }
  if(empty){ empty.style.display='grid';
    empty.innerHTML='This link type isn\'t supported here yet.<br>Direct video links and YouTube work.'; }
}

function wpLoadHlsJs(){
  if(window.Hls) return Promise.resolve(window.Hls);
  if(WP.hlsLoading) return WP.hlsLoading;
  WP.hlsLoading = wpScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js')
    .then(()=>window.Hls).catch(()=>null);
  return WP.hlsLoading;
}

function wpMountHls(url){
  const vid=$('wpVideo'); if(!vid) return;
  if(vid.canPlayType('application/vnd.apple.mpegurl')){
    vid.src=url;
    if(WP.pendingTS){ const t=WP.pendingTS; WP.pendingTS=0;
      vid.addEventListener('loadedmetadata',()=>{ vid.currentTime=t; },{once:true}); }
    return;
  }
  wpLoadHlsJs().then(Hls=>{
    if(!Hls || !Hls.isSupported()){ vid.src=url; return; }
    const hls=new Hls(); WP.hls=hls;
    hls.loadSource(url); hls.attachMedia(vid);
    if(WP.pendingTS){ const t=WP.pendingTS; WP.pendingTS=0;
      hls.once(Hls.Events.MANIFEST_PARSED,()=>{ vid.currentTime=t; }); }
  });
}

function wpMountYt(id){
  const box=$('wpYt'); if(!box) return;
  box.style.display='block';
  // YT.Player *replaces* its target element, so give it a throwaway child and
  // keep #wpYt itself as a stable container we can clear on the next mount.
  box.innerHTML = '<div id="wpYtTarget" style="width:100%;height:100%"></div>';
  const build = ()=>{
    if(!$('wpYtTarget')) return;
    WP.yt = new YT.Player('wpYtTarget', {
      videoId:id, width:'100%', height:'100%',
      playerVars:{ playsinline:1, rel:0, modestbranding:1, origin:location.origin },
      events:{
        onReady:()=>{ if(WP.pendingTS){ WP.yt.seekTo(WP.pendingTS,true); WP.pendingTS=0; } },
        onStateChange:(e)=>{
          if(WP.applying) return;
          if(e.data===YT.PlayerState.PLAYING) WP.sock?.emit('CMD:play');
          if(e.data===YT.PlayerState.PAUSED)  WP.sock?.emit('CMD:pause');
        },
      },
    });
  };
  if(window.YT && window.YT.Player) return build();
  if(!WP.ytLoading){
    WP.ytLoading = new Promise((res)=>{
      window.onYouTubeIframeAPIReady = ()=>res();
      wpScript('https://www.youtube.com/iframe_api').catch(()=>res());
    });
  }
  WP.ytLoading.then(()=>{ if(window.YT && window.YT.Player) build(); });
}

async function wpSetVideo(forced){
  const i=$('wpUrl');
  const url = forced !== undefined ? forced : (i ? i.value.trim() : '');
  if(!WP.sock || !WP.sock.connected){ wpErr('Not connected to the watch party yet.'); return; }
  if(forced===''){ wpErr(''); WP.sock.emit('CMD:host',''); if(i) i.value=''; return; }
  if(!url) return;
  if(!/^https?:\/\//i.test(url)){ wpErr('Only http(s) links are supported.'); return; }

  // YouTube and bare video files: send straight to the room.
  const isYt = !!wpYtId(url);
  const isDirect = /\.(mp4|webm|ogg|mov|mkv|m3u8|mpd)(\?|#|$)/i.test(url);
  if(isYt || isDirect){ wpErr(''); WP.sock.emit('CMD:host', url); return; }

  // Everything else: ask the server to resolve via yt-dlp.
  const btn=$('wpSetBtn');
  wpErr('Resolving video…');
  if(btn) btn.disabled=true;
  try{
    const r = await fetch('/api/watch/extract',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({url}),
    });
    if(r.status===429){ wpErr('Too many extractions — wait a moment.'); return; }
    if(!r.ok){
      let det=''; try{ det=(await r.json()).detail||''; }catch(e){}
      wpErr(det || 'Could not extract a video from that link.');
      return;
    }
    const d = await r.json();
    wpErr('');
    WP.sock.emit('CMD:host', d.url);
  }catch(e){ wpErr('Could not extract a video from that link.'); }
  finally{ if(btn) btn.disabled=false; }
}

async function wpEditNickname(){
  const cur = WP.cfg?.viewer?.nickname || '';
  const next = prompt('Watch Party display name (blank = use your PSN name):', cur);
  if(next === null) return;
  try{
    const r = await fetch('/api/watch/nickname', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({nickname: next}),
    });
    if(!r.ok) throw new Error('nickname '+r.status);
    const d = await r.json();
    if(WP.cfg?.viewer){ WP.cfg.viewer.nickname = d.nickname; WP.cfg.viewer.name = d.name; }
    WP.myName = d.name;
    toast('Name: '+d.name);
    // The name lives in the ticket, so reconnect to publish it.
    WP.tries = 0; wpConnect();
  }catch(e){ wpErr('Could not save that name.'); }
}

// ── rally ────────────────────────────────────────────────────────────────────
async function wpRally(){
  const btn=$('wpRallyBtn'); if(btn){ btn.disabled=true; btn.textContent='📣 Sending…'; }
  try{
    // Who's watching
    const viewers = (WP.presence?.viewers||[]).map(v=>v.name).filter(Boolean);
    const names = viewers.length ? viewers.join(', ') : 'We';

    // Video title: try YT player first, then parse the URL
    let videoLabel = '';
    if(WP.video){
      const ytId = wpYtId(WP.video);
      if(ytId && WP.yt?.getVideoData){
        try{ videoLabel = WP.yt.getVideoData().title || ''; }catch(e){}
      }
      if(!videoLabel){
        try{
          const u = new URL(WP.video, location.origin);
          const raw = u.searchParams.get('url') || u.pathname;
          videoLabel = decodeURIComponent(raw.split('/').pop().split('?')[0])
                         .replace(/\.[a-z0-9]+$/i,'') || '';
        }catch(e){}
      }
    }
    const watchingStr = videoLabel ? 'watching '+videoLabel : 'in the watch party';
    const link = location.origin+'/watch';
    const msg = '@everyone! '+names+' are on CRCMZ app '+watchingStr+'. Join now fuckers! '+link;

    const r = await fetch('/api/watch/rally', {method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:msg})});
    toast(r.ok ? '📣 Rallied!' : (r.status===503 ? 'WhatsApp not configured' : 'Failed to send'));
  }catch(e){ toast('Network error'); }
  finally{
    if(btn){ btn.disabled=false; btn.textContent='📣 Rally'; }
  }
}

// Local player -> everyone. Bound once; the element survives remounts.
(function wpBindVideoEl(){
  const v=$('wpVideo'); if(!v) return;
  v.addEventListener('play',   ()=>{ if(!WP.applying) WP.sock?.emit('CMD:play'); });
  v.addEventListener('pause',  ()=>{ if(!WP.applying) WP.sock?.emit('CMD:pause'); });
  v.addEventListener('seeked', ()=>{ if(!WP.applying) WP.sock?.emit('CMD:seek', v.currentTime); });
})();

// ── Huddle (LiveKit video chat — revamped) ────────────────────────────────────
const HUDDLE = {
  room: null, loading: false,
  blurEnabled: false, blurCtx: null, blurAnim: null,
  transcript: [], transcribing: false, recog: null,
  aiLoading: false,
  layout: 'spotlight',
  pinnedId: null,
  spotlight: null,
  previewStream: null,
};

let _livekitLoaded = false;
async function _loadLivekit() {
  if(_livekitLoaded || window.LivekitClient) { _livekitLoaded = true; return; }
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js';
    s.onload = () => { _livekitLoaded = true; res(); };
    s.onerror = () => rej(new Error('Failed to load LiveKit SDK'));
    document.head.appendChild(s);
  });
}

async function loadHuddle() {
  if(HUDDLE.room) return;
  $('huddlePre').style.display = '';
  $('huddleStage').style.display = 'none';
  _loadLivekit().catch(()=>{});
  _huddleStartPreview();
  _huddleEnumerateDevices();
}

async function _huddleStartPreview() {
  const off = $('huddlePreviewOff');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
    HUDDLE.previewStream = stream;
    const v = $('huddleLocalPreview'); if(v) v.srcObject = stream;
    if(off) off.style.display = 'none';
  } catch(e) { if(off) off.style.display = ''; }
}

async function _huddleEnumerateDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter(d => d.kind==='audioinput');
    const cams = devs.filter(d => d.kind==='videoinput');
    const ms = $('huddleMicSel'), cs = $('huddleCamSel');
    if(ms) ms.innerHTML = mics.map((d,i)=>`<option value="${d.deviceId}">${d.label||'Mic '+(i+1)}</option>`).join('');
    if(cs) cs.innerHTML = cams.map((d,i)=>`<option value="${d.deviceId}">${d.label||'Camera '+(i+1)}</option>`).join('');
  } catch(e) {}
}

async function huddleJoin() {
  if(HUDDLE.loading) return;
  const room = ($('huddleRoom')?.value.trim()) || 'crcmz';
  const msgEl = $('huddleJoinMsg');
  const setMsg = (t,err) => { if(msgEl){ msgEl.textContent=t; msgEl.style.color=err?'#ff6060':'var(--dim)'; } };
  const btn = $('huddleJoinBtn');
  setMsg('Connecting…', false);
  if(btn) { btn.disabled=true; btn.textContent='Connecting…'; }
  HUDDLE.loading = true;
  if(HUDDLE.previewStream) { HUDDLE.previewStream.getTracks().forEach(t=>t.stop()); HUDDLE.previewStream=null; }
  try {
    await _loadLivekit();
    const r = await fetch('/api/huddle/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room})});
    const d = await r.json();
    if(!r.ok) { setMsg(d.error||'Failed to get token', true); return; }
    HUDDLE.room = new LivekitClient.Room({ adaptiveStream:true, dynacast:true, stopLocalTrackOnUnpublish:false });
    HUDDLE.room
      .on(LivekitClient.RoomEvent.TrackSubscribed,         () => huddleRenderAll())
      .on(LivekitClient.RoomEvent.TrackUnsubscribed,       (track) => { track.detach(); huddleRenderAll(); })
      .on(LivekitClient.RoomEvent.ParticipantConnected,    () => huddleRenderAll())
      .on(LivekitClient.RoomEvent.ParticipantDisconnected, () => huddleRenderAll())
      .on(LivekitClient.RoomEvent.ActiveSpeakersChanged,   sp => huddleActiveSpeakers(sp))
      .on(LivekitClient.RoomEvent.LocalTrackPublished,     () => huddleRenderAll())
      .on(LivekitClient.RoomEvent.TrackMuted,              () => huddleRenderAll())
      .on(LivekitClient.RoomEvent.TrackUnmuted,            () => huddleRenderAll())
      .on(LivekitClient.RoomEvent.Disconnected, reason => {
        if(reason !== LivekitClient.DisconnectReason?.CLIENT_INITIATED) {
          $('huddleStage').style.display = 'none';
          $('huddlePre').style.display = '';
          setMsg('Disconnected', true);
          _huddleStartPreview(); _huddleEnumerateDevices();
        }
      });
    await HUDDLE.room.connect(d.url, d.token);
    const micId = $('huddleMicSel')?.value, camId = $('huddleCamSel')?.value;
    await HUDDLE.room.localParticipant.setMicrophoneEnabled(true, micId ? {deviceId:{exact:micId}} : true);
    await HUDDLE.room.localParticipant.setCameraEnabled(true, camId ? {deviceId:{exact:camId}} : true);
    $('huddleRoomName').textContent = room;
    $('huddlePre').style.display = 'none';
    $('huddleStage').style.display = 'flex';
    setMsg('', false);
    HUDDLE.layout = 'spotlight';
    HUDDLE.spotlight = HUDDLE.room.localParticipant.identity;
    $('huddleSpotlightWrap').style.display = '';
    $('huddleGrid').style.display = 'none';
    huddleRenderAll(); huddleSyncControls();
  } catch(e) {
    setMsg('Could not connect: '+(e.message||e), true);
    if(HUDDLE.room) { try{await HUDDLE.room.disconnect();}catch(_){} HUDDLE.room=null; }
    _huddleStartPreview();
  } finally {
    HUDDLE.loading = false;
    if(btn) { btn.disabled=false; btn.textContent='🎥 Join'; }
  }
}

async function huddleLeave() {
  if(HUDDLE.room) { await HUDDLE.room.disconnect(); HUDDLE.room=null; }
  _huddleBlurStop();
  if(HUDDLE.recog) { try{HUDDLE.recog.stop();}catch(_){} HUDDLE.recog=null; }
  HUDDLE.transcript=[]; HUDDLE.transcribing=false; HUDDLE.pinnedId=null; HUDDLE.spotlight=null;
  const g=$('huddleGrid'); if(g) g.innerHTML='';
  const s=$('huddleStrip'); if(s) s.innerHTML='';
  $('huddleStage').style.display='none';
  $('huddlePre').style.display='';
  const tb=$('huddleTranscriptBox'); if(tb) tb.style.display='none';
  _huddleStartPreview(); _huddleEnumerateDevices();
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function _allP() {
  if(!HUDDLE.room) return [];
  return [
    {p:HUDDLE.room.localParticipant, local:true},
    ...[...HUDDLE.room.remoteParticipants.values()].map(p=>({p,local:false}))
  ];
}

function huddleRenderAll() {
  if(!HUDDLE.room) return;
  const n = 1 + HUDDLE.room.remoteParticipants.size;
  const countEl=$('huddleCount'); if(countEl) countEl.textContent = n+' in call';
  if(HUDDLE.layout==='spotlight') {
    _huddleRenderSpotlight();
    _huddleRenderStrip();
  } else {
    _huddleRenderGrid();
  }
}

function _spotP() {
  const all = _allP();
  if(!all.length) return null;
  if(HUDDLE.pinnedId) { const p=all.find(({p})=>p.identity===HUDDLE.pinnedId); if(p) return p; }
  if(HUDDLE.spotlight) { const p=all.find(({p})=>p.identity===HUDDLE.spotlight); if(p) return p; }
  return all[0];
}

function _attachTracks(p, local, vid, aud) {
  const Src = LivekitClient.Track?.Source;
  if(local) {
    const cp = p.getTrackPublication(Src?.Camera||'camera');
    if(cp?.track && vid) { try{cp.track.attach(vid);}catch(_){} }
    else if(vid && !cp?.track) vid.srcObject=null;
  } else {
    p.trackPublications.forEach(pub => {
      if(!pub.isSubscribed||!pub.track) return;
      try {
        if(pub.kind==='video'&&vid) pub.track.attach(vid);
        if(pub.kind==='audio'&&aud) pub.track.attach(aud);
      } catch(_) {}
    });
  }
}

function _huddleRenderSpotlight() {
  const cur = _spotP(); if(!cur) return;
  const {p, local} = cur;
  const spotEl=$('huddleSpotlight'), vid=$('huddleSpotVid'), aud=$('huddleSpotAud');
  if(!vid) return;
  if(vid.dataset.pid !== p.identity) {
    vid.srcObject=null; if(aud) aud.srcObject=null;
    vid.dataset.pid = p.identity;
  }
  spotEl?.classList.toggle('me', local);
  if(local) vid.muted=true; else vid.muted=false;
  _attachTracks(p, local, vid, aud);
  const sn=$('huddleSpotName'); if(sn) sn.textContent=(p.name||p.identity)+(local?' (you)':'');
  const sb=$('huddleSpotBadges');
  if(sb) { const mic=p.getTrackPublication(LivekitClient.Track?.Source?.Microphone||'microphone'); sb.textContent=(!mic||mic.isMuted)?'🔇':''; }
}

function _huddleRenderStrip() {
  const strip=$('huddleStrip'); if(!strip||!HUDDLE.room) return;
  const all=_allP(), spotId=_spotP()?.p.identity;
  const ids=new Set(all.map(({p})=>p.identity));
  Array.from(strip.querySelectorAll('.hs-strip-tile')).forEach(t=>{ if(!ids.has(t.dataset.id)) t.remove(); });
  all.forEach(({p,local}) => {
    const tid='hst-'+p.identity;
    let tile=document.getElementById(tid);
    if(!tile) {
      tile=document.createElement('div');
      tile.className='hs-strip-tile'+(local?' me':'');
      tile.id=tid; tile.dataset.id=p.identity;
      tile.onclick=()=>{ HUDDLE.pinnedId=p.identity; HUDDLE.spotlight=p.identity; huddleRenderAll(); };
      tile.innerHTML=`<video autoplay playsinline ${local?'muted':''}></video><audio autoplay style="display:none"></audio><div class="hs-strip-name">${esc(p.name||p.identity)}</div>`;
      strip.appendChild(tile);
    }
    tile.classList.toggle('active', p.identity===spotId);
    _attachTracks(p, local, tile.querySelector('video'), tile.querySelector('audio'));
  });
}

function _huddleRenderGrid() {
  const grid=$('huddleGrid'); if(!grid||!HUDDLE.room) return;
  const all=_allP(), n=all.length;
  grid.style.gridTemplateColumns=n===1?'1fr':n<=4?'repeat(2,1fr)':n<=9?'repeat(3,1fr)':'repeat(4,1fr)';
  const ids=new Set(all.map(({p})=>p.identity));
  Array.from(grid.querySelectorAll('.hs-tile')).forEach(t=>{ if(!ids.has(t.dataset.id)) t.remove(); });
  all.forEach(({p,local}) => {
    const tid='hgt-'+p.identity;
    let tile=document.getElementById(tid);
    if(!tile) {
      tile=document.createElement('div');
      tile.className='hs-tile'+(local?' me':'');
      tile.id=tid; tile.dataset.id=p.identity;
      tile.innerHTML=`<video autoplay playsinline ${local?'muted':''}></video><audio autoplay style="display:none"></audio>`+
        `<div class="hs-tile-info"><span class="hs-tile-name">${esc(p.name||p.identity)}${local?' (you)':''}</span><span class="hs-tile-badges" id="hgb-${p.identity}"></span></div>`;
      grid.appendChild(tile);
    }
    _attachTracks(p, local, tile.querySelector('video'), tile.querySelector('audio'));
    const b=document.getElementById('hgb-'+p.identity);
    if(b) { const mic=p.getTrackPublication(LivekitClient.Track?.Source?.Microphone||'microphone'); b.textContent=(!mic||mic.isMuted)?'🔇':''; }
  });
}

function huddleActiveSpeakers(speakers) {
  document.querySelectorAll('.hs-tile,.hs-strip-tile').forEach(t=>t.classList.remove('speaking'));
  (speakers||[]).forEach(p => document.querySelectorAll(`[data-id="${p.identity}"]`).forEach(t=>t.classList.add('speaking')));
  if(!HUDDLE.pinnedId && speakers?.length > 0) {
    const top = speakers[0];
    if(HUDDLE.spotlight !== top.identity) {
      HUDDLE.spotlight = top.identity;
      if(HUDDLE.layout==='spotlight') _huddleRenderSpotlight();
    }
  }
}

function huddleToggleLayout() {
  HUDDLE.layout = HUDDLE.layout==='spotlight' ? 'grid' : 'spotlight';
  const sw=$('huddleSpotlightWrap'), gr=$('huddleGrid'), btn=$('huddleLayoutBtn');
  if(HUDDLE.layout==='spotlight') {
    if(sw) sw.style.display=''; if(gr) gr.style.display='none';
    if(btn) btn.textContent='⊞ Grid';
    if(!HUDDLE.spotlight && HUDDLE.room) HUDDLE.spotlight=HUDDLE.room.localParticipant.identity;
  } else {
    if(sw) sw.style.display='none'; if(gr) { gr.style.display=''; gr.innerHTML=''; }
    if(btn) btn.textContent='▦ Spotlight';
  }
  huddleRenderAll();
}

// ── Controls ───────────────────────────────────────────────────────────────────
async function huddleToggleMic() {
  if(!HUDDLE.room) return;
  await HUDDLE.room.localParticipant.setMicrophoneEnabled(!HUDDLE.room.localParticipant.isMicrophoneEnabled);
  huddleSyncControls();
}
async function huddleToggleCam() {
  if(!HUDDLE.room) return;
  await HUDDLE.room.localParticipant.setCameraEnabled(!HUDDLE.room.localParticipant.isCameraEnabled);
  huddleSyncControls(); huddleRenderAll();
}
async function huddleToggleShare() {
  if(!HUDDLE.room) return;
  if(!navigator.mediaDevices?.getDisplayMedia) { toast&&toast('Screen sharing not supported on this device'); return; }
  try {
    await HUDDLE.room.localParticipant.setScreenShareEnabled(!HUDDLE.room.localParticipant.isScreenShareEnabled);
    huddleSyncControls();
  } catch(e) { if(e.name!=='NotAllowedError') toast&&toast('Screen share: '+e.message); }
}
async function huddleToggleBlur() {
  if(!HUDDLE.room) return;
  const Src=LivekitClient.Track?.Source;
  const camPub=HUDDLE.room.localParticipant.getTrackPublication(Src?.Camera||'camera');
  if(!camPub?.track) { toast&&toast('Enable camera first'); return; }
  if(!HUDDLE.blurEnabled) {
    const orig=camPub.track.mediaStreamTrack;
    const sv=document.createElement('video');
    sv.srcObject=new MediaStream([orig]); sv.muted=true; sv.autoplay=true;
    await sv.play().catch(()=>{});
    const cv=document.createElement('canvas'); cv.width=640; cv.height=360;
    const ctx=cv.getContext('2d');
    let active=true;
    function frame(){ if(!active) return; ctx.filter='blur(8px)'; ctx.drawImage(sv,-10,-10,660,380); ctx.filter='none'; HUDDLE.blurAnim=requestAnimationFrame(frame); }
    frame();
    const bt=cv.captureStream(30).getVideoTracks()[0];
    try {
      await camPub.track.replaceTrack(bt);
      HUDDLE.blurCtx={sv,orig,bt,stop(){active=false;sv.srcObject=null;}};
      HUDDLE.blurEnabled=true;
    } catch(e) {
      active=false; sv.srcObject=null;
      toast&&toast('Blur failed: '+e.message); return;
    }
  } else {
    if(HUDDLE.blurCtx?.orig && camPub?.track) { try{await camPub.track.replaceTrack(HUDDLE.blurCtx.orig);}catch(_){} }
    _huddleBlurStop();
  }
  huddleSyncControls();
}
function _huddleBlurStop() {
  if(HUDDLE.blurCtx){HUDDLE.blurCtx.stop();HUDDLE.blurCtx=null;}
  if(HUDDLE.blurAnim){cancelAnimationFrame(HUDDLE.blurAnim);HUDDLE.blurAnim=null;}
  HUDDLE.blurEnabled=false;
}
function huddleSyncControls() {
  if(!HUDDLE.room) return;
  const p=HUDDLE.room.localParticipant;
  const mic=$('huddleMicBtn'),cam=$('huddleCamBtn'),share=$('huddleShareBtn'),blur=$('huddleBlurBtn');
  if(mic){const on=p.isMicrophoneEnabled;mic.textContent=on?'🎤':'🔇';mic.className='hs-ctrl '+(on?'on':'off');mic.title=on?'Mute':'Unmute';}
  if(cam){const on=p.isCameraEnabled;cam.textContent='📷';cam.className='hs-ctrl '+(on?'on':'off');cam.title=on?'Turn off camera':'Turn on camera';}
  if(share){const on=p.isScreenShareEnabled;share.textContent='🖥';share.className='hs-ctrl '+(on?'active':'');share.title=on?'Stop sharing':'Share screen';}
  if(blur){blur.className='hs-ctrl '+(HUDDLE.blurEnabled?'active':'');blur.title=HUDDLE.blurEnabled?'Remove blur':'Add blur';}
}

// ── AI sidebar ─────────────────────────────────────────────────────────────────
function huddleToggleAi() {
  const panel=$('huddleAiPanel'); if(!panel) return;
  const show=panel.style.display==='none'||!panel.style.display;
  panel.style.display=show?'flex':'none';
  const btn=$('huddleAiToggle'); if(btn) btn.classList.toggle('on',show);
  if(show&&!$('huddleAiLog').children.length)
    _huddleAiMsg('sys','Ask me anything. I can help summarise, answer questions, and more.');
}
function _huddleAiMsg(role,text){
  const log=$('huddleAiLog');if(!log)return;
  const d=document.createElement('div');d.className='hs-ai-msg '+role;d.textContent=text;
  log.appendChild(d);log.scrollTop=log.scrollHeight;
}
async function huddleAiSend(){
  if(HUDDLE.aiLoading)return;
  const inp=$('huddleAiInput');if(!inp)return;
  const text=inp.value.trim();if(!text)return;
  inp.value=''; _huddleAiMsg('user',text);
  HUDDLE.aiLoading=true;
  const st=$('huddleAiStatus');if(st)st.textContent='thinking…';
  const ctx=HUDDLE.transcript.slice(-20).map(t=>t.text).join(' ');
  const sys='You are a helpful AI assistant in a video call. Be concise.'+(ctx?'\n\nMeeting so far:\n'+ctx:'');
  try{
    const r=await fetch('/api/huddle/ai',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:text}]})});
    const d=await r.json();
    if(!r.ok){_huddleAiMsg('sys','Error: '+(d.error||'Failed'));return;}
    _huddleAiMsg('assistant',d.message?.content||d.response||JSON.stringify(d));
  }catch(e){_huddleAiMsg('sys','Could not reach AI: '+e.message);}
  finally{HUDDLE.aiLoading=false;if(st)st.textContent='';}
}
function huddleToggleTranscript(){
  const box=$('huddleTranscriptBox');if(!box)return;
  if(HUDDLE.transcribing){if(HUDDLE.recog){try{HUDDLE.recog.stop();}catch(_){} HUDDLE.recog=null;}HUDDLE.transcribing=false;box.style.display='none';return;}
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast&&toast('Speech recognition not supported');return;}
  HUDDLE.recog=new SR();HUDDLE.recog.continuous=true;HUDDLE.recog.interimResults=true;HUDDLE.recog.lang='en-US';
  HUDDLE.recog.onresult=ev=>{
    for(let i=ev.resultIndex;i<ev.results.length;i++)
      if(ev.results[i].isFinal)HUDDLE.transcript.push({text:ev.results[i][0].transcript,ts:Date.now()});
    const el=$('huddleTranscriptText');if(el)el.textContent=HUDDLE.transcript.slice(-5).map(t=>t.text).join(' ');
  };
  HUDDLE.recog.onerror=e=>{if(e.error!=='no-speech')toast&&toast('Transcript: '+e.error);};
  HUDDLE.recog.start();HUDDLE.transcribing=true;box.style.display='';
}
async function huddleMeetingNotes(){
  if(!HUDDLE.transcript.length){
    if($('huddleAiPanel').style.display==='none')huddleToggleAi();
    _huddleAiMsg('sys','No transcript yet — enable 🎙 Transcript first.');return;
  }
  if($('huddleAiPanel').style.display==='none')huddleToggleAi();
  _huddleAiMsg('sys','Generating meeting notes…');
  HUDDLE.aiLoading=true;
  try{
    const r=await fetch('/api/huddle/ai',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:[
        {role:'system',content:'Create clean, organised meeting notes from this transcript.'},
        {role:'user',content:'Transcript:\n\n'+HUDDLE.transcript.map(t=>t.text).join('\n')},
      ]})});
    const d=await r.json();
    _huddleAiMsg('assistant',d.message?.content||d.response||JSON.stringify(d));
  }catch(e){_huddleAiMsg('sys','Could not reach AI: '+e.message);}
  finally{HUDDLE.aiLoading=false;const s=$('huddleAiStatus');if(s)s.textContent='';}
}
// ── end Huddle ──────────────────────────────────────────────────────────────────

</script>
</body></html>"""
