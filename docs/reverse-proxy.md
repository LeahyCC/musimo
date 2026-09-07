# Live updates behind a proxy

Keep the UI and API on the same origin. SSE uses one long-lived response at `/api/events`, heartbeat comments every 15 seconds, increasing event IDs and a one-second reconnect hint. The client gets a snapshot before opening the stream, and reloads it if the replay cursor has expired. Up to 5,000 events are retained.

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

Preserve the original Host header and pass `X-Forwarded-Proto` so same-origin writes can be checked. For nginx, add `proxy_set_header X-Forwarded-Proto $scheme;` to both locations. Caddy sends it automatically. Configure uvicorn's `FORWARDED_ALLOW_IPS` environment variable with the exact trusted proxy address as seen inside the container; Docker's host gateway is not necessarily 127.0.0.1. Do not trust arbitrary forwarded headers from the LAN. Terminate HTTPS at the proxy; never place an API cache or response compressor in front of the event route. Configure authentication at the proxy if the application is reachable outside your trusted LAN. Phase 1 has no built-in password session.

These snippets document the intended deployment. Automated tests exercise direct container SSE replay and restart, not a live nginx/Caddy or Tailscale proxy drop.
