import { ImageResponse } from "next/og"

export const alt = "Replixo"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const BACKGROUND = "#0b0d16"
const FOREGROUND = "#f2f3f7"
const MUTED = "#7d8196"

// Встроенный шрифт ImageResponse не содержит кириллицы, поэтому в карточке
// только латиница: знак, название и домен.
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <circle cx="24" cy="24" r="17" stroke="${FOREGROUND}" stroke-width="3.5"/>
  <g stroke="${FOREGROUND}" stroke-width="3.5" stroke-linecap="round" opacity="0.85">
    <path d="M31.79 28.5 20.74 9.36"/>
    <path d="M31.79 28.5 20.74 9.36" transform="rotate(120 24 24)"/>
    <path d="M31.79 28.5 20.74 9.36" transform="rotate(240 24 24)"/>
  </g>
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
