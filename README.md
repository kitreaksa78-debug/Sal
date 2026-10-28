---
title: KhmerDub AI
emoji: 🎙️
colorFrom: green
colorTo: teal
sdk: docker
app_port: 7860
pinned: false
short_description: Separate the voice (speech and singing) from the music
---

# AI separate voice · ញែកសំឡេងចេញពីភ្លេង

Upload a video or a song, get **two files back**: the human voice — the spoken
dialogue *and* the singing — and the music it was mixed with. The separation
runs on **Demucs**, the model that actually lifts a voice out of a mix; nothing
in this repository substitutes a lesser trick for it.

There is no account to create and no history to keep: every visit opens the
studio, uploads straight away, and hands back the finished tracks. This Space
runs the **whole app** (frontend + API) from one container.

## Pipeline

Four steps, in the order they run:

| Step | Engine |
| --- | --- |
| 1. Upload File | multer + FFmpeg — a video or an audio file (MP4, MOV, WEBM, MP3, WAV, M4A) |
| 2. Extract Audio | FFmpeg `-vn` → 44.1 kHz stereo WAV, whatever was uploaded |
| 3. Separate voice / music | **Demucs** over HTTP — ញែកសំឡេងនិយាយ និងសំឡេងច្រៀងចេញពីភ្លេង |
| 4. Package | FFmpeg encodes both stems as VBR MP3, plus an MP4 twin for a video upload |

The studio's checklist shows those four rows, so each stage is on screen while it
runs. `queued → extracting_audio → separating_audio → mixing → completed`.

### What comes back

| Deliverable | File |
| --- | --- |
| សំឡេង (voice: speech + singing, no music) | `vocals-<id>.mp3` |
| ភ្លេង (music: everything that is not a human voice) | `music-<id>.mp3` |
| The voice over the original picture | `vocals-<id>.mp4` (video uploads only) |
| The music over the original picture | `music-<id>.mp4` (video uploads only) |

All four come from one route, `GET /api/jobs/:id/download?stem=vocals|music&format=mp3|mp4`,
which honours byte ranges so the previews seek instead of downloading first.

The MP4 twins mux each stem over the original picture with a stream copy, so the
video is never re-encoded — a container FFmpeg cannot write simply yields no
twin while the MP3 downloads keep working.

## Stem separation (Demucs required)

Splitting the voices out of the mix runs on Demucs, reached over HTTP. Model
separation is never faked: a job that reaches Demucs gets real stems.

Demucs is a **requirement**, not an upgrade — it *is* the product. With no
service connected the upload endpoint refuses the file (HTTP 400,
`DEMUCS_REQUIRED_MESSAGE`), and a job whose service breaks mid-run fails with
the service's own reason instead of publishing something that was never
separated. `getAudioSeparationProvider()` has no fallback provider for exactly
this reason.

Set `AUDIO_SEPARATOR_URL` to wherever Demucs runs:

| Host | How |
| --- | --- |
| Phone (Termux) | `tools/demucs-termux/` starts the API and a tunnel |
| **Google Colab (GPU)** | `tools/demucs-colab/` — one cell installs, serves and tunnels the API |
| Home server / VPS | `tools/demucs-termux/run-local.sh` |
| Bundled sidecar | `tools/audio-separator-server/` |

The URL can also be pasted into the `ញែកភ្លេង · Demucs API` panel in the studio,
and that value wins over the environment variable — a phone tunnel gets a new
URL every time it is reopened, so re-pointing it must not need a redeploy.

### Long files

A quick Cloudflare tunnel cuts a request at roughly 100 seconds (HTTP 524), and a
phone separating on CPU runs several times slower than realtime. So the audio is
cut into pieces, each separated by its own request, and the stems are joined
back in order — the timeline is unchanged, because the pieces are cut at exact
offsets and both of a piece's stems come from the same separation:

- the default piece is 15s on a phone; a service that reports `cuda`/`mps` in
  `/health` is sent **90s** pieces (`AUDIO_SEPARATOR_GPU_CHUNK_SECONDS`),
  because on a GPU the round trip dominates;
- a piece that times out is halved (first to one 7.5s Demucs window) and the
  smaller size is remembered for the rest of the run; pieces that finish with
  the budget to spare grow it back;
- a dropped tunnel request is retried with the same audio before it is believed.

`AUDIO_SEPARATOR_CHUNK_SECONDS`, `AUDIO_SEPARATOR_MIN_CHUNK_SECONDS`,
`AUDIO_SEPARATOR_MAX_ATTEMPTS`, `AUDIO_SEPARATOR_RETRY_DELAY_MS` and
`AUDIO_SEPARATOR_TIMEOUT_MS` override those numbers.

## Required secrets

Add these in **Settings → Variables and secrets** as **Secrets** (not variables):

| Name | Required | Notes |
| --- | --- | --- |
| `AUDIO_SEPARATOR_URL` | yes | Base URL of the Demucs stem service (or paste it in the studio panel) |
| `AUDIO_SEPARATOR_API_KEY` | optional | Bearer token, when the service has one |

Translation, speech-to-text and text-to-speech were removed with the dubbing
flow: the site no longer transcribes, translates or re-voices anything, so no
`GROQ_*`, `STT_*`, `TTS_*` or Google key is read anywhere.

Optional — keep results after a restart. A free host's disk is **ephemeral**, so
uploads and outputs are lost whenever the container restarts. Point the app at a
Cloudflare R2 / S3 bucket to persist them:

| Name | Notes |
| --- | --- |
| `S3_ENDPOINT` | e.g. `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | bucket name |
| `S3_ACCESS_KEY_ID` | R2 access key id |
| `S3_SECRET_ACCESS_KEY` | R2 secret access key |

`MAX_VIDEO_SIZE_MB` (default 500) is the upload ceiling for both video and audio.

## Hosting notes

- Hugging Face only allows **Static** Spaces on the free plan; Gradio and Docker
  Spaces need a PRO subscription. Deploy this folder elsewhere for free — see
  `render.yaml` for a Render free web service — or self-host it.
- Free instances sleep after a period of inactivity and wake on the next visit.
- Demucs is the one service you must run somewhere (see above). Everything else
  — reading the audio, encoding the stems, muxing the video twins — runs on this
  host with the bundled FFmpeg.
- Separation is CPU/GPU-bound on the *service* side; a minute of audio on a
  phone takes a minute or two, and seconds on a Colab GPU.

## Local / self-hosted run

```sh
bun install
bun run dev      # http://localhost:3000
# or, production mode:
bun run build && npm start
```

Set `AUDIO_SEPARATOR_URL` (or paste it into the stem panel) before uploading,
or the studio will refuse the file and say why.

Deploy this folder to a Space with `HF_TOKEN=... sh scripts/deploy-hf.sh`.
