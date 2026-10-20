# Beat This! on the GPU. CUDA 12.8 torch, the first line with RTX 50-series (sm_120) support.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp TORCH_HOME=/tmp/torch \
    OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu128 \
        torch==2.7.1 torchaudio==2.7.1 \
    && pip install --no-cache-dir beat-this==1.1.0 numpy==2.2.6 soxr==0.5.0.post1 \
        einops==0.8.1 rotary-embedding-torch==0.8.6 \
    && pip freeze > /pip-freeze.txt
USER 1000:1000
