# The tempo-beat-v1 worker: Beat This! and FFmpeg. See docs/audio-profile-spec.md.
# Built twice from the same code: VARIANT=cpu (default, about 2 GB) and VARIANT=gpu (CUDA 12.8,
# about 11.6 GB, the first CUDA build with RTX 50-series support). The checkpoint is fetched
# here and checked against the bake-off's SHA-256, so the container never needs the internet.
FROM python:3.12-slim-bookworm
ARG VARIANT=cpu
# One native thread each for numpy and friends. torch's own thread count is set by the worker
# from MUSIMO_WORKER_THREADS or the container's CPU quota.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp TORCH_HOME=/tmp/torch \
    OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
    MUSIMO_AUDIO_RECIPE=tempo-beat-v1 MUSIMO_BEAT_CHECKPOINT=/opt/beat-this/final0.ckpt
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY beat/requirements-${VARIANT}.lock ./requirements.lock
RUN case "$VARIANT" in cpu) index=cpu ;; gpu) index=cu128 ;; *) exit 1 ;; esac \
    && pip install --no-cache-dir --require-hashes \
        --extra-index-url "https://download.pytorch.org/whl/$index" -r requirements.lock
ADD --checksum=sha256:8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331 \
    https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt \
    /opt/beat-this/final0.ckpt
COPY audio_worker/ ./audio_worker/
RUN chmod 0644 /opt/beat-this/final0.ckpt && mkdir -p /music
USER 1000:1000
CMD ["python", "-m", "audio_worker"]
