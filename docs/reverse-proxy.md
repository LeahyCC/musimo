# Live updates behind a proxy

Keep the UI and API on the same origin. SSE uses one long-lived response at `/api/events`, heartbeat comments every 15 seconds, increasing event IDs and a one-second reconnect hint. The client gets a snapshot before opening the stream, and reloads it if the replay cursor has expired. Up to 5,000 events are retained. `/api/player/stream/{id}` forwards a single byte range request, so the proxy must pass `Range` headers through.

## nginx

```nginx
location /api/events {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 1h;
}
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $http_host;
}
```

## Caddy

```caddyfile
music.example.test {
    reverse_proxy 127.0.0.1:8765 {
        flush_interval -1
    }
}
```

## Tailscale Serve

For private access from devices on your tailnet, keep Musimo bound to loopback and use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve). First inspect `tailscale serve status --json` and choose an unused HTTPS port. Preserve any existing services. For example, when port 8765 is available:

```sh
tailscale serve --bg --https=8765 http://127.0.0.1:8765
```

Open the HTTPS URL printed by the command on a device connected to your tailnet. The background configuration persists. This uses Serve, not public Funnel. Tailnet access rules determine who can reach the app; Musimo has no separate login. To remove only this endpoint, use `tailscale serve --https=8765 off`, rather than resetting all Serve configuration.

HTTPS proxy requests need a trusted forwarded scheme for Settings and download actions. On Docker Desktop, the proxy can arrive from the Docker network gateway instead of loopback. Inspect `docker inspect <musimo-container>` and the actual connection peer. Merge `FORWARDED_ALLOW_IPS: 127.0.0.1,<observed-proxy-IP>` into that service's environment in your local Compose override, then recreate only Musimo with `docker compose up -d --no-deps musimo`. Replace the placeholder with the verified address, never `*`. Recheck it if the Docker network is recreated.

Check `/api/health`, the UI and `/api/events` through the HTTPS address. A same-origin POST to `/api/jobs` with the deliberately invalid body `{"track_id":-1}` should return validation status 422 without creating a job; a foreign Origin must still return 403. A successful health request alone does not prove that proxy writes work.

Preserve the original Host header and pass `X-Forwarded-Proto` so same-origin writes can be checked. For nginx, add `proxy_set_header X-Forwarded-Proto $scheme;` to both locations. Caddy sends it automatically. Configure uvicorn's `FORWARDED_ALLOW_IPS` environment variable with the exact trusted proxy address as seen inside the container; Docker's host gateway is not necessarily 127.0.0.1. Do not trust arbitrary forwarded headers from the LAN. Terminate HTTPS at the proxy; never place an API cache or response compressor in front of the event route. Configure authentication at the proxy if the application is reachable outside your trusted LAN. The service has no built-in password session.

These snippets document the intended deployment. Tailscale Serve was checked on a Windows Docker Desktop installation for HTTPS health, SSE response streaming, accepted same-origin validation and rejected foreign-origin writes. Automated tests exercise direct container SSE replay and restart, not a live proxy connection drop. Remote-device access still depends on that device's tailnet connection and access rules.
