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

Six steps, in the order the studio shows them:

| Step | Engine |
| --- | --- |
| 1. Upload Video | upload + FFmpeg audio extraction |
| 2. Demucs API | Demucs (remote stem API) — ញែកសំឡេងនិយាយ និងតន្ត្រី |
| 3. Demucs Speech-to-Text | Whisper via Groq `whisper-large-v3` |
| 4. Groq API | Groq — the only language model the site runs |
| 5. Subtitle · Piper TTS | subtitles + Khmer TTS (the keyless Edge `km-KH` voices) |
| 6. FFmpeg → Sync Audio + Video | FFmpeg (bundled in the image) — mix on the original timestamps + render MP4 |

### Sync (row 6)

There is no separate timing row: the sync happens inside the last step. The voice
is already in time when that row starts, and it costs nothing extra:

- The assembler places every line at its own timestamp (`adelay`), trims it to the
  window the synthesizer was given, and pads the track to the video's length
  (`apad=whole_dur`).
- The render caps the result at the video's own length (`-t meta.duration`), so the
  file can never end a frame early or leave the last frames in silence.
- The mixer ducks the background inside the same windows, so the music comes back
  exactly where the Khmer line stops.

A measuring pass over the finished track was tried and removed: it needed a second
full-length audio decode per job and only confirmed what the assembler and the
render already guarantee.

## Stem separation (Demucs required)

Splitting the voices out of the mix runs on Demucs, reached over HTTP. Model
separation is never faked: a job that reaches Demucs gets real stems.

Demucs is a **requirement**, not an upgrade. Removing the original voices is what
lets the Khmer dub be the dialogue instead of a voice laid over the source one,
and nothing else in the pipeline does it. So with no service connected the upload
endpoint refuses the video (HTTP 400, `DEMUCS_REQUIRED_MESSAGE`), and a job whose
service breaks mid-run fails with the service's own reason instead of publishing a
dub played under the original voices. `getAudioSeparationProvider()` has no
fallback provider for exactly this reason.

Set `AUDIO_SEPARATOR_URL` to wherever Demucs runs:

| Host | How |
| --- | --- |
| Phone (Termux) | `tools/demucs-termux/` starts the API and a tunnel |
| **Google Colab (GPU)** | `tools/demucs-colab/` — one cell installs, serves and tunnels the API |
| Home server / VPS | `tools/demucs-termux/run-local.sh` |
| Bundled sidecar | `tools/audio-separator-server/` |

Colab is the fast option: the same `demucs_api.py` runs on a free GPU, so the API
answers with `"device":"cuda"` and the pipeline then sends it far bigger pieces
(`AUDIO_SEPARATOR_GPU_CHUNK_SECONDS`, 90s by default) instead of the 15s pieces a
phone needs — a CPU service keeps the phone-sized default.

The app owner can also paste the URL into the `ញែកភ្លេង · Demucs API` panel in the
studio, and that value wins over the environment variable — a phone tunnel gets a
new URL every time it is reopened, so re-pointing it must not need a redeploy.

## Khmer subtitles

The finished MP4 carries the Khmer text as a caption track inside the file
(`mov_text`, language `khm`), never painted onto the picture: the frame stays
clean, and every cue comes from the same timeline as the audio, so the words
always stay in sync with what is being said. The result panel starts with the
text hidden — **បង្ហាញអក្សររត់** shows it, **លាក់អក្សររត់** hides it again, and any
player's own CC button does the same. `subtitles-<id>.srt` and `.vtt` are still
produced next to the file, for editing or for loading as a separate track.

Painting Khmer onto frames — how jobs were made before this change — needs a
Khmer font, which the hosts this runs on do not have, so
`assets/fonts/NotoSansKhmer-*.ttf` travels with the repository, and a missing one
is downloaded into `data/fonts` once (`SUBTITLE_FONTS_DIR` overrides where it
looks). New jobs skip drawing entirely: captions are a track, so no font can
fail a render and no text can cover the picture.

### Turning the subtitles off

Nothing has to be switched off at render time: every job produces a single clean
MP4 with the captions inside it as a hidden track, and the panel's
**បង្ហាញអក្សររត់ / លាក់អក្សររត់** button only shows or hides them while watching.
The one download button hands over that same file — clean picture, Khmer
captions included. Jobs made before this change still have their burned-in text
plus the subtitle-free twin (`khmer-dubbed-clean-<id>.mp4`), and their old links
keep working.

Set `subtitle: false` in a job's settings to leave the caption track out.

## Voice timing

A line may use the silence that follows it, up to the moment the next speaker
starts, so a long Khmer sentence is spoken at close to its natural speed instead
of being sped up and cut off mid-syllable. `SPEECH_WINDOW_STRETCH` (default
`1.4`) sets how much room past its own slot a line may claim, and
`SPEECH_TRIM_FADE_SECONDS` (default `0.12`) fades the end of any line that still
has to be cut, so a hard cut sounds cut short rather than chopped. `MAX_SPEECH_TEMPO`
(default `1.5`) is the fastest a line may be sped up in the first place.

## Required secrets

Add these in **Settings → Variables and secrets** as **Secrets** (not variables):

| Name | Required | Notes |
| --- | --- | --- |
| `GROQ_API_KEY` | yes | [console.groq.com/keys](https://console.groq.com/keys) |
| `GROQ_API_KEY2`, `GROQ_API_KEY3` | optional | Extra keys; the app rotates to them automatically on 401/429 |
| `STT_PROVIDER` | optional | `groq` (default) |
| `AUDIO_SEPARATOR_URL` | yes | Base URL of the Demucs stem service |
| `AUDIO_SEPARATOR_API_KEY` | optional | Bearer token, when the service has one |
| `FFMPEG_RENDER_ARGS` | optional | x264 settings for the release MP4 (default `-preset veryfast -crf 21`) |

The release encode is the slowest step on a free host, which has a fraction of
one CPU, so its settings are chosen for that: the measurements behind
`RENDER_ENCODER_ARGS` in `server/utils/ffmpeg.ts` are written next to the
constant. `-preset ultrafast -crf 24` is roughly 3x faster again but writes a
much larger file, which is the trade `FFMPEG_RENDER_ARGS` exists to make
without a code change.

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
