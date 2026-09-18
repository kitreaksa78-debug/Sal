#!/bin/sh
# Create (or update) the KhmerDub AI Docker Space on Hugging Face and push the
# current working tree to it.
#
# Usage:
#   HF_TOKEN=hf_xxx sh scripts/deploy-hf.sh
#
# HF_TOKEN needs WRITE access (huggingface.co/settings/tokens).
# Set HF_SPACE_NAME to use a different Space name (default: khmerdub-ai).
set -eu

: "${HF_TOKEN:?Set HF_TOKEN first (create a write token at https://huggingface.co/settings/tokens)}"

SPACE_NAME="${HF_SPACE_NAME:-khmerdub-ai}"
SPACE_SDK="${HF_SPACE_SDK:-docker}"
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
API=https://huggingface.co/api

json_field() {
  # json_field <field> — read a top-level string field from stdin without jq.
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.stdout.write(String(JSON.parse(s)[process.argv[1]] ?? "")); }
      catch { process.stdout.write(""); }
    });
  ' "$1"
}

echo "→ Checking HF_TOKEN"
WHOAMI=$(curl -sS -H "Authorization: Bearer $HF_TOKEN" "$API/whoami-v2")
HF_USER=$(printf '%s' "$WHOAMI" | json_field name)
if [ -z "$HF_USER" ]; then
  echo "✗ HF_TOKEN was rejected. Check the token has WRITE access." >&2
  printf '%s\n' "$WHOAMI" >&2
  exit 1
fi
echo "  account: $HF_USER"
echo "  space:   $HF_USER/$SPACE_NAME"

echo "→ Creating Space if it does not exist yet"
CREATE=$(curl -sS -X POST "$API/repos/create" \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"space\",\"name\":\"$SPACE_NAME\",\"sdk\":\"$SPACE_SDK\",\"private\":false}")
case "$CREATE" in
  *'"error"'*|*'"message"'*)
    # "already exists" is expected on redeploys.
    echo "  $CREATE"
    ;;
  *)
    echo "  created"
    ;;
esac

REMOTE="https://$HF_USER:$HF_TOKEN@huggingface.co/spaces/$HF_USER/$SPACE_NAME"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "→ Staging files"
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # Tracked plus new files, honouring .gitignore so node_modules, dist, data and
  # .env files stay out of the Space.
  git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard | while IFS= read -r file; do
    mkdir -p "$STAGE/$(dirname "$file")"
    cp "$REPO_ROOT/$file" "$STAGE/$file"
  done
else
  echo "  (not a git repo — copying the working tree instead)"
  tar -C "$REPO_ROOT" \
    --exclude=node_modules --exclude=dist --exclude=dist-pages \
    --exclude=data --exclude=server/data --exclude=.git \
    --exclude='.env*' --exclude='*.log' \
    -cf - . | tar -C "$STAGE" -xf -
fi

# The Space always needs its SDK metadata and must not ship local secrets.
[ -f "$STAGE/README.md" ] || echo "✗ README.md with the Space config is missing" >&2
for secret in .env .env.local; do
  rm -f "$STAGE/$secret"
done

FILE_COUNT=$(find "$STAGE" -type f | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
  echo "✗ Nothing to upload — staging produced an empty tree." >&2
  exit 1
fi
echo "→ Pushing $FILE_COUNT files"
git -C "$STAGE" init -q
git -C "$STAGE" add -A
git -C "$STAGE" -c user.email="space@local" -c user.name="KhmerDub deploy" \
  commit -q -m "Deploy KhmerDub AI to Hugging Face Spaces" || true

# Push on top of whatever the Space already contains, so history never diverges.
git -C "$STAGE" remote add space "$REMOTE"
git -C "$STAGE" fetch -q space main 2>/dev/null || true
git -C "$STAGE" branch -M main
if git -C "$STAGE" rev-parse --verify -q FETCH_HEAD >/dev/null 2>&1; then
  git -C "$STAGE" -c user.email="space@local" -c user.name="KhmerDub deploy" \
    merge -q --allow-unrelated-histories -X ours FETCH_HEAD -m "Sync with Space" || true
fi
git -C "$STAGE" push -q space main

echo "✓ Pushed. The Space is rebuilding now:"
echo "  https://huggingface.co/spaces/$HF_USER/$SPACE_NAME"
echo "  app URL: https://$HF_USER-$SPACE_NAME.hf.space"
echo
echo "Reminder: add the app secrets in Settings → Variables and secrets"
echo "(GROQ_API_KEY, optionally GROQ_API_KEY2/3 and S3_* for R2 persistence)."
