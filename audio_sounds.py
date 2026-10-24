"""Audio soundboard: user-uploadable sounds for the stream deck and psaudio.

Files:
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


def _write_soundboard_yaml(deck: dict) -> None:
    _ensure_dirs()
    lines = ["name: soundboard", "", "keys:"]
    for i in range(9):
        info = deck["slots"].get(str(i))
        icon = _icon_for(info)
        if info is None:
            lines += [f'  "{i}":', f'    icon: {icon}']
            continue
        name = info["name"]
        action = f'{_DECK_SSH} "play {name}"'
        lines += [f'  "{i}":', f'    icon: {icon}', f'    action: {action}']
    lines += [
        '  "9":',
        '    icon: icons/sb_home.png',
        '    action: ragnarosctl profile macbook',
        '',
    ]
    content = "\n".join(lines) + "\n" + _KNOBS_YAML
    prof = PROFILES_DIR / "soundboard.yaml"
    prof.write_text(content)
    logger.info("wrote soundboard.yaml (%d bytes)", len(content))


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
