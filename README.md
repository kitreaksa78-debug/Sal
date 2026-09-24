---
title: KhmerDub AI
emoji: 🎙️
colorFrom: green
colorTo: teal
sdk: docker
app_port: 7860
pinned: false
short_description: AI video translation with natural Khmer dubbing
---

# KhmerDub AI

AI video translation and natural Khmer dubbing. Upload a video, and the pipeline
transcribes the speech, translates it into Khmer, generates Khmer speech, keeps
the original music/background, and renders a new MP4 with subtitles.

This Space runs the **whole app** (frontend + API) from one container.

## Pipeline

| Step | Engine |
| --- | --- |
| Speech to text | Groq `whisper-large-v3` |
| Translation | Groq `openai/gpt-oss-120b` (automatic model fallback) |
| Khmer voice | Microsoft Edge TTS (free, unlimited) |
| Audio separation | Demucs (remote stem API) |
| Muxing / rendering | FFmpeg (bundled in the image) |

## Stem separation (Demucs only)

Splitting the voices out of the mix runs on Demucs, reached over HTTP. There is
no built-in substitute: if the service is missing or unreachable, the job stops
at the separation step and reports why, instead of quietly continuing with a
lesser separation.

Set `AUDIO_SEPARATOR_URL` to wherever Demucs runs:

| Host | How |
| --- | --- |
| Phone (Termux) | `tools/demucs-termux/` starts the API and a tunnel |
| Home server / VPS | `tools/demucs-termux/run-local.sh` |
| Bundled sidecar | `tools/audio-separator-server/` |

The app owner can also paste the URL into the `ញែកភ្លេង · Demucs API` panel in the
studio, and that value wins over the environment variable — a phone tunnel gets a
new URL every time it is reopened, so re-pointing it must not need a redeploy.

## Required secrets

Add these in **Settings → Variables and secrets** as **Secrets** (not variables):

| Name | Required | Notes |
| --- | --- | --- |
| `GROQ_API_KEY` | yes | [console.groq.com/keys](https://console.groq.com/keys) |
| `GROQ_API_KEY2`, `GROQ_API_KEY3` | optional | Extra keys; the app rotates to them automatically on 401/429 |
| `STT_PROVIDER` | optional | `groq` (default) |
| `TRANSLATION_PROVIDER` | optional | `groq` (default) |
| `AUDIO_SEPARATOR_URL` | yes | Base URL of the Demucs stem service |
| `AUDIO_SEPARATOR_API_KEY` | optional | Bearer token, when the service has one |

Optional — keep results after a restart. A Space's disk is **ephemeral**, so
uploads and outputs are lost whenever the container restarts. Point the app at a
Cloudflare R2 / S3 bucket to persist them:

| Name | Notes |
| --- | --- |
| `S3_ENDPOINT` | e.g. `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | bucket name |
| `S3_ACCESS_KEY_ID` | R2 access key id |
| `S3_SECRET_ACCESS_KEY` | R2 secret access key |

## Hosting notes

- Hugging Face only allows **Static** Spaces on the free plan; Gradio and Docker
  Spaces need a PRO subscription. Deploy this folder elsewhere for free — see
  `render.yaml` for a Render free web service — or self-host it.
- Free instances sleep after a period of inactivity and wake on the next visit.
- The translate step is limited by the Groq free tier (tokens per minute / per
  day), not by the Space. Long videos are sent in blocks to stay under it.
- Video processing is CPU-bound: a ~1 minute video takes roughly 1–3 minutes.

## Local / self-hosted run

```sh
bun install
bun run dev      # http://localhost:3000
# or, production mode:
bun run build && npm start
```

Deploy this folder to a Space with `HF_TOKEN=... sh scripts/deploy-hf.sh`.
