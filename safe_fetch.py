"""Fetching a URL someone gave us, without letting it reach our own network.

The share sheet, the Watch Party's extract and its media proxy all fetch caller-supplied
URLs. Checked once up front, that is still a way in: a public page can redirect to
http://jellyfin:8096 or 169.254.169.254, and a name can resolve to a public address for
the check and a private one a moment later for the fetch (DNS rebinding).

`PublicOnlyTransport` closes both. It sits under httpx, so it sees every request,
redirect hops included. For each one it resolves the host itself, refuses unless every
address is public, then connects to the address it checked (TLS still verified against
the real name). Use `client()` for an httpx.AsyncClient built on it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket

import httpx


class Blocked(httpx.ConnectError):
    """The URL points at a private, local or otherwise non-public address."""


def _public(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if getattr(a, "ipv4_mapped", None):
        a = a.ipv4_mapped
    return not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast
                or a.is_reserved or a.is_unspecified or not a.is_global)


async def public_address(host: str, port: int) -> str:
    """The address to connect to for `host`, if every address it has is public."""
    if not host:
        raise Blocked("no host")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise httpx.ConnectError(f"can't resolve {host}") from e
    ips = [i[4][0] for i in infos]
    if not ips or not all(_public(ip) for ip in ips):
        raise Blocked(f"{host} is not a public address")
    return ips[0]


class PublicOnlyTransport(httpx.AsyncHTTPTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.scheme not in ("http", "https"):
            raise Blocked(f"{url.scheme} isn't fetched")
        host = url.host
        ip = await public_address(host, url.port or (443 if url.scheme == "https" else 80))
        if ip == host:
            return await super().handle_async_request(request)
        # Connect to the address we checked; Host and SNI (so the certificate check)
        # stay the real name. Then put the real URL back: redirects and response.url
        # are worked out from it.
        request.url = url.copy_with(host=ip)
        request.extensions = {**request.extensions, "sni_hostname": host}
        try:
            return await super().handle_async_request(request)
        finally:
            request.url = url


def client(**kw) -> httpx.AsyncClient:
    """An httpx.AsyncClient that only ever reaches public addresses, redirects included."""
    return httpx.AsyncClient(transport=PublicOnlyTransport(), **kw)


async def is_public_url(url: str) -> bool:
    """For URLs handed to something else to fetch (yt-dlp, the headless browser)."""
    try:
        u = httpx.URL(url)
        if u.scheme not in ("http", "https"):
            return False
        await public_address(u.host, u.port or (443 if u.scheme == "https" else 80))
        return True
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        return False
