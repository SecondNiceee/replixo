#!/usr/bin/env bash
# Downloads all tldraw static assets (fonts, icons, translations, embed-icons)
# from cdn.tldraw.com and saves them under public/tldraw-assets/ so the app
# can serve them from its own domain without relying on an external CDN.
#
# Run this script after upgrading the `tldraw` package to keep assets in sync.
# Usage: bash scripts/download-tldraw-assets.sh

set -euo pipefail

VERSION=$(node -e "const p=require('./node_modules/tldraw/package.json'); console.log(p.version)")
BASE="https://cdn.tldraw.com/${VERSION}"
OUT="public/tldraw-assets"

echo "Downloading tldraw@${VERSION} assets to ${OUT}/ ..."

# ---------- fonts ----------
mkdir -p "${OUT}/fonts"
for font in Shantell_Sans-Tldrawish.woff2 IBMPlexSerif-Medium.woff2 IBMPlexSans-Medium.woff2 IBMPlexMono-Medium.woff2; do
  echo "  font: $font"
  curl -sL --max-time 15 "${BASE}/fonts/${font}" -o "${OUT}/fonts/${font}"
done

# ---------- icons ----------
ICONS=$(node -e "
const m = require('./node_modules/tldraw/dist-esm/lib/ui/icon-types.mjs');
console.log(Object.values(m).flat().join(' '));
" 2>/dev/null || node -e "
const fs = require('fs');
const src = fs.readFileSync('./node_modules/tldraw/dist-esm/lib/ui/icon-types.mjs','utf8');
const names = [...src.matchAll(/\"([^\"]+)\"/g)].map(m=>m[1]);
console.log(names.join(' '));
")

mkdir -p "${OUT}/icons/icon"
for icon in $ICONS; do
  curl -sL --max-time 10 "${BASE}/icons/icon/${icon}.svg" -o "${OUT}/icons/icon/${icon}.svg"
done
echo "  icons: $(echo $ICONS | wc -w) downloaded"

# ---------- translations ----------
LOCALES="cs da de en es fi fr hu it ja pl pt-br ro ru sv tr uk zh-cn zh-tw"
mkdir -p "${OUT}/translations"
for locale in $LOCALES; do
  STATUS=$(curl -sL --max-time 10 -w "%{http_code}" "${BASE}/translations/${locale}.json" -o "${OUT}/translations/${locale}.json")
  [ "$STATUS" != "200" ] && rm -f "${OUT}/translations/${locale}.json" && echo "  translation not found: $locale"
done
echo "  translations done"

# ---------- embed-icons ----------
EMBEDS="codepen codesandbox excalidraw figma observable replit spotify tldraw vimeo youtube"
mkdir -p "${OUT}/embed-icons"
for type in $EMBEDS; do
  STATUS=$(curl -sL --max-time 10 -w "%{http_code}" "${BASE}/embed-icons/${type}.png" -o "${OUT}/embed-icons/${type}.png")
  [ "$STATUS" != "200" ] && rm -f "${OUT}/embed-icons/${type}.png" && echo "  embed-icon not found: $type"
done
echo "  embed-icons done"

echo ""
echo "Done! All assets saved to ${OUT}/"
