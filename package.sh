#!/usr/bin/env bash
# Builds dist/recall-<version>.zip for small-group sharing (S2, S8 step 7).
# Files are copied from an explicit allowlist rather than zipping the folder:
# Chrome refuses to load an extension containing any file whose name starts
# with "_", so a stray scratch file would otherwise break every install.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
OUT="dist/recall-${VERSION}.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

FILES=(
  manifest.json
  background.js storage.js embeddings.js
  offscreen.html offscreen.js
  content-script.js content-style.css
  popup.html popup.js popup.css fonts.css
  adapters/base.js adapters/claude.js adapters/chatgpt.js
  fonts/fraunces-var.woff2 fonts/inter-var.woff2
  fonts/ibm-plex-mono-400.woff2 fonts/ibm-plex-mono-500.woff2
  icons/icon16.png icons/icon48.png icons/icon128.png
  lib/transformers.min.js lib/transformers-LICENSE lib/ort/ort-wasm-simd.wasm
)

for f in "${FILES[@]}"; do
  mkdir -p "$STAGE/recall/$(dirname "$f")"
  cp "$f" "$STAGE/recall/$f"
done

# Every file the manifest or pages reference must be in the allowlist.
python3 - "$STAGE/recall" <<'PY'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
m = json.loads((root / "manifest.json").read_text())
refs = {m["background"]["service_worker"], m["action"]["default_popup"], *m["icons"].values()}
for cs in m["content_scripts"]:
    refs.update(cs.get("js", []) + cs.get("css", []))
for page in ("popup.html", "offscreen.html"):
    refs.update(re.findall(r'(?:src|href)="([^"]+)"', (root / page).read_text()))
missing = sorted(r for r in refs if not (root / r).exists())
if missing:
    sys.exit(f"package.sh: allowlist is missing referenced files: {missing}")
bad = [p.name for p in root.rglob("*") if p.name.startswith("_")]
if bad:
    sys.exit(f"package.sh: Chrome will refuse these names: {bad}")
PY

mkdir -p dist
rm -f "$OUT"
(cd "$STAGE" && zip -qr -X - recall) > "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
