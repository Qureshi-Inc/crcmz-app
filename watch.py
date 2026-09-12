"""Watch Party identity broker.

psn.crcmz.me is the *only* thing that knows who a person is. WatchParty (our
self-hosted fork) never sees a Zitadel token and never asks the browser "who
are you?" — instead this module mints a short-lived, ES256-signed *Watch
Ticket* that the browser hands to WatchParty during the Socket.IO handshake.

    Zitadel ──OIDC──> psn.crcmz.me session ──POST /api/watch/join──> ticket
                                                     │
                                          Socket.IO handshake auth
                                                     ▼
                                            WatchParty (verifies)

Trust rules encoded here:

  * the permanent identity is the verified OIDC ``issuer + subject`` pair, never
    an email / login name / PSN id / nickname (those all change)
  * the ticket exposes only an opaque ``viewerId`` = base64url(sha256(iss\\0sub))
  * the display name is resolved server-side and signed into the ticket, so the
    browser cannot pick its own room identity
  * the signing key is dedicated to Watch Tickets: it is not the session
    secret and not anything Zitadel-related

The private key lives only in this process (env var, or auto-generated into
/data so a fresh deploy needs no manual key wrangling). WatchParty gets the
public half via env var or the JWKS endpoint.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

PUBLIC_HOST = os.environ.get("PORTAL_PUBLIC_HOST", "psn.crcmz.me")

# "zitadel-ticket" (ours) or "firebase" (upstream WatchParty behaviour). Sent to
# the browser so the UI can explain itself; WatchParty has the same flag.
AUTH_MODE = os.environ.get("WATCH_AUTH_MODE", "zitadel-ticket")

TICKET_ISSUER   = os.environ.get("WATCH_TICKET_ISSUER", f"https://{PUBLIC_HOST}")
TICKET_AUDIENCE = os.environ.get("WATCH_TICKET_AUDIENCE", "crcmz-watchparty")

# 60s preferred, 90s hard maximum — the ticket only has to survive long enough
# to open a WebSocket, not the length of a movie.
_TTL_RAW    = os.environ.get("WATCH_TICKET_TTL_SECONDS", "60")
TICKET_TTL  = max(15, min(90, int(_TTL_RAW) if _TTL_RAW.isdigit() else 60))

# Where the browser reaches WatchParty. Empty = same origin as this app
# (Traefik routes https://psn.crcmz.me/wp → the WatchParty container).
WATCHPARTY_ORIGIN = os.environ.get("WATCHPARTY_ORIGIN", "").rstrip("/")
SOCKET_PATH       = os.environ.get("WATCH_SOCKET_PATH", "/wp/socket.io")

# Rooms this app is willing to issue tickets for. WatchParty keeps the same
# list so the namespaces always exist.
_ROOMS_RAW = os.environ.get("WATCH_ROOMS", "crcmz")

_DATA_DIR = Path(os.environ.get("WATCH_DATA_DIR", "/data/watch"))
_KEY_FILE = _DATA_DIR / "ticket_ec_p256.pem"
_NICKS    = _DATA_DIR / "nicknames.json"

_ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class WatchConfigError(RuntimeError):
    """Raised when Watch Party cannot operate (e.g. no signing key)."""


# ── Rooms ────────────────────────────────────────────────────────────────────


def canonical_room(raw: object) -> str | None:
    """Normalise a room id, or return None when it isn't a legal room.

    WatchParty namespaces are "/<room>"; we canonicalise to the bare slug and
    compare canonical forms on both sides so "/CRCMZ" and "crcmz" can't be used
    to smuggle a ticket into a different room.
    """
    if not isinstance(raw, str):
        return None
    slug = raw.strip().lstrip("/").lower()
    if not _ROOM_RE.match(slug):
        return None
    return slug


def allowed_rooms() -> list[str]:
    rooms = [canonical_room(r) for r in _ROOMS_RAW.split(",")]
    out = [r for r in rooms if r]
    return out or ["crcmz"]


def is_allowed_room(room: str) -> bool:
    return room in allowed_rooms()


# ── Stable viewer identity ───────────────────────────────────────────────────


def viewer_id(issuer: str, subject: str) -> str:
    """Opaque, stable, per-person id derived from the verified OIDC pair.

    Not reversible, so handing it to other viewers leaks nothing about the
    Zitadel account. Stable, so a rename never creates a "new" person.
    """
    if not issuer or not subject:
        raise ValueError("issuer and subject are required")
    digest = hashlib.sha256(f"{issuer}\0{subject}".encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def short_viewer(vid: str) -> str:
    """Log-safe abbreviation — enough to correlate, useless to an attacker."""
    return (vid or "")[:8]


# ── Display name ─────────────────────────────────────────────────────────────

_MAX_NAME = 50
# Unicode categories to drop outright: control, format, surrogate, private use,
# unassigned. Whitespace is collapsed separately so "a\nb" becomes "a b".
_DROP_CATEGORIES = {"Cc", "Cf", "Cs", "Co", "Cn"}


def sanitize_display_name(raw: object) -> str:
    """Trim, strip control chars/markup, cap at 50 chars. Never returns "".

    Applied to *every* source (nickname, PSN id, Zitadel claims) so nothing
    downstream — chat, presence, the roster — can be used for HTML injection or
    to fake another viewer's line with newlines.
    """
    if not isinstance(raw, str):
        return ""
    name = unicodedata.normalize("NFC", raw[: _MAX_NAME * 8])
    name = "".join(
        " " if ch in "\t\r\n" else ch
        for ch in name
        if unicodedata.category(ch) not in _DROP_CATEGORIES or ch in "\t\r\n"
    )
    name = name.replace("<", "").replace(">", "").replace("&", "")
    name = re.sub(r"\s+", " ", name).strip()
    return name[:_MAX_NAME].strip()


def resolve_display_name(
    *,
    nickname: str = "",
    psn_online_id: str = "",
    zitadel_name: str = "",
    preferred_username: str = "",
) -> str:
    """The one place a Watch Party name is decided.

    Priority: saved nickname → linked PSN username → Zitadel ``name`` →
    Zitadel ``preferred_username`` (a *login name*, e.g. "moiz@example-domain",
    hence last) → "Viewer".
    """
    for candidate in (nickname, psn_online_id, zitadel_name, preferred_username):
        clean = sanitize_display_name(candidate)
        if clean:
            return clean
    return "Viewer"


# ── Nickname store ───────────────────────────────────────────────────────────
# One tiny JSON file keyed by Zitadel subject. The app has no SQL database, so
# this matches how PSN links are already persisted (JSON under /data).

_nick_lock = threading.Lock()


def _read_nicks() -> dict:
    try:
        return json.loads(_NICKS.read_text())
    except Exception:  # noqa: BLE001 — missing/corrupt file is not fatal
        return {}


def get_nickname(subject: str) -> str:
    if not subject:
        return ""
    return sanitize_display_name(_read_nicks().get(subject, ""))


def set_nickname(subject: str, raw: str) -> str:
    """Save (or clear, when empty) a nickname. Returns the stored value."""
    if not subject:
        raise ValueError("subject required")
    clean = sanitize_display_name(raw)
    with _nick_lock:
        nicks = _read_nicks()
        if clean:
            nicks[subject] = clean
        else:
            nicks.pop(subject, None)
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _NICKS.with_suffix(".tmp")
        tmp.write_text(json.dumps(nicks, indent=2))
        tmp.replace(_NICKS)
    return clean


# ── Signing key ──────────────────────────────────────────────────────────────
# Dedicated ES256 (P-256) key. NOT the session secret, NOT a Zitadel secret.
# Resolution order:
#   1. WATCH_TICKET_PRIVATE_KEY      (PEM, may contain literal \n)
#   2. WATCH_TICKET_PRIVATE_KEY_B64  (base64 of the PEM — deploy-UI friendly)
#   3. /data/watch/ticket_ec_p256.pem, generated on first use (mode 600)

_key_lock = threading.Lock()
_key_cache: dict = {}


def _load_pem_from_env() -> bytes | None:
    pem = os.environ.get("WATCH_TICKET_PRIVATE_KEY", "").strip()
    if pem:
        return pem.replace("\\n", "\n").encode()
    b64 = os.environ.get("WATCH_TICKET_PRIVATE_KEY_B64", "").strip()
    if b64:
        try:
            return base64.b64decode(b64, validate=True)
        except Exception as e:  # noqa: BLE001
            raise WatchConfigError(f"WATCH_TICKET_PRIVATE_KEY_B64 is not valid base64: {e}") from e
    return None


def _signing_key() -> dict:
    """Return {"private": obj, "public": obj, "kid": str, "source": str}."""
    with _key_lock:
        if _key_cache:
            return _key_cache

        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ec
        except ImportError as e:  # pragma: no cover - dependency is pinned
            raise WatchConfigError("cryptography is required for Watch Tickets") from e

        pem = _load_pem_from_env()
        source = "env"
        if pem is None:
            source = "file"
            if _KEY_FILE.exists():
                pem = _KEY_FILE.read_bytes()
            else:
                key = ec.generate_private_key(ec.SECP256R1())
                pem = key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.PKCS8,
                    encryption_algorithm=serialization.NoEncryption(),
                )
                _DATA_DIR.mkdir(parents=True, exist_ok=True)
                _KEY_FILE.touch(mode=0o600, exist_ok=True)
                _KEY_FILE.write_bytes(pem)
                os.chmod(_KEY_FILE, 0o600)
                source = "generated"
                logger.info("watch: generated new ES256 ticket key at %s", _KEY_FILE)

        private = serialization.load_pem_private_key(pem, password=None)
        if not isinstance(private, ec.EllipticCurvePrivateKey) or private.curve.name != "secp256r1":
            raise WatchConfigError("Watch Ticket key must be an EC P-256 (secp256r1) private key")

        public = private.public_key()
        # Deterministic kid so rotation is observable and cache-friendly.
        raw_pub = public.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        kid = os.environ.get("WATCH_TICKET_KID", "") or (
            "watch-" + hashlib.sha256(raw_pub).hexdigest()[:12]
        )
        _key_cache.update({"private": private, "public": public, "kid": kid, "source": source})
        return _key_cache


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def public_jwk() -> dict:
    """Public half of the signing key as a JWK (safe to serve publicly)."""
    key = _signing_key()
    numbers = key["public"].public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "alg": "ES256",
        "use": "sig",
        "kid": key["kid"],
        "x": _b64u(numbers.x.to_bytes(32, "big")),
        "y": _b64u(numbers.y.to_bytes(32, "big")),
    }


def jwks() -> dict:
    return {"keys": [public_jwk()]}


def public_key_pem() -> str:
    """PEM of the public key — what you paste into WATCH_TICKET_PUBLIC_KEY."""
    from cryptography.hazmat.primitives import serialization

    return _signing_key()["public"].public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()


def key_id() -> str:
    return _signing_key()["kid"]


def key_source() -> str:
    return _signing_key()["source"]


# ── Ticket minting ───────────────────────────────────────────────────────────


def mint_ticket(*, viewer: str, room: str, display_name: str) -> dict:
    """Sign a Watch Ticket. Returns {"ticket", "expires_in", "jti", "kid"}.

    Only ever called after the caller has proven, via the existing Zitadel
    session, who the person is.
    """
    import jwt as _pyjwt  # PyJWT, imported lazily so import errors surface here

    key = _signing_key()
    now = int(time.time())
    jti = str(uuid.uuid4())
    payload = {
        "iss": TICKET_ISSUER,
        "aud": TICKET_AUDIENCE,
        "sub": viewer,
        "room": room,
        "name": display_name,
        "iat": now,
        "exp": now + TICKET_TTL,
        "jti": jti,
    }
    token = _pyjwt.encode(
        payload,
        key["private"],
        algorithm="ES256",
        headers={"kid": key["kid"], "typ": "JWT"},
    )
    if isinstance(token, bytes):  # PyJWT < 2 compatibility
        token = token.decode()
    return {"ticket": token, "expires_in": TICKET_TTL, "jti": jti, "kid": key["kid"]}


# ── Client config ────────────────────────────────────────────────────────────


def client_config() -> dict:
    """Non-secret settings the /watch page needs. Never includes key material."""
    return {
        "authMode": AUTH_MODE,
        "origin": WATCHPARTY_ORIGIN,   # "" = same origin
        "socketPath": SOCKET_PATH,
        "rooms": allowed_rooms(),
        "defaultRoom": allowed_rooms()[0],
        "ticketTtl": TICKET_TTL,
    }
