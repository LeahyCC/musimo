# The audio worker: librosa and FFmpeg, nothing of the web image. See docs/audio-profile-spec.md.
FROM python:3.12-slim-bookworm
# One native thread each. The container has one core and the decoder is pinned to one too.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMBA_NUM_THREADS=1 \
    NUMBA_CACHE_DIR=/tmp/numba-cache
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY audio_worker/ ./audio_worker/
RUN mkdir -p /music
USER 1000:1000
CMD ["python", "-m", "audio_worker"]
