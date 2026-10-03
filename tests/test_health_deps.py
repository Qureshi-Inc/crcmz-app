#!/usr/bin/env python3
"""The status page's dependency checks (health_deps.py) and /health/<dep>.

Plain asserts, no pytest — run inside the app image where the deps live:

    tests/run-all.sh test_health_deps

Nothing leaves the box: every check is replaced with a fake.
"""

import asyncio
import os
import sys

os.environ.setdefault("SESSION_SECRET", "test-secret-for-health-tests")
os.environ.setdefault("NPSSO_TOKEN", "test-npsso")
os.environ.setdefault("GROUP_ID", "test-group")
os.environ.setdefault("PORTAL_PUBLIC_HOST", "app.crcmz.me")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import health_deps as hd  # noqa: E402

FAILED: list[str] = []
PASSED = 0


def check(name, fn):
    global PASSED
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        FAILED.append(f"{name}: {type(e).__name__}: {e}")
        print(f"  ✗ {name}\n      {type(e).__name__}: {e}")
    else:
        PASSED += 1
        print(f"  ✓ {name}")


CALLS: list[str] = []


def fake(name, ok=True, detail="fine", raise_=None):
    async def fn():
        CALLS.append(name)
        if raise_:
            raise raise_
        return ok, detail
    return fn


def tests():
    from fastapi.testclient import TestClient
    import httpx
    import server
    client = TestClient(server.app, base_url="https://app.crcmz.me")
    for n, (label, _) in list(hd.CHECKS.items()):
        hd.CHECKS[n] = (label, fake(n))
    hd.CHECKS["jellyfin"] = ("Jellyfin", fake("jellyfin", ok=False, detail="answered 502"))
    hd.CHECKS["tts"] = ("TTS", fake("tts", raise_=httpx.ConnectTimeout("x")))

    def each_dependency_answers_without_a_session():
        hd._cache.clear()
        r = client.get("/health/ai")
        assert r.status_code == 200 and r.json()["ok"] is True and r.json()["detail"] == "fine", r.text
        r = client.get("/health/jellyfin")
        assert r.status_code == 503 and r.json()["detail"] == "answered 502", r.text
        r = client.get("/health/tts")
        assert r.status_code == 503 and "unreachable" in r.json()["detail"], r.text
        assert client.get("/health/nope").status_code in (401, 404)

    def all_says_which_are_down():
        hd._cache.clear()
        r = client.get("/health/all")
        assert r.status_code == 503 and set(r.json()["down"]) == {"jellyfin", "tts"}, r.text
        assert len(r.json()["checks"]) == len(hd.CHECKS)

    def results_are_cached():
        hd._cache.clear()
        CALLS.clear()
        client.get("/health/ai")
        client.get("/health/ai")
        assert CALLS.count("ai") == 1

    def nothing_secret_comes_back():
        hd._cache.clear()
        body = client.get("/health/all").text.lower()
        for word in ("token", "bearer", "key=", "secret", "password"):
            assert word not in body, word

    for fn in (each_dependency_answers_without_a_session, all_says_which_are_down, results_are_cached, nothing_secret_comes_back):
        check(fn.__name__, fn)


if __name__ == "__main__":
    tests()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
