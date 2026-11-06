#!/usr/bin/env python3
"""PSN clip download: the direct MP4 link and the HLS fallback.

In Nov 2026 PSN started handing out signed MP4 links that CloudFront answers with
403 AccessDenied while the HLS stream of the same clip plays fine. download_clip
only tried the MP4, so those clips failed five times and never reached WhatsApp.

Everything here is served by a local HTTP server (PSN is never called): the
gameMediaService lookup is stubbed and the URL allowlist is relaxed for 127.0.0.1.
Needs ffmpeg/ffprobe, so run it in the image:

    python tests/test_clip_download.py
"""
import http.server
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psn_messaging as pm  # noqa: E402

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓ %s" % name)
    except Exception as exc:  # noqa: BLE001
        FAILED.append((name, exc))
        print("  ✗ %s -> %s: %s" % (name, type(exc).__name__, exc))


# ── Fixtures: a tiny HLS clip, a real MP4, and a server that 403s on demand ──

_root = Path(tempfile.mkdtemp())
_hls = _root / "clip"
_hls.mkdir()


def _ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
                    "-f", "lavfi", "-i", "sine=duration=2",
                    "-c:v", "libx264", "-c:a", "aac", *args], check=True)


_ffmpeg("-hls_time", "1", "-hls_playlist_type", "vod", "-f", "hls",
        str(_hls / "variant.m3u8"))
(_hls / "master.m3u8").write_text(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant.m3u8\n")
_ffmpeg("-movflags", "+faststart", str(_hls / "good.mp4"))

SEEN: list[str] = []


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(_root), **kw)

    def do_GET(self):  # noqa: N802
        SEEN.append(self.path.split("?")[0])
        if self.path.startswith("/clip/missing.mp4"):
            # What CloudFront/S3 sends for the broken MP4 links.
            body = b'<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'
            self.send_response(403)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d/clip/" % _srv.server_address[1]
SIG = "?Expires=1&Signature=x&Key-Pair-Id=k"

# The real check rejects http and loopback; these URLs are our own test server.
pm._validate_psn_url = lambda url: None


def _messenger(urls):
    m = pm.PSNMessenger(auth=None, group_id="g")
    m._get_clip_urls = lambda ugc_id: urls
    return m


# ── Tests ────────────────────────────────────────────────────────────────────

def test_direct_403_falls_back_to_hls():
    SEEN.clear()
    m = _messenger({"downloadUrl": BASE + "missing.mp4" + SIG,
                    "videoUrl": BASE + "master.m3u8" + SIG})
    got = m.download_clip("psn-test")
    assert "/clip/missing.mp4" in SEEN, SEEN
    assert "/clip/master.m3u8" in SEEN, SEEN
    assert got.data[4:8] == b"ftyp", got.data[:16]
    assert got.duration_seconds and got.duration_seconds > 1, got.duration_seconds
    assert got.video_codec == "h264", got.video_codec


def test_direct_403_without_hls_still_fails():
    m = _messenger({"downloadUrl": BASE + "missing.mp4" + SIG})
    try:
        m.download_clip("psn-test")
    except pm.ClipError as exc:
        assert "HTTP 403" in str(exc), exc
    else:
        raise AssertionError("expected ClipError")


def test_working_direct_mp4_is_used_and_hls_untouched():
    SEEN.clear()
    m = _messenger({"downloadUrl": BASE + "good.mp4" + SIG,
                    "videoUrl": BASE + "master.m3u8" + SIG})
    got = m.download_clip("psn-test")
    assert SEEN == ["/clip/good.mp4"], SEEN
    assert got.data == (_hls / "good.mp4").read_bytes()


if __name__ == "__main__":
    print("test_clip_download")
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name, fn)
    _srv.shutdown()
    if FAILED:
        print("%d failed" % len(FAILED))
        sys.exit(1)
    print("all passed")
