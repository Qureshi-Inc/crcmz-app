"""Audio soundboard: the squad's shared clip board, played through psaudio.

Files:
  /data/audio-board.json               — board order, labels, who added each clip
  /data/audio-sounds/<name>.wav        — uploaded audio files
  /data/audio-deck.json                — deck slot assignments (slots 0-8)
  /data/ragnaros-profiles/soundboard.yaml — written when deck changes
  /data/ragnaros-icons/sb_<name>.png   — generated icons for custom sounds

SSH:
  Key at /run/secrets/psaudio_key, host psaudio@192.168.5.151
  Uses the restricted psaudio-ctl-ssh wrapper (receive_sound / delete_sound / play).
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

AUDIO_DIR = Path("/data/audio-sounds")
DECK_FILE = Path("/data/audio-deck.json")
PROFILES_DIR = Path("/data/ragnaros-profiles")
ICONS_DIR = Path("/data/ragnaros-icons")
PSAUDIO_KEY = Path("/run/secrets/psaudio_key")
PSAUDIO_HOST = "psaudio@192.168.5.151"

BUILTIN_SOUNDS: dict[str, str] = {
    "coin":        "icons/sb_coin.png",
    "oneup":       "icons/sb_oneup.png",
    "victory":     "icons/sb_victory.png",
    "gameover":    "icons/sb_gameover.png",
    "alert":       "icons/sb_alert.png",
    "powerup":     "icons/sb_powerup.png",
    "headshot":    "icons/sb_headshot.png",
    "achievement": "icons/sb_achievement.png",
    "combo":       "icons/sb_combo.png",
}

DEFAULT_SLOTS: dict[str, dict] = {
    str(i): {"type": "builtin", "name": name}
    for i, name in enumerate(list(BUILTIN_SOUNDS))
}

# SSH command used inside soundboard.yaml actions (runs on Opti3 host)
_DECK_SSH = (
    "ssh -i /home/opti3/.ssh/id_ed25519_aicontroller"
    " -o ConnectTimeout=5 -o StrictHostKeyChecking=no"
    " psaudio@192.168.5.151"
)

# Knob block shared with macbook.yaml — copied verbatim so they stay in sync.
_KNOBS_YAML = """\
knobs:
  "0":
    rotate:
      cw:  /home/opti3/.config/ragnaros/mac_vol.sh +6
      ccw: /home/opti3/.config/ragnaros/mac_vol.sh -6
    press: /home/opti3/.config/ragnaros/mac_mute.sh

  "1":
    rotate:
      cw:  ssh -o ConnectTimeout=3 macbook "python3 ~/.brightness_step.py 0.1"
      ccw: ssh -o ConnectTimeout=3 macbook "python3 ~/.brightness_step.py -0.1"
    press: ssh -o ConnectTimeout=3 macbook "python3 ~/.brightness_step.py 0.5"

  "2":
    rotate:
      cw:  ssh -o ConnectTimeout=3 macbook "osascript -e 'tell application \\"Music\\" to next track' 2>/dev/null || true"
      ccw: ssh -o ConnectTimeout=3 macbook "osascript -e 'tell application \\"Music\\" to previous track' 2>/dev/null || true"
    press: ssh -o ConnectTimeout=3 macbook "osascript -e 'tell application \\"Music\\" to playpause' 2>/dev/null || true"

  "3":
    rotate:
      cw:  /home/opti3/.config/ragnaros/deck_brightness.sh 10
      ccw: /home/opti3/.config/ragnaros/deck_brightness.sh -10
    press: ragnarosctl brightness 100
"""


def _valid_name(name: str) -> bool:
    return bool(re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", name))


def _ensure_dirs() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)


def _ssh(args: list[str], stdin: bytes | None = None) -> subprocess.CompletedProcess:
    if not PSAUDIO_KEY.exists():
        raise RuntimeError("psaudio SSH key not mounted at /run/secrets/psaudio_key")
    cmd = [
        "ssh", "-i", str(PSAUDIO_KEY),
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "BatchMode=yes",
        PSAUDIO_HOST,
    ] + args
    return subprocess.run(cmd, capture_output=True, input=stdin, timeout=30)


# ── Public API ────────────────────────────────────────────────────────────────

def list_sounds() -> list[dict]:
    _ensure_dirs()
    out = []
    for f in sorted(AUDIO_DIR.glob("*.wav")):
        out.append({"name": f.stem, "size": f.stat().st_size, "type": "custom"})
    return out


def save_sound(name: str, data: bytes) -> None:
    if not _valid_name(name):
        raise ValueError(f"Invalid name: {name!r}")
    _ensure_dirs()
    (AUDIO_DIR / f"{name}.wav").write_bytes(data)
    try:
        r = _ssh(["receive_sound", name], stdin=data)
        if r.returncode != 0:
            logger.warning("psaudio receive_sound failed for %s: %s", name, r.stderr)
    except Exception as exc:
        logger.warning("psaudio sync error for %s: %s", name, exc)
    try:
        _gen_icon(name)
    except Exception as exc:
        logger.warning("icon gen failed for %s: %s", name, exc)


def delete_sound(name: str) -> None:
    if not _valid_name(name):
        raise ValueError(f"Invalid name: {name!r}")
    (AUDIO_DIR / f"{name}.wav").unlink(missing_ok=True)
    (ICONS_DIR / f"sb_{name}.png").unlink(missing_ok=True)
    try:
        _ssh(["delete_sound", name])
    except Exception as exc:
        logger.warning("psaudio delete error for %s: %s", name, exc)
    _forget(name)
    # Remove from deck if assigned
    deck = get_deck()
    changed = False
    for slot, info in list(deck["slots"].items()):
        if info and info.get("type") == "custom" and info.get("name") == name:
            deck["slots"][slot] = None
            changed = True
    if changed:
        _save_deck(deck)
        _write_soundboard_yaml(deck)


def play_sound(name: str) -> bool:
    if not (name in BUILTIN_SOUNDS or _valid_name(name)):
        return False
    try:
        r = _ssh(["play", name])
        return r.returncode == 0
    except Exception as exc:
        logger.warning("play_sound error for %s: %s", name, exc)
        return False


# ── Shared board ──────────────────────────────────────────────────────────────
# The clip library is the Pi itself: clips added here, in Deck Manager or on the
# stream deck all land in the same place, so everyone sees one board. This file
# only adds what the Pi doesn't keep: the board's order, display labels and who
# added each clip.
BOARD_FILE = Path("/data/audio-board.json")
MAX_CLIP_SECONDS = 60
_board_lock = threading.Lock()
_pi_cache: dict = {"t": 0.0, "names": None}


def _pi_sounds(fresh: bool = False) -> list[str]:
    """Clip names on the Pi (cached 15 s); local copies if the Pi is unreachable."""
    if not fresh and _pi_cache["names"] is not None and time.monotonic() - _pi_cache["t"] < 15:
        return _pi_cache["names"]
    try:
        r = _ssh(["sounds"])
        if r.returncode == 0:
            names = [l.strip() for l in r.stdout.decode(errors="replace").splitlines()
                     if l.strip() and not l.lower().startswith("available") and _valid_name(l.strip())]
            _pi_cache.update(t=time.monotonic(), names=names)
            return names
        logger.warning("psaudio sounds failed: %s", r.stderr[:200])
    except Exception as exc:
        logger.warning("psaudio sounds error: %s", exc)
    if _pi_cache["names"] is not None:
        return _pi_cache["names"]
    return [f.stem for f in sorted(AUDIO_DIR.glob("*.wav"))]


def _load_board() -> dict:
    try:
        data = json.loads(BOARD_FILE.read_text())
        if isinstance(data, dict):
            return {"order": [n for n in data.get("order", []) if isinstance(n, str)],
                    "labels": dict(data.get("labels") or {}), "meta": dict(data.get("meta") or {})}
    except (OSError, ValueError):
        pass
    return {"order": [], "labels": {}, "meta": {}}


def _save_board(board: dict) -> None:
    tmp = BOARD_FILE.with_name(f".{BOARD_FILE.name}.tmp")
    tmp.write_text(json.dumps(board, indent=1))
    tmp.replace(BOARD_FILE)


def _pretty(name: str) -> str:
    return re.sub(r"[_-]+", " ", name).strip() or name


def board(fresh: bool = False) -> dict:
    """The shared board, in its saved order; clips new to the board go last."""
    names = [n for n in _pi_sounds(fresh) if n not in BUILTIN_SOUNDS]
    with _board_lock:
        b = _load_board()
    present = set(names)
    order = [n for n in dict.fromkeys(b["order"]) if n in present]
    order += sorted((n for n in names if n not in order),
                    key=lambda n: (b["meta"].get(n, {}).get("at", 0), n))
    items = []
    for n in order:
        meta = b["meta"].get(n, {})
        items.append({"name": n, "label": b["labels"].get(n) or _pretty(n),
                      "by": meta.get("by"), "at": meta.get("at"), "source": meta.get("source")})
    return {"sounds": items, "builtins": [n for n in BUILTIN_SOUNDS if n in set(_pi_sounds())] or list(BUILTIN_SOUNDS)}


def _to_wav(data: bytes) -> bytes:
    """Any audio/video container -> 48 kHz mono 16-bit WAV, trimmed to MAX_CLIP_SECONDS."""
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in", Path(tmp) / "out.wav"
        src.write_bytes(data)
        r = subprocess.run(["ffmpeg", "-nostdin", "-y", "-i", str(src), "-vn", "-t", str(MAX_CLIP_SECONDS),
                            "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", str(dst)],
                           capture_output=True, timeout=120)
        if r.returncode != 0 or not dst.exists() or dst.stat().st_size < 1024:
            raise ValueError("That file doesn't have audio we can read")
        return dst.read_bytes()


def safe_name(raw: str) -> str:
    name = re.sub(r"[^a-z0-9_-]+", "-", (raw or "").lower()).strip("-_")[:36]
    return name or "clip"


def _unique(name: str) -> str:
    taken = set(_pi_sounds(fresh=True)) | set(BUILTIN_SOUNDS) | {f.stem for f in AUDIO_DIR.glob("*.wav")}
    out, n = name, 2
    while out in taken:
        out = f"{name[:33]}-{n}"
        n += 1
    return out


def add_sound(data: bytes, *, name: str, label: str = "", source: str = "upload",
              by: str | None = None, url: str | None = None) -> dict:
    """Convert, push to the Pi and put a clip at the end of the shared board."""
    _ensure_dirs()
    wav = _to_wav(data)
    name = _unique(safe_name(name))
    r = _ssh(["receive_sound", name], stdin=wav)
    if r.returncode != 0:
        raise RuntimeError("The squad Pi didn't take the clip — try again in a moment")
    (AUDIO_DIR / f"{name}.wav").write_bytes(wav)
    _pi_cache["t"] = 0.0
    try:
        _gen_icon(name)
    except Exception as exc:
        logger.warning("icon gen failed for %s: %s", name, exc)
    current = [s["name"] for s in board(fresh=True)["sounds"] if s["name"] != name]
    with _board_lock:
        b = _load_board()
        b["order"] = current + [name]  # pin today's order so the new clip lands last
        if label.strip():
            b["labels"][name] = label.strip()[:40]
        b["meta"][name] = {k: v for k, v in {"by": by, "at": int(time.time()), "source": source, "url": url}.items() if v}
        _save_board(b)
    return {"name": name, "label": label.strip()[:40] or _pretty(name)}


def reorder(order: list[str]) -> None:
    with _board_lock:
        b = _load_board()
        b["order"] = [n for n in dict.fromkeys(order) if isinstance(n, str) and _valid_name(n)]
        _save_board(b)


def rename(name: str, label: str) -> None:
    if not _valid_name(name):
        raise ValueError(f"Invalid name: {name!r}")
    with _board_lock:
        b = _load_board()
        if label.strip():
            b["labels"][name] = label.strip()[:40]
        else:
            b["labels"].pop(name, None)
        _save_board(b)


def _forget(name: str) -> None:
    with _board_lock:
        b = _load_board()
        b["order"] = [n for n in b["order"] if n != name]
        b["labels"].pop(name, None)
        b["meta"].pop(name, None)
        _save_board(b)
    _pi_cache["t"] = 0.0


def get_deck() -> dict:
    if DECK_FILE.exists():
        try:
            data = json.loads(DECK_FILE.read_text())
            slots = data.get("slots", {})
            for i in range(9):
                if str(i) not in slots:
                    slots[str(i)] = DEFAULT_SLOTS.get(str(i))
            data["slots"] = slots
            return data
        except Exception:
            pass
    return {"slots": dict(DEFAULT_SLOTS)}


def _save_deck(deck: dict) -> None:
    DECK_FILE.write_text(json.dumps(deck, indent=2))


def set_deck(slots: dict[str, dict | None]) -> None:
    for slot_str, info in slots.items():
        if not slot_str.isdigit() or not (0 <= int(slot_str) <= 8):
            raise ValueError(f"Invalid slot: {slot_str!r}")
        if info is not None:
            t = info.get("type")
            n = info.get("name", "")
            if t == "builtin" and n not in BUILTIN_SOUNDS:
                raise ValueError(f"Unknown builtin: {n!r}")
            if t == "custom" and not _valid_name(n):
                raise ValueError(f"Invalid custom name: {n!r}")
    deck = get_deck()
    deck["slots"].update(slots)
    _save_deck(deck)
    _write_soundboard_yaml(deck)


def _icon_for(info: dict | None) -> str:
    if info is None:
        return "icons/sb_home.png"
    if info.get("type") == "builtin":
        return BUILTIN_SOUNDS.get(info["name"], "icons/sb_alert.png")
    name = info.get("name", "")
    icon_file = ICONS_DIR / f"sb_{name}.png"
    return f"icons/sb_{name}.png" if icon_file.exists() else "icons/sb_alert.png"


_TOP_KEY = re.compile(r"^([A-Za-z_][\w-]*):")
_KEY_HDR = re.compile(r'^  ["\']?(\d+)["\']?:\s*$')


def _split_sections(text: str) -> list[tuple[str | None, list[str]]]:
    """Top-level YAML sections in file order: (key or None for preamble, lines)."""
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    for line in text.splitlines():
        m = _TOP_KEY.match(line)
        if m:
            sections.append((m.group(1), [line]))
        else:
            sections[-1][1].append(line)
    return sections


def _key_entries(lines: list[str]) -> dict[str, list[str]]:
    """keys: block -> {"0": [header, body lines...]} (two-space indented entries)."""
    entries: dict[str, list[str]] = {}
    current = None
    for line in lines[1:]:
        m = _KEY_HDR.match(line)
        if m:
            current = m.group(1)
            entries[current] = [line]
        elif current is not None and (line.startswith("    ") or not line.strip()):
            entries[current].append(line)
        else:
            current = None
    return entries


def _entry_action(entry: list[str]) -> str | None:
    for line in entry[1:]:
        if line.startswith("    action:"):
            return line.split(":", 1)[1].strip()
    return None


def _write_soundboard_yaml(deck: dict) -> None:
    """Rewrite only keys 0-8 of soundboard.yaml (the slots this page owns).

    Everything else in the file — knobs, strip, layers, key 9, and the icon or
    extra fields a slot was given in Deck Manager while its sound stays the
    same — is kept verbatim, so editing the deck here never undoes changes
    made elsewhere. A key marked `pinned: true` (e.g. the AI BUDDY keys) is
    never touched, even inside 0-8.
    """
    _ensure_dirs()
    prof = PROFILES_DIR / "soundboard.yaml"
    try:
        text = prof.read_text()
    except OSError:
        text = ""
    sections = _split_sections(text) if text.strip() else [(None, []), ("name", ["name: soundboard", ""])]
    keys_idx = next((i for i, (k, _) in enumerate(sections) if k == "keys"), None)
    old = _key_entries(sections[keys_idx][1]) if keys_idx is not None else {}

    entries: dict[str, list[str]] = {}
    for i in range(9):
        prev = old.get(str(i))
        if prev and any(l.strip() == "pinned: true" for l in prev):
            entries[str(i)] = [l for l in prev if l.strip()]
            continue
        info = deck["slots"].get(str(i))
        if info is None:
            entries[str(i)] = [f'  "{i}":', f"    icon: {_icon_for(None)}"]
            continue
        action = f'{_DECK_SSH} "play {info["name"]}"'
        prev = old.get(str(i))
        if prev and _entry_action(prev) == action:
            entries[str(i)] = [l for l in prev if l.strip()]
        else:
            entries[str(i)] = [f'  "{i}":', f"    icon: {_icon_for(info)}", f"    action: {action}"]
    for k, entry in old.items():
        if k not in entries:
            entries[k] = [l for l in entry if l.strip()]
    entries.setdefault("9", ['  "9":', "    icon: icons/sb_home.png", "    action: ragnarosctl profile macbook"])
    block = ["keys:"] + [l for k in sorted(entries, key=int) for l in entries[k]] + [""]

    if keys_idx is None:
        sections.append(("keys", block))
    else:
        sections[keys_idx] = ("keys", block)
    if not any(k == "knobs" for k, _ in sections):
        sections.append(("knobs", _KNOBS_YAML.rstrip("\n").splitlines()))
    content = "\n".join(l for _, lines in sections for l in lines).rstrip("\n") + "\n"
    tmp = prof.with_name(f".{prof.name}.tmp")
    tmp.write_text(content)
    tmp.replace(prof)  # atomic: ragnarosd hot-reloads on mtime and must never read half a file
    logger.info("wrote soundboard.yaml keys 0-8 (%d bytes)", len(content))


def _gen_icon(name: str) -> None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        logger.debug("Pillow not installed, skipping custom icon generation")
        return
    _ensure_dirs()
    W, H = 72, 72
    img = Image.new("RGB", (W, H), (15, 15, 18))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([4, 4, W - 4, H - 4], radius=8, fill=(19, 19, 30), outline=(20, 20, 40), width=1)
    # Speaker body
    d.polygon([(20, 29), (20, 43), (27, 43), (34, 50), (34, 22), (27, 29)], fill=(0, 200, 255))
    # Sound waves
    d.arc([36, 26, 46, 46], start=315, end=45, fill=(0, 200, 255), width=2)
    d.arc([40, 22, 54, 50], start=315, end=45, fill=(0, 200, 255), width=2)
    # Label (up to 6 chars)
    label = name[:6].upper()
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 9)
    except Exception:
        font = ImageFont.load_default()
    bbox = d.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    d.text(((W - tw) // 2, H - 16), label, fill=(236, 238, 245), font=font)
    (ICONS_DIR / f"sb_{name}.png").write_bytes(_png_bytes(img))


def _png_bytes(img) -> bytes:
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
