// Надёжное копирование текста в буфер обмена.
//
// Порядок попыток:
//   1. Нативный clipboard Electron (window.electronAPI.writeClipboardText) —
//      основной путь в desktop-приложении: navigator.clipboard там ненадёжен,
//      т.к. требует secure context и фокуса, а окно безрамочное/прозрачное.
//   2. navigator.clipboard.writeText — браузер (обычный web).
//   3. document.execCommand("copy") через скрытый textarea — запасной путь
//      для старых/ограниченных окружений.
export async function copyText(text: string): Promise<boolean> {
  // 1. Electron native
  try {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined
    if (api && typeof api.writeClipboardText === "function") {
      await api.writeClipboardText(text)
      return true
    }
  } catch {
    // продолжаем к web-путям
  }

  // 2. Web Clipboard API
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // продолжаем к execCommand
  }

  // 3. Legacy execCommand
  try {
    const el = document.createElement("textarea")
    el.value = text
    el.setAttribute("readonly", "")
    el.style.position = "fixed"
    el.style.opacity = "0"
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}
