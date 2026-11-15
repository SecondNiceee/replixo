import { ImageResponse } from "next/og"

export const alt = "Replixo"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const BACKGROUND = "#0b0d16"
const FOREGROUND = "#f2f3f7"
const MUTED = "#7d8196"

// Встроенный шрифт ImageResponse не содержит кириллицы, поэтому в карточке
// только латиница: знак, название и домен.
const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop class="tile-top" stop-color="#2b3034"/>
      <stop offset="1" class="tile-bottom" stop-color="#101416"/>
    </linearGradient>
    <linearGradient id="camera" x1="0" y1="0" x2="0" y2="1">
      <stop class="camera-top" stop-color="#14ffe1"/>
      <stop offset="1" class="camera-bottom" stop-color="#00e7b4"/>
    </linearGradient>
  </defs>
  <rect class="tile-border" x="1" y="1" width="78" height="78" rx="18" fill="url(#tile)" stroke="#1c2226" stroke-width="2"/>
  <g fill="url(#camera)">
    <path d="M48 35 59 27a3 3 0 0 1 5 2.4v21.2a3 3 0 0 1-5 2.4l-11-8Z"/>
    <path d="M29 34.5a1.5 1.5 0 0 1 2.2-1.3l10 5.5a1.5 1.5 0 0 1 0 2.6l-10 5.5a1.5 1.5 0 0 1-2.2-1.3Z"/>
  </g>
  <rect x="19" y="24" width="30" height="32" rx="7" fill="none" stroke="url(#camera)" stroke-width="5.5"/>
</svg>`

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: BACKGROUND,
          gap: 36,
        }}
      >
        <img
          src={`data:image/svg+xml;utf8,${encodeURIComponent(mark)}`}
          width={200}
          height={200}
          alt=""
        />
        <div
          style={{
            display: "flex",
            fontSize: 112,
            fontWeight: 600,
            letterSpacing: -4,
            color: FOREGROUND,
          }}
        >
          Replixo
        </div>
        <div style={{ display: "flex", fontSize: 32, color: MUTED, letterSpacing: 2 }}>
          replixo.ru
        </div>
      </div>
    ),
    size,
  )
}
