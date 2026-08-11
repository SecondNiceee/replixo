"use client"

import { useEffect } from "react"
import { startNativeScreenAudio } from "@/lib/native-screen-audio"

// Глобальные типы Electron-моста объявлены в electron/electron.d.ts
// (interface ElectronAPI / DesktopSource / MediaDevices.__electronPatched).

let displayMediaRequestInFlight = false
let cancelActiveScreenPicker: (() => void) | null = null

function showScreenPicker(sources: DesktopSource[]): Promise<string | null> {
  // Defensive cleanup in case an older picker survived a renderer/UI race.
  cancelActiveScreenPicker?.()

  return new Promise((resolve) => {
    let settled = false
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

    const finish = (sourceId: string | null) => {
      if (settled) return
      settled = true
      document.removeEventListener("keydown", onKeyDown)
      overlay.remove()
      if (cancelActiveScreenPicker === cancel) cancelActiveScreenPicker = null
      resolve(sourceId)
    }
    const cancel = () => finish(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel()
    }
    cancelActiveScreenPicker = cancel
    document.addEventListener("keydown", onKeyDown)

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

      card.onclick = () => finish(source.id)
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
    cancelBtn.onclick = cancel
    modal.appendChild(cancelBtn)

    overlay.appendChild(modal)
    // Клик на оверлей (вне модалки) — отмена
    overlay.onclick = (event) => {
      if (event.target === overlay) cancel()
    }
    document.body.appendChild(overlay)
  })
}

function patchElectronDisplayMedia() {
  if (typeof window === "undefined") return
  if (!window.electronAPI?.isElectron) return
  if (navigator.mediaDevices.__electronPatched) return

  const _original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)

  // В Electron мы НЕ подменяем захват на legacy-getUserMedia(chromeMediaSource):
  // тот путь игнорирует constraints (включая restrictOwnAudio), из-за чего в
  // аудиодорожку экрана попадал звук самого звонка и зритель слышал себя (эхо).
  //
  // Приоритетный путь (Variant A, about/echo-fix/plan.md): нативный WASAPI
  // process-loopback с исключением дерева процессов Electron. Он физически
  // вырезает голоса участников (их проигрывает наш renderer) из системного
  // микса ещё ДО захвата — это детерминированный ОС-уровневый аналог
  // restrictOwnAudio. Видео берём штатным getDisplayMedia (video-only), а
  // аудиодорожку подменяем нативной.
  //
  // Fallback (старый Windows / нет helper'а / любая ошибка): показываем пикер и
  // вызываем НАСТОЯЩИЙ getDisplayMedia(constraints) c restrictOwnAudio, как
  // раньше — без регрессии.
  navigator.mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
    if (displayMediaRequestInFlight) {
      throw new DOMException("A screen share request is already in progress", "InvalidStateError")
    }

    displayMediaRequestInFlight = true
    try {
      const audioRequested = !!constraints?.audio
      const videoRequested = constraints?.video !== false

    // Нативный захват поддержан? (Windows >= 19041 и есть бинарь helper'а.)
    let nativeSupported = false
    if (audioRequested) {
      try {
        const support = await window.electronAPI!.getAudioCaptureSupport()
        nativeSupported = !!support?.supported
      } catch {
        nativeSupported = false
      }
    }

    // Выбор источника нужен только когда запрашивается видео. При video:false
    // (обновление аудиодорожки) пикер не показываем.
    let sourceId: string | null = null
    if (videoRequested) {
      const sources = await window.electronAPI!.getDesktopSources()
      if (!sources || sources.length === 0) {
        throw new DOMException("No screen sources available", "NotFoundError")
      }
      sourceId = await showScreenPicker(sources)
      if (!sourceId) {
        throw new DOMException("Screen share cancelled", "AbortError")
      }
    }

    // Каждый вызов настоящего getDisplayMedia потребляет pendingDisplaySourceId
    // в main, поэтому переустанавливаем источник перед каждым вызовом.
    const callOriginal = async (c?: DisplayMediaStreamOptions) => {
      if (sourceId) await window.electronAPI!.setDisplaySource(sourceId)
      return _original(c)
    }

    // --- Variant A: видео штатно (без loopback-аудио) + нативная аудиодорожка.
    if (audioRequested && nativeSupported) {
      let stream: MediaStream
      if (videoRequested) {
        stream = await callOriginal({ ...constraints, audio: false })
      } else {
        stream = new MediaStream()
      }

      const native = await startNativeScreenAudio()
      if (native) {
        stream.addTrack(native.track)
        // Останавливаем нативный захват, когда останавливают видеодорожку.
        const videoTrack = stream.getVideoTracks()[0]
        if (videoTrack) {
          videoTrack.addEventListener("ended", () => native.stop())
          // Событие "ended" приходит только когда захват прекращает сама ОС
          // (кнопка "Stop sharing" в Chromium). Когда демонстрацию останавливает
          // наш UI через videoTrack.stop(), события нет — поэтому оборачиваем stop()
          // вручную, иначе хелпер и IPC-слушатель переживают сессию и утекают.
          const videoStop = videoTrack.stop.bind(videoTrack)
          videoTrack.stop = () => {
            videoStop()
            native.stop()
          }
        }
        return stream
      }

      // Нативный путь не поднялся — освобождаем уже открытое видео и уходим в
      // штатный loopback-путь (с restrictOwnAudio + downstream AEC).
      stream.getTracks().forEach((t) => t.stop())
    }

      // --- Fallback: штатный путь, constraints (restrictOwnAudio) доходят до захвата.
      return await callOriginal(constraints)
    } finally {
      // Picker must never survive a completed, cancelled, or failed capture request.
      cancelActiveScreenPicker?.()
      displayMediaRequestInFlight = false
    }
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
