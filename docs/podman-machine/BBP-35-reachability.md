# BBP-35 — bb server reachability from a Podman container

Host: macOS (Darwin 25.3.0), Podman 6.1.0, `podman-machine-default` (applehv, rootful, already running).

## Finding the local bb server port

```
$ lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep bb
bb  49373  sjovanoski  31u  IPv4 ...  TCP *:38886 (LISTEN)
bb  49374  sjovanoski  21u  IPv4 ...  TCP 127.0.0.1:58121 (LISTEN)
bb  49374  sjovanoski  24u  IPv4 ...  TCP 127.0.0.1:38887 (LISTEN)
```

`*:38886` is the bb server's main HTTP port — bound to all interfaces, not just
loopback, on this install. `/health` on it returns `{"ok":true,"launchId":"..."}`.

## 1. host.containers.internal — WORKS

Throwaway container, no mounts of the laptop home, `~/.ssh`, or `~/.bb`:

```
$ podman run --rm docker.io/library/nginx:1.28.0-alpine-slim \
    wget -qO- --timeout=3 http://host.containers.internal:38886/health
{"ok":true,"launchId":"9402cf07-a466-4cac-8419-388125b66f95"}
```

```
$ podman run --rm docker.io/library/nginx:1.28.0-alpine-slim \
    wget -S -qO- --timeout=3 http://host.containers.internal:38886/
HTTP/1.1 200 OK
...
<!doctype html> ... <title>bb</title> ...
```

**Works: yes.** `host.containers.internal` resolves to the host from inside the
Podman VM and reaches the bb server directly, because this install's server
happens to bind `*:38886` rather than `127.0.0.1` only. No podman network flags
were needed (default bridge networking). This is the path to use for a
same-host container, with no human step required.

Caveat for the runbook: per `bb guide machines`, the server "listens on
loopback by default" — this host's `*:38886` binding is this machine's current
state, not a guaranteed default. A remote execution machine must not assume
`host.containers.internal` works; it only works for same-host containers, and
only if the server is actually reachable beyond loopback.

## 2. Direct URL — NOT TESTED, needs a human step

`bb guide machines` confirms: "Remote execution machines need a server access
provider: paired bb Connect, or a configured direct URL reachable from the
target, such as a private Tailscale Serve URL. A configured URL alone does not
prove reachability." Configuring a Direct URL is done under **Settings →
Machines** in the bb app — this is a UI action only a human can perform (no CLI
command exists for it per the guide's command table).

**Needs human action:** enable/configure a Direct URL for this server in
Settings → Machines, then hand back the URL (non-secret) so it can be curled
from a container for verification.

## 3. Tailscale — NOT TESTED, needs a human step

```
$ which tailscale
tailscale not found
```

Tailscale is not installed on this host. Testing it requires:
1. Installing the Tailscale client (e.g. `brew install tailscale`),
2. Logging in via `tailscale up` (OAuth/browser flow — human-only step),
3. Enabling Tailscale Serve for the bb server port.

**Needs human action:** install Tailscale and complete the login/enrollment
flow, then report back the Tailscale hostname/URL for verification from a
container.

## Summary for the runbook

| Path | Works on this host | Human step required |
|---|---|---|
| `host.containers.internal:38886` | Yes | No |
| Direct URL | Untested (blocked) | Yes — enable in Settings → Machines |
| Tailscale | Untested (blocked) | Yes — install + `tailscale up` |
