# KhmerDub AI — self-contained container (web UI + dubbing API)
#
# One container serves BOTH the Vite frontend and the Express dubbing API.
# Works on any Docker host: Render, Koyeb, a VPS, or Hugging Face Spaces (which
# now requires a PRO subscription for Docker Spaces).
#
# The port defaults to 7860 (Hugging Face's convention); every other platform
# injects its own PORT, which the server honours because it reads $PORT.
FROM node:22-bookworm-slim

WORKDIR /app

# The runtime needs NODE_ENV=production, but the BUILD needs devDependencies
# (vite, esbuild), so NODE_ENV is only set after the build step.
ENV PORT=7860 \
    HOME=/home/user

# Dependencies first, so rebuilds reuse this layer.
# ffmpeg-static and ffprobe-static download their static Linux binaries during
# install, which is why the image needs no apt packages for FFmpeg.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

# Same command the repository uses: Vite client build + esbuild server bundle.
RUN npm run build && npm cache clean --force

ENV NODE_ENV=production

# Spaces run containers as UID 1000 with a writable HOME.
RUN useradd --uid 1000 --create-home --home-dir /home/user user \
    && mkdir -p /app/data /app/dist \
    && chown -R user:user /app /home/user

USER user

EXPOSE 7860

CMD ["node", "dist/server.cjs"]
