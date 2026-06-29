"use client"

import { useEffect } from "react"

// Глобальные типы Electron-моста объявлены в electron/electron.d.ts
// (interface ElectronAPI / DesktopSource / MediaDevices.__electronPatched).

function showScreenPicker(sources: DesktopSource[]): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 999999;
      background: rgba(0,0,0,0.8);
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
    `

    const modal = document.createElement("div")
    modal.style.cssText = `
      background: #111; border: 1px solid #2a2a2a; border-radius: 14px;
      padding: 28px; max-width: 740px; width: 92%;
      max-height: 82vh; overflow-y: auto; color: #fff;
    `

    const title = document.createElement("h2")
    title.textContent = "Выберите источник для демонстрации"
    title.style.cssText = "margin: 0 0 22px; font-size: 17px; font-weight: 600;"
    modal.appendChild(title)

    const grid = document.createElement("div")
    grid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px; margin-bottom: 20px;
    `

    const close = () => document.body.removeChild(overlay)

    for (const source of sources) {
      const card = document.createElement("button")
      card.style.cssText = `
        background: #1c1c1c; border: 2px solid #2a2a2a; border-radius: 10px;
        padding: 10px; cursor: pointer; text-align: center;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        transition: border-color 0.15s;
      `
      card.onmouseenter = () => { card.style.borderColor = "#4f6ef7" }
      card.onmouseleave = () => { card.style.borderColor = "#2a2a2a" }

      const img = document.createElement("img")
      img.src = source.thumbnail
      img.style.cssText = "width: 100%; border-radius: 5px; aspect-ratio: 16/9; object-fit: cover;"
      card.appendChild(img)

      const label = document.createElement("span")
      label.textContent = source.name
      label.style.cssText = `
        font-size: 11px; color: #aaa;
        white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; max-width: 100%;
      `
      card.appendChild(label)

      card.onclick = () => { close(); resolve(source.id) }
      grid.appendChild(card)
    }
    modal.appendChild(grid)

    const cancelBtn = document.createElement("button")
    cancelBtn.textContent = "Отмена"
    cancelBtn.style.cssText = `
      background: #222; border: 1px solid #333; border-radius: 8px;
      padding: 10px 20px; color: #ccc; cursor: pointer;
      font-size: 14px; width: 100%;
    `
    cancelBtn.onclick = () => { close(); resolve(null) }
    modal.appendChild(cancelBtn)

    overlay.appendChild(modal)
    // Клик на оверлей (вне модалки) — отмена
    overlay.onclick = (e) => { if (e.target === overlay) { close(); resolve(null) } }
    document.body.appendChild(overlay)
  })
}

function patchElectronDisplayMedia() {
  if (typeof window === "undefined") return
  if (!window.electronAPI?.isElectron) return
  if (navigator.mediaDevices.__electronPatched) return

  const _original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)

  navigator.mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
    const sources = await window.electronAPI!.getDesktopSources()

    if (!sources || sources.length === 0) {
      throw new DOMException("No screen sources available", "NotFoundError")
    }

    const sourceId = await showScreenPicker(sources)

    if (!sourceId) {
      throw new DOMException("Screen share cancelled", "AbortError")
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: constraints?.audio
        ? ({ mandatory: { chromeMediaSource: "desktop" } } as MediaTrackConstraints)
        : false,
      video: {
        // @ts-expect-error — chromeMediaSource — нестандартное свойство Electron/Chrome
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: 1920,
          minHeight: 720,
          maxHeight: 1080,
          minFrameRate: 15,
          maxFrameRate: 30,
        },
      },
    })

    return stream
  }

  navigator.mediaDevices.__electronPatched = true
}

/**
 * Активирует патчи специфичные для Electron-окружения.
 * В браузере — ничего не делает (window.electronAPI отсутствует).
 * Монтируется один раз в корневом layout.
 */
export function ElectronPatches() {
  useEffect(() => {
    patchElectronDisplayMedia()
    // Помечаем корень документа, чтобы CSS зарезервировал место под кастомный
    // титлбар и корректно обрабатывал прозрачность в overlay-режиме.
    if (typeof window !== "undefined" && window.electronAPI?.isElectron) {
      document.documentElement.classList.add("is-electron")
    }
  }, [])

  return null
}
