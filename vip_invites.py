"""VIP invites: a paid VIP Clan Member gets a CRCMZ App account and a branded email.

Same shape as EZPM Cloud's invites (ezpm-cloud/lib/zitadel.ts + lib/email.ts):
Zitadel mints the code with `returnCode`, so it sends nothing itself, and this
module builds the link and sends its own HTML email over SMTP. The member lands
on /invite, picks a password, and is signed straight in.

Why an *invite* code and not a password-reset code like EZPM: on auth.crcmz.me a
reset code expires after 1 hour (SECRET_GENERATOR_TYPE_PASSWORD_RESET_CODE), far
too short for an email someone opens tomorrow. Invite codes last 72 hours.

Two cases, decided by whether the account can already sign in:

* new email, or an account with no password/passkey yet → (create the user,)
  mint an invite code, email a "set your password" link;
* an account that already signs in → email a plain "you're VIP, sign in" note.
  Its password is never touched.

Mattermost (mm.qureshi.io) signs in through Authentik → Zitadel, so a VIP uses this
same account there. The email carries the crcmz team's join link; once they have
signed in, link_mattermost (run by a background sweep, and by the PSN portal) puts
them on the team and writes their `mm_username` tag, so the portal never has to
ask who they are.

Every send is logged in /data/vip_invites.db. A Stripe checkout session id is
unique there, so a webhook that Stripe retries sends one email, not three.
"""

from __future__ import annotations

import base64
import html
import logging
import os
import re
import smtplib
import sqlite3
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from threading import Lock
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

DB_PATH = Path("/data/vip_invites.db")
_lock = Lock()

ZITADEL_ISSUER = os.environ.get("ZITADEL_ISSUER", "https://auth.crcmz.me").rstrip("/")
ZITADEL_SERVICE_TOKEN = os.environ.get("ZITADEL_SERVICE_TOKEN", "")
PUBLIC_HOST = os.environ.get("PORTAL_PUBLIC_HOST", "app.crcmz.me")

# The same Gmail account Zitadel's own SMTP provider on auth.crcmz.me uses.
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587") or 587)
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
EMAIL_FROM_ADDRESS = os.environ.get("EMAIL_FROM_ADDRESS", "auth@crcmz.me")
EMAIL_FROM_NAME = os.environ.get("EMAIL_FROM_NAME", "CRCMZ")
EMAIL_REPLY_TO = os.environ.get("EMAIL_REPLY_TO", "admin@crcmz.me")

MATTERMOST_URL = os.environ.get("MATTERMOST_URL", "").rstrip("/")
MATTERMOST_TOKEN = os.environ.get("MATTERMOST_TOKEN", "")
MATTERMOST_TEAM_NAME = os.environ.get("MATTERMOST_TEAM_NAME", "")

_HTTP_TIMEOUT = 15
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# auth.crcmz.me's password complexity policy (management/v1/policies/password/complexity).
# Checked here before the invite code is spent, because verifying the code consumes it.
PASSWORD_RULES = "At least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol."


class InviteError(Exception):
    """Something the caller should see, with a message safe to show."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(DB_PATH))
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init() -> None:
    with _lock, _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS vip_invites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                zitadel_id TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT '',          -- 'invite' | 'welcome'
                status TEXT NOT NULL DEFAULT 'sent',    -- 'sent' | 'failed' | 'accepted'
                error TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',        -- 'stripe' | 'admin' | 'typebot' ...
                stripe_session_id TEXT,
                discord_username TEXT NOT NULL DEFAULT '',
                gamer_tag TEXT NOT NULL DEFAULT '',
                platform TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                accepted_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS vip_invites_stripe
                ON vip_invites(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS vip_invites_zid ON vip_invites(zitadel_id);
        """)
        cols = {r[1] for r in c.execute("PRAGMA table_info(vip_invites)")}
        if "mm_username" not in cols:
            c.execute("ALTER TABLE vip_invites ADD COLUMN mm_username TEXT NOT NULL DEFAULT ''")


def _record(**row) -> int:
    row.setdefault("created_at", _now())
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    with _lock, _conn() as c:
        cur = c.execute(f"INSERT INTO vip_invites ({cols}) VALUES ({marks})", tuple(row.values()))
        return int(cur.lastrowid)


def _already_handled(stripe_session_id: str) -> dict | None:
    if not stripe_session_id:
        return None
    with _lock, _conn() as c:
        r = c.execute("SELECT * FROM vip_invites WHERE stripe_session_id = ? AND status != 'failed'",
                      (stripe_session_id,)).fetchone()
    return dict(r) if r else None


def mark_accepted(zitadel_id: str) -> None:
    with _lock, _conn() as c:
        c.execute("UPDATE vip_invites SET status = 'accepted', accepted_at = ? "
                  "WHERE zitadel_id = ? AND kind = 'invite' AND status = 'sent'",
                  (_now(), zitadel_id))


def recent(limit: int = 20) -> list[dict]:
    """Newest first. Carries emails, so only admins and the read-only tool (which
    strips them) should see it."""
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM vip_invites ORDER BY id DESC LIMIT ?",
                         (max(1, min(int(limit), 200)),)).fetchall()
    return [dict(r) for r in rows]


def password_ok(pw: str) -> bool:
    return (len(pw) >= 8 and any(ch.isupper() for ch in pw) and any(ch.islower() for ch in pw)
            and any(ch.isdigit() for ch in pw) and any(not ch.isalnum() for ch in pw))


# ── Zitadel ─────────────────────────────────────────────────────────────────

def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {ZITADEL_SERVICE_TOKEN}",
            "Content-Type": "application/json"}


def _zerr(r: httpx.Response) -> str:
    try:
        return (r.json() or {}).get("message", "") or r.text[:200]
    except ValueError:
        return r.text[:200]


def find_user_by_email(client: httpx.Client, email: str) -> dict | None:
    r = client.post(f"{ZITADEL_ISSUER}/v2/users", headers=_headers(), json={
        "queries": [{"emailQuery": {"emailAddress": email, "method": "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE"}},
                    {"typeQuery": {"type": "TYPE_HUMAN"}}]})
    if r.status_code != 200:
        raise InviteError(f"user lookup failed: {_zerr(r)}")
    result = r.json().get("result") or []
    return result[0] if result else None


def _create_user(client: httpx.Client, email: str, display_name: str) -> str:
    local = email.split("@", 1)[0]
    given = (display_name or local)[:200]
    r = client.post(f"{ZITADEL_ISSUER}/v2/users/human", headers=_headers(), json={
        "username": email,
        # Zitadel requires both names. The display name is what the app shows.
        "profile": {"givenName": given, "familyName": "VIP", "displayName": given},
        # The address came from a paid Stripe checkout, and proving it again is
        # exactly what clicking the invite link does.
        "email": {"email": email, "isVerified": True},
    })
    if r.status_code not in (200, 201):
        raise InviteError(f"could not create the account: {_zerr(r)}")
    return r.json().get("userId", "")


def _can_sign_in(client: httpx.Client, user_id: str) -> bool:
    r = client.get(f"{ZITADEL_ISSUER}/v2/users/{user_id}/authentication_methods", headers=_headers())
    if r.status_code != 200:
        raise InviteError(f"could not read sign-in methods: {_zerr(r)}")
    return bool(r.json().get("authMethodTypes"))


def _invite_code(client: httpx.Client, user_id: str) -> str:
    # One live invite code per user: minting a new one voids the last link sent.
    r = client.post(f"{ZITADEL_ISSUER}/v2/users/{user_id}/invite_code", headers=_headers(),
                    json={"returnCode": {}})
    if r.status_code not in (200, 201) or not r.json().get("inviteCode"):
        raise InviteError(f"could not mint an invite code: {_zerr(r)}")
    return r.json()["inviteCode"]


def _tag_vip(client: httpx.Client, user_id: str) -> None:
    """`vip` metadata on the person, joining the identity graph (crcmz_identity)."""
    value = base64.b64encode(_now()[:10].encode()).decode()
    r = client.post(f"{ZITADEL_ISSUER}/management/v1/users/{user_id}/metadata/vip",
                    headers=_headers(), json={"value": value})
    if r.status_code != 200:
        logger.warning("vip: tag write for %s answered %s", user_id, r.status_code)


def _set_tag(client: httpx.Client, user_id: str, key: str, value: str) -> None:
    r = client.post(f"{ZITADEL_ISSUER}/management/v1/users/{user_id}/metadata/{key}",
                    headers=_headers(), json={"value": base64.b64encode(value.encode()).decode()})
    if r.status_code != 200:
        logger.warning("vip: %s tag write for %s answered %s", key, user_id, r.status_code)


def _get_tag(client: httpx.Client, user_id: str, key: str) -> str:
    r = client.get(f"{ZITADEL_ISSUER}/management/v1/users/{user_id}/metadata/{key}", headers=_headers())
    if r.status_code != 200:
        return ""
    raw = ((r.json() or {}).get("metadata") or {}).get("value", "")
    try:
        return base64.b64decode(raw).decode().strip()
    except (ValueError, UnicodeDecodeError):
        return ""


def accept(user_id: str, code: str, password: str) -> None:
    """Spend the invite code and set the first password. Raises InviteError."""
    if not password_ok(password):
        raise InviteError(PASSWORD_RULES)
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        r = client.post(f"{ZITADEL_ISSUER}/v2/users/{user_id}/invite_code/verify",
                        headers=_headers(), json={"verificationCode": code})
        if r.status_code not in (200, 201):
            logger.info("vip: invite verify for %s answered %s %s", user_id, r.status_code, _zerr(r))
            raise InviteError("This invite link has expired or was already used. "
                              "Ask an admin for a fresh one.")
        r = client.post(f"{ZITADEL_ISSUER}/v2/users/{user_id}/password", headers=_headers(),
                        json={"newPassword": {"password": password, "changeRequired": False}})
        if r.status_code not in (200, 201):
            logger.warning("vip: set password for %s answered %s %s", user_id, r.status_code, _zerr(r))
            raise InviteError(_zerr(r) or "Could not set that password.")
    mark_accepted(user_id)


def user_email(user_id: str) -> str:
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        r = client.get(f"{ZITADEL_ISSUER}/v2/users/{user_id}", headers=_headers())
    if r.status_code != 200:
        return ""
    human = (r.json().get("user") or {}).get("human") or {}
    return (human.get("email") or {}).get("email", "")


# ── Mattermost ──────────────────────────────────────────────────────────────

def mattermost_configured() -> bool:
    return bool(MATTERMOST_URL and MATTERMOST_TOKEN and MATTERMOST_TEAM_NAME)


def _mm_team(client: httpx.Client) -> tuple[str, str]:
    bot = {"Authorization": f"Bearer {MATTERMOST_TOKEN}"}
    team = client.get(f"{MATTERMOST_URL}/api/v4/teams/name/{MATTERMOST_TEAM_NAME}", headers=bot)
    if team.status_code != 200 or not team.json().get("invite_id"):
        raise InviteError(f"Mattermost team lookup failed ({team.status_code})")
    return team.json()["id"], team.json()["invite_id"]


def mattermost_join_url() -> str:
    """The crcmz team's invite link. Signing up through it with the Authentik →
    Zitadel button makes an SSO account that is already on the team."""
    if not mattermost_configured():
        return ""
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        return f"{MATTERMOST_URL}/signup_user_complete/?id={_mm_team(client)[1]}"


def link_mattermost(user_id: str, email: str) -> str:
    """If `email` already has a Mattermost account, put it on the crcmz team and
    write the person's `mm_username` tag. Returns the username, or '' if there is
    no account yet.

    Accounts are never created here. Mattermost signs people in through Authentik
    → Zitadel (OpenID, auth data = email), and the bot token can only make
    password accounts, which would then clash with that SSO login."""
    if not mattermost_configured():
        raise InviteError("MATTERMOST_URL / MATTERMOST_TOKEN / MATTERMOST_TEAM_NAME are not set")
    email = (email or "").strip().lower()
    bot = {"Authorization": f"Bearer {MATTERMOST_TOKEN}"}
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        r = client.get(f"{MATTERMOST_URL}/api/v4/users/email/{email}", headers=bot)
        if r.status_code == 404:
            return ""
        if r.status_code != 200:
            raise InviteError(f"Mattermost user lookup failed ({r.status_code})")
        mm = r.json()
        team_id, _ = _mm_team(client)
        tm = client.get(f"{MATTERMOST_URL}/api/v4/teams/{team_id}/members/{mm['id']}", headers=bot)
        if tm.status_code != 200:
            a = client.post(f"{MATTERMOST_URL}/api/v4/teams/{team_id}/members", headers=bot,
                            json={"team_id": team_id, "user_id": mm["id"]})
            if a.status_code not in (200, 201):
                logger.warning("vip: could not add @%s to the team: %s", mm["username"], a.status_code)
        if user_id:
            _set_tag(client, user_id, "mm_username", mm["username"])
    if user_id:
        with _lock, _conn() as c:
            c.execute("UPDATE vip_invites SET mm_username = ? WHERE zitadel_id = ? AND mm_username = ''",
                      (mm["username"], user_id))
    logger.info("vip: mattermost @%s linked to zitadel %s", mm["username"], user_id)
    return mm["username"]


def link_pending_mattermost(max_age_days: int = 30) -> int:
    """Background sweep: VIPs who have signed in to Mattermost since their invite
    get their team membership and `mm_username` tag. Returns how many it linked."""
    if not (mattermost_configured() and ZITADEL_SERVICE_TOKEN):
        return 0
    since = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - max_age_days * 86400,
                                   timezone.utc).isoformat(timespec="seconds")
    with _lock, _conn() as c:
        rows = c.execute("SELECT DISTINCT zitadel_id, email FROM vip_invites WHERE mm_username = '' "
                         "AND zitadel_id != '' AND status != 'failed' AND created_at >= ?",
                         (since,)).fetchall()
    linked = 0
    for r in rows:
        try:
            linked += bool(link_mattermost(r["zitadel_id"], r["email"]))
        except (InviteError, httpx.HTTPError) as e:
            logger.debug("vip: mattermost sweep for %s: %s", r["zitadel_id"], e)
    return linked


def mm_username_for(user_id: str) -> str:
    """The person's `mm_username` tag, or '' (portal uses this to skip the picker)."""
    if not (ZITADEL_SERVICE_TOKEN and user_id and user_id.isdigit()):
        return ""
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            return _get_tag(client, user_id, "mm_username")
    except httpx.HTTPError:
        return ""


def known_mm_username(user_id: str, email: str) -> str:
    """Their `mm_username` tag, else their Mattermost account found by email (and
    then linked). '' when they have never signed in to Mattermost."""
    name = mm_username_for(user_id)
    if name or not (email and mattermost_configured()):
        return name
    try:
        return link_mattermost(user_id, email)
    except (InviteError, httpx.HTTPError) as e:
        logger.debug("vip: mattermost lookup for %s: %s", user_id, e)
        return ""


# ── Email ───────────────────────────────────────────────────────────────────

def invite_url(user_id: str, code: str) -> str:
    return f"https://{PUBLIC_HOST}/invite?" + urlencode({"userId": user_id, "code": code})


def _layout(title: str, body_html: str, cta_label: str, cta_url: str, footnote: str) -> str:
    """Neon-arcade shell (DESIGN.md tokens), table layout and inline styles for mail clients."""
    logo = f"https://{PUBLIC_HOST}/footer-avatar.png"
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>{html.escape(title)}</title></head>
<body style="margin:0;padding:0;background:#05030f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05030f;">
<tr><td align="center" style="padding:32px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#120a26;border:1px solid #3a1f5c;border-radius:22px;">
    <tr><td style="height:4px;background:#ff2fd6;background-image:linear-gradient(90deg,#22e6ff,#ff2fd6,#9d5cff);border-radius:22px 22px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td align="center" style="padding:30px 28px 6px;">
      <img src="{logo}" width="84" height="84" alt="CRCMZ" style="display:block;border:0;">
    </td></tr>
    <tr><td align="center" style="padding:10px 28px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
      <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:#ffd24a;color:#0b0616;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">VIP Clan Member</div>
      <h1 style="margin:18px 0 0;font-size:26px;line-height:1.2;font-weight:800;color:#f3ecff;">{html.escape(title)}</h1>
    </td></tr>
    <tr><td style="padding:16px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#d9cff5;">
      {body_html}
    </td></tr>
    <tr><td align="center" style="padding:26px 28px 8px;">
      <a href="{html.escape(cta_url)}" style="display:inline-block;padding:15px 30px;border-radius:14px;background:#ff2fd6;color:#0b0616;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;font-weight:800;text-decoration:none;letter-spacing:.3px;">{html.escape(cta_label)}</a>
    </td></tr>
    <tr><td style="padding:14px 32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:12.5px;line-height:1.55;color:#9d8fc4;">
      {footnote}
    </td></tr>
  </table>
  <p style="margin:18px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:11.5px;color:#6a5d8a;">CRCMZ &middot; <a href="https://crcmz.me" style="color:#22e6ff;text-decoration:none;">crcmz.me</a></p>
</td></tr></table>
</body></html>"""


def render_invite(name: str, email: str, url: str) -> tuple[str, str, str]:
    """(subject, html, text) for a brand-new member."""
    hi = html.escape(name or "there")
    subject = "You're in — set up your CRCMZ App account"
    body = (f"<p style=\"margin:0 0 12px;\">Hey {hi},</p>"
            "<p style=\"margin:0 0 12px;\">Thanks for going VIP. You now have an account on "
            "<b style=\"color:#22e6ff;\">app.crcmz.me</b>, the squad's own app: chat into the PSN group, "
            "clips, watch parties, huddles and giveaways.</p>"
            f"<p style=\"margin:0;\">Your sign-in is <b style=\"color:#f3ecff;\">{html.escape(email)}</b>. "
            "Pick a password to finish:</p>")
    foot = ("This link works once and expires in 3 days. After you're in, add a passkey under "
            "Settings so you can skip the password next time.<br><br>"
            f"Button not working? Paste this into your browser:<br>"
            f"<a href=\"{html.escape(url)}\" style=\"color:#22e6ff;word-break:break-all;\">{html.escape(url)}</a>")
    text = (f"Hey {name or 'there'},\n\nThanks for going VIP. You now have an account on app.crcmz.me.\n"
            f"Your sign-in is {email}. Set your password here (works once, expires in 3 days):\n\n{url}\n\n— CRCMZ\n")
    return subject, _layout("Welcome to the CRCMZ App", body, "Set my password →", url, foot), text


def render_welcome(name: str, email: str) -> tuple[str, str, str]:
    """(subject, html, text) for someone who already has a working account."""
    url = f"https://{PUBLIC_HOST}/app"
    hi = html.escape(name or "there")
    subject = "You're a CRCMZ VIP"
    body = (f"<p style=\"margin:0 0 12px;\">Hey {hi},</p>"
            "<p style=\"margin:0;\">Thanks for going VIP. Your CRCMZ App account "
            f"(<b style=\"color:#f3ecff;\">{html.escape(email)}</b>) is all set — sign in the usual way.</p>")
    foot = "Forgot your password? Reply to this email and we'll sort it out."
    text = f"Hey {name or 'there'},\n\nThanks for going VIP. Sign in to the CRCMZ App: {url}\n\n— CRCMZ\n"
    return subject, _layout("You're a VIP", body, "Open the app →", url, foot), text


def _with_mattermost(html_body: str, text_body: str, mm_username: str,
                     join_url: str) -> tuple[str, str]:
    """Add the squad-chat line to either email, just above the button."""
    a = "color:#22e6ff;"
    if mm_username:
        note = ("Squad chat is on Mattermost "
                f"(<a href=\"{html.escape(MATTERMOST_URL)}\" style=\"{a}\">"
                f"{html.escape(MATTERMOST_URL.split('//')[-1])}</a>), where you are "
                f"<b style=\"color:#f3ecff;\">@{html.escape(mm_username)}</b>.")
        text = f"Squad chat: {MATTERMOST_URL} (you are @{mm_username})."
    else:
        note = (f"Squad chat is on Mattermost. <a href=\"{html.escape(join_url)}\" style=\"{a}\">"
                "Join the CRCMZ team</a>, choose <b style=\"color:#f3ecff;\">Authentik</b>, then "
                "<b style=\"color:#f3ecff;\">Zitadel</b>, and sign in with this same CRCMZ account "
                "(set your password below first).")
        text = (f"Squad chat: join the CRCMZ team on Mattermost at {join_url} — choose Authentik, "
                "then Zitadel, and sign in with this same CRCMZ account.")
    marker = '<tr><td align="center" style="padding:26px 28px 8px;">'
    html_body = html_body.replace(marker, f'<tr><td style="padding:12px 32px 0;font-family:-apple-system,'
                                  f"BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;"
                                  f'line-height:1.6;color:#d9cff5;"><p style="margin:0;">{note}</p></td></tr>'
                                  f'\n    {marker}', 1)
    text_body = text_body.replace("\n— CRCMZ", f"{text}\n\n— CRCMZ", 1)
    return html_body, text_body


def smtp_configured() -> bool:
    return bool(SMTP_USER and SMTP_PASS)


def send_email(to: str, subject: str, html_body: str, text_body: str) -> None:
    if not smtp_configured():
        raise InviteError("SMTP_USER / SMTP_PASS are not set, so no email can be sent")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((EMAIL_FROM_NAME, EMAIL_FROM_ADDRESS))
    msg["To"] = to
    if EMAIL_REPLY_TO:
        msg["Reply-To"] = EMAIL_REPLY_TO
    msg["Message-ID"] = make_msgid(domain=EMAIL_FROM_ADDRESS.split("@")[-1])
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
        s.starttls(context=ssl.create_default_context())
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


# ── The whole flow ──────────────────────────────────────────────────────────

def invite_vip(email: str, *, name: str = "", source: str = "", stripe_session_id: str = "",
               discord_username: str = "", gamer_tag: str = "", platform: str = "") -> dict:
    """Make sure `email` has an account and send the right email. Blocking (SMTP)."""
    email = (email or "").strip().lower()
    if not _EMAIL_RE.match(email):
        raise InviteError("a valid email is required")
    if not ZITADEL_SERVICE_TOKEN:
        raise InviteError("ZITADEL_SERVICE_TOKEN is not set")
    done = _already_handled(stripe_session_id)
    if done:
        return {"ok": True, "duplicate": True, "kind": done["kind"], "zitadel_id": done["zitadel_id"]}

    name = (name or gamer_tag or discord_username or "").strip()
    log = {"email": email, "source": source[:40], "stripe_session_id": stripe_session_id or None,
           "discord_username": discord_username[:100], "gamer_tag": gamer_tag[:100],
           "platform": platform[:40]}
    user_id, kind = "", ""
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            user = find_user_by_email(client, email)
            created = user is None
            user_id = _create_user(client, email, name) if created else (user.get("userId") or "")
            if not created and not name:
                name = ((user.get("human") or {}).get("profile") or {}).get("displayName", "")
            if not created and _can_sign_in(client, user_id):
                kind = "welcome"
                subject, html_body, text_body = render_welcome(name, email)
            else:
                kind = "invite"
                subject, html_body, text_body = render_invite(name, email,
                                                              invite_url(user_id, _invite_code(client, user_id)))
            _tag_vip(client, user_id)
        mm_username, join_url = "", ""
        if mattermost_configured():
            # Best effort: a Mattermost hiccup must not cost them the app invite.
            try:
                mm_username = link_mattermost(user_id, email)
                join_url = "" if mm_username else mattermost_join_url()
            except (InviteError, httpx.HTTPError) as e:
                logger.warning("vip: mattermost for %s failed: %s", email, e)
        if mm_username or join_url:
            html_body, text_body = _with_mattermost(html_body, text_body, mm_username, join_url)
        send_email(email, subject, html_body, text_body)
    except (InviteError, httpx.HTTPError, smtplib.SMTPException, OSError) as e:
        logger.warning("vip: invite for %s failed: %s", email, e)
        # A failed row does not count as handled, so the webhook retry can try again.
        _record(**{**log, "stripe_session_id": None}, zitadel_id=user_id, kind=kind,
                status="failed", error=str(e)[:300])
        raise InviteError(str(e)) from e
    _record(**log, zitadel_id=user_id, kind=kind, status="sent", mm_username=mm_username)
    logger.info("vip: %s email sent to %s (zitadel %s, source %s)", kind, email, user_id, source)
    return {"ok": True, "kind": kind, "zitadel_id": user_id, "created": created,
            "mm_username": mm_username}
