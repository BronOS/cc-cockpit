---
worth: later
where: src/main/remote/remote-windows.ts:132
added: 2026-11-12
---
# remote windows: the loopback block matches host names, not resolved addresses

`isLoopbackHost` / `allowRemoteRequest` refuse a remote server page's requests to loopback by the URL's
host name (`localhost`, `*.localhost`, 127.0.0.0/8, 0.0.0.0/8, `::1`, `::`, mapped IPv4). A DNS name that
resolves to 127.0.0.1 (public wildcard services such as `*.localtest.me`, or a rebinding domain), or to this
machine's own LAN address, passes the check and reaches a local listener. Cookies ignore ports, so for a
tunnel origin on `127.0.0.1:<L>` the device cookie is still only sent to that exact host name, which limits
the damage to what an unauthenticated request to a local service can do. Found in the security review of
the remote desktop windows.

Suggested fix: resolve the host in main before allowing (`dns.lookup` all addresses, refuse when any is
loopback, unspecified or one of this machine's interface addresses), or block through the session's
`setResolveHostOverride`-style hook / a proxy rule if Electron offers one; mind the lookup's cost on every
request (cache per host for a short time). Unknown that settles the value: whether Chromium's Private
Network Access already blocks these from a page served over the tunnel origin in Electron 45.
