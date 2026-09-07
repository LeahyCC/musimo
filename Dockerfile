FROM node:24-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM denoland/deno:bin-2.9.6 AS deno
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 MUSIMO_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools gosu ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY backend/ ./backend/
COPY --from=frontend /build/dist ./frontend/dist/
COPY docker-entrypoint.sh /usr/local/bin/musimo-entrypoint
RUN chmod +x /usr/local/bin/musimo-entrypoint && mkdir -p /data /music
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import socket; s=socket.create_connection(('127.0.0.1',8765),2); s.sendall(b'GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n'); assert b' 200 ' in s.makefile('rb').readline()"
ENTRYPOINT ["musimo-entrypoint"]
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1", "--no-access-log", "--timeout-graceful-shutdown", "2"]
