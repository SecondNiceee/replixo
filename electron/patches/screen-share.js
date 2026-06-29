/**
 * electron/patches/screen-share.js
 *
 * Патч navigator.mediaDevices.getDisplayMedia для Electron.
 *
 * Проблема: в Electron navigator.mediaDevices.getDisplayMedia() не работает —
 * нет нативного OS-пикера выбора экрана, вызов просто режектится.
 *
 * Решение: перехватываем getDisplayMedia и заменяем его на нативный путь:
 *   1. Запрашиваем список экранов/окон через IPC → desktopCapturer.getSources()
 *   2. Показываем свой пикер (ScreenPickerModal)
 *   3. Вызываем getUserMedia с { chromeMediaSource: 'desktop', chromeMediaSourceId }
 *
 * Этот файл подключается ТОЛЬКО в десктоп-сборке через _app или layout.
 * В браузере (window.electronAPI не существует) он ничего не делает.
 */

export function patchElectronDisplayMedia() {
  // Запускаем только внутри Electron
  if (typeof window === "undefined") return
  if (!window.electronAPI?.isElectron) return
  // Не патчить повторно
  if (navigator.mediaDevices.__electronPatched) return

  const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)

  navigator.mediaDevices.getDisplayMedia = async (constraints) => {
    // Запрашиваем источники из главного процесса
    const sources = await window.electronAPI.getDesktopSources()

    if (!sources || sources.length === 0) {
      throw new DOMException("No screen sources available", "NotFoundError")
    }

    // Показываем пикер — возвращает выбранный sourceId
    const sourceId = await showScreenPicker(sources)

    if (!sourceId) {
      throw new DOMException("Screen share cancelled", "AbortError")
    }

    // getUserMedia с chromeMediaSource — единственный рабочий способ в Electron
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: constraints?.audio
        ? {
            mandatory: {
              chromeMediaSource: "desktop",
            },
          }
        : false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          // Разрешение подбираем под качество из constraints (если передано)
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

// ---------------------------------------------------------------------------
// Простой пикер источников — рендерит модалку поверх страницы.
// Возвращает Promise<string | null> (sourceId или null при отмене).
// ---------------------------------------------------------------------------
function showScreenPicker(sources) {
  return new Promise((resolve) => {
    // Overlay
    const overlay = document.createElement("div")
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 999999;
      background: rgba(0,0,0,0.75);
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
    `

    // Modal
    const modal = document.createElement("div")
    modal.style.cssText = `
      background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
      padding: 24px; max-width: 720px; width: 90%;
      max-height: 80vh; overflow-y: auto;
      color: #fff;
    `

    const title = document.createElement("h2")
    title.textContent = "Выберите источник для демонстрации"
    title.style.cssText = "margin: 0 0 20px; font-size: 18px; font-weight: 600;"
    modal.appendChild(title)

    // Grid источников
    const grid = document.createElement("div")
    grid.style.cssText = `
      display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px; margin-bottom: 20px;
    `

    for (const source of sources) {
      const card = document.createElement("button")
      card.style.cssText = `
        background: #252525; border: 2px solid #333; border-radius: 8px;
        padding: 10px; cursor: pointer; text-align: center;
        transition: border-color 0.15s;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
      `
      card.onmouseenter = () => { card.style.borderColor = "#5b6af0" }
      card.onmouseleave = () => { card.style.borderColor = "#333" }

      const img = document.createElement("img")
      img.src = source.thumbnail
      img.style.cssText = "width: 100%; border-radius: 4px; aspect-ratio: 16/9; object-fit: cover;"
      card.appendChild(img)

      const label = document.createElement("span")
      label.textContent = source.name
      label.style.cssText = `
        font-size: 12px; color: #ccc; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; max-width: 100%;
      `
      card.appendChild(label)

      card.onclick = () => {
        document.body.removeChild(overlay)
        resolve(source.id)
      }
      grid.appendChild(card)
    }
    modal.appendChild(grid)

    // Кнопка отмены
    const cancelBtn = document.createElement("button")
    cancelBtn.textContent = "Отмена"
    cancelBtn.style.cssText = `
      background: #333; border: none; border-radius: 8px;
      padding: 10px 20px; color: #fff; cursor: pointer;
      font-size: 14px; width: 100%;
    `
    cancelBtn.onclick = () => {
      document.body.removeChild(overlay)
      resolve(null)
    }
    modal.appendChild(cancelBtn)

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
  })
}
