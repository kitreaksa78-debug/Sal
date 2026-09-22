# audio-separator stem service.
#
# Build:  docker build -t audio-separator-service .
# Run:    docker run -p 8920:8920 \
#           -e SEPARATOR_API_KEY=change-me \
#           -v as-models:/models -v as-data:/data \
#           audio-separator-service
#
# For an NVIDIA box add `--gpus all` and switch the requirements to
# `audio-separator[gpu]`.
FROM python:3.11-slim

# Some models (Demucs / VR) shell out to FFmpeg to read and write audio.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

ENV SEPARATOR_DATA_DIR=/data \
    SEPARATOR_MODEL_DIR=/models

# Model weights (~70 MB per MDX model, ~1 GB for Demucs) and the temporary stems
# live here, so both mounts should be persistent volumes.
VOLUME ["/data", "/models"]

EXPOSE 8920

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8920"]
