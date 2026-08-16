// ---------------------------------------------------------------------------
// Геометрия захватываемого источника («capture region»).
//
// ЗАЧЕМ: в overlay-режиме окно приложения растянуто на весь дисплей, а зрители
// видят только захваченный источник. Если демонстрируется ОКНО, занимающее часть
// экрана, нормализованные (0..1) координаты штрихов у демонстрирующего и у
// зрителей означают разные точки — рисование «не совпадает» с контентом.
//
// Поэтому main-процесс отслеживает прямоугольник источника на экране и отдаёт его
// renderer'у, а тот ограничивает канвас именно этой областью.
//
//   screen:<display_id>:0  → границы дисплея из Electron API (уже DIP).
//   window:<HWND>:<n>      → фоновый PowerShell-опрос
//                            DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)
//                            (fallback GetWindowRect), физические px → DIP.
//
// Событий «окно переехало» для чужих окон в Electron нет, поэтому опрашиваем.
// Один долгоживущий PowerShell на всё время демонстрации: запуск процесса на
// каждый тик стоил бы десятки миллисекунд CPU и мигал бы консолью.
// ---------------------------------------------------------------------------
const { screen } = require("electron")
const { spawn } = require("child_process")
const readline = require("readline")
const { log } = require("./diagnostics")

const CAPTURE_REGION_POLL_MS = 350
// Если PowerShell не ответил за это время — считаем геометрию недоступной и
// уходим в fallback «регион = весь дисплей» (прежнее поведение).
const CAPTURE_REGION_TIMEOUT_MS = 2000

// DWMWA_EXTENDED_FRAME_BOUNDS: настоящие границы окна без невидимых полей
// изменения размера, которые возвращает GetWindowRect (на Windows 10/11 это
// расхождение 7-8 px по краям — заметный сдвиг штрихов).
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct WinRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class WinGeom {
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out WinRect rect, int size);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hwnd, out WinRect rect);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hwnd);
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $ok = $false; $minimized = $false; $x = 0; $y = 0; $w = 0; $h = 0
  try {
    $hwnd = [IntPtr][int64]::Parse($line)
    if ([WinGeom]::IsWindow($hwnd)) {
      $minimized = [WinGeom]::IsIconic($hwnd) -or (-not [WinGeom]::IsWindowVisible($hwnd))
      $rect = New-Object WinRect
      if ([WinGeom]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, 16) -ne 0) {
        [void][WinGeom]::GetWindowRect($hwnd, [ref]$rect)
      }
      $x = $rect.Left; $y = $rect.Top
      $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
      $ok = ($w -gt 0 -and $h -gt 0)
    }
  } catch {
    $ok = $false
  }
  [Console]::Out.WriteLine('{"hwnd":' + $line + ',"ok":' + $ok.ToString().ToLower() + ',"minimized":' + $minimized.ToString().ToLower() + ',"x":' + $x + ',"y":' + $y + ',"w":' + $w + ',"h":' + $h + '}')
  [Console]::Out.Flush()
}
`

let tracking = null
let worker = null
let workerRl = null
// Один раз провалившийся запуск PowerShell не пробуем снова за сессию: причина
// (нет powershell.exe, политика запуска) сама не исчезнет, а спам процессами —
// исчезнет только в логе.
let workerUnavailable = false
let workerRestarts = 0
let degradedLogged = false

const MAX_WORKER_RESTARTS = 3

// -------------------------------------------------------------------------
// Разбор sourceId Electron: "screen:<display_id>:0" / "window:<HWND>:<n>".
// -------------------------------------------------------------------------
function parseSourceId(sourceId) {
  if (typeof sourceId !== "string") return null
  const [kind, rawId] = sourceId.split(":")
  if (kind === "screen") return { kind: "screen", displayId: rawId }
  if (kind === "window") {
    const hwnd = Number.parseInt(rawId, 10)
    return Number.isFinite(hwnd) && hwnd > 0 ? { kind: "window", hwnd } : null
  }
  return null
}

function findDisplayById(displayId) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) || null
}

function rectsEqual(a, b) {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Дисплей, на котором реально идёт демонстрация. Нужен ДО старта трекинга, чтобы
 * overlay-окно уехало на нужный монитор (иначе рисование на другом мониторе не
 * совпадёт вообще ни с чем).
 */
function resolveCaptureDisplay(sourceId, win) {
  const fallback = () => screen.getDisplayMatching(win.getBounds())
  const parsed = parseSourceId(sourceId)
  if (!parsed) return fallback()
  if (parsed.kind === "screen") return findDisplayById(parsed.displayId) || fallback()
  // Для окна на этот момент геометрия обычно ещё неизвестна: если предыдущий
  // трекинг уже успел её получить — используем, иначе монитор окна приложения.
  if (tracking?.screenRect && tracking.sourceId === sourceId) {
    return screen.getDisplayNearestPoint({
      x: Math.round(tracking.screenRect.x + tracking.screenRect.width / 2),
      y: Math.round(tracking.screenRect.y + tracking.screenRect.height / 2),
    })
  }
  return fallback()
}

// -------------------------------------------------------------------------
// PowerShell-воркер: пишем HWND в stdin, читаем строку JSON из stdout.
// -------------------------------------------------------------------------
function stopWorker() {
  if (workerRl) {
    workerRl.close()
    workerRl = null
  }
  if (worker) {
    const proc = worker
    worker = null
    try {
      proc.stdin.end()
      proc.kill()
    } catch {
      // процесс мог уже умереть
    }
  }
}

function handleWorkerLine(line) {
  const state = tracking
  if (!state || state.kind !== "window") return

  let data = null
  try {
    data = JSON.parse(line)
  } catch {
    return
  }
  // Ответ на устаревший запрос (источник успели переключить) — игнорируем.
  if (!data || Number(data.hwnd) !== state.hwnd) return

  state.pendingSince = 0
  state.degraded = false

  if (!data.ok) {
    // Окно закрылось или свернулось: регион о��таётся прежним, но канвас скрыт.
    setRegion(state, state.screenRect, false, false)
    return
  }

  // DWM отдаёт физические пиксели; DOM и Electron screen API живут в DIP.
  const dip = screen.screenToDipRect(state.win, {
    x: data.x,
    y: data.y,
    width: data.w,
    height: data.h,
  })
  setRegion(state, dip, !data.minimized, false)
}

function ensureWorker() {
  if (worker || workerUnavailable) return worker
  try {
    const encoded = Buffer.from(PS_SCRIPT, "utf16le").toString("base64")
    worker = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    workerRl = readline.createInterface({ input: worker.stdout })
    workerRl.on("line", handleWorkerLine)
    worker.stderr.on("data", (buf) => {
      const text = String(buf).trim()
      if (text) log.warn("capture-region", text)
    })
    worker.stdin.on("error", () => {
      // Закрытый stdin ловим здесь, иначе unhandled error уронит main.
    })
    const proc = worker
    proc.on("error", (error) => {
      log.error("capture-region", "powershell failed to start", error)
      workerUnavailable = true
      if (worker === proc) stopWorker()
      markDegraded()
    })
    proc.on("exit", (code, signal) => {
      // Устаревший exit уже заменённого воркера нас не касается.
      if (worker !== proc) return
      stopWorker()
      workerRestarts += 1
      // Воркер, который падает раз за разом, чинить перезапуском бессмысленно.
      if (workerRestarts >= MAX_WORKER_RESTARTS) workerUnavailable = true
      if (!tracking) return
      log.warn("capture-region", "powershell exited", { code, signal, restarts: workerRestarts })
      markDegraded()
    })
  } catch (error) {
    log.error("capture-region", "powershell spawn threw", error)
    workerUnavailable = true
    worker = null
    markDegraded()
  }
  return worker
}

/** Геометрию получить не удалось: регион = весь дисплей (прежнее поведение). */
function markDegraded() {
  const state = tracking
  if (!state) return
  if (!degradedLogged) {
    degradedLogged = true
    log.warn("capture-region", "window geometry unavailable; falling back to full display")
  }
  const display = screen.getDisplayMatching(state.win.getBounds())
  state.degraded = true
  setRegion(state, display.bounds, true, true)
}

function pollWindowRegion() {
  const state = tracking
  if (!state || state.kind !== "window") return
  if (state.win.isDestroyed()) {
    stopCaptureRegionTracking()
    return
  }

  const proc = ensureWorker()
  if (!proc) return

  if (state.pendingSince && Date.now() - state.pendingSince > CAPTURE_REGION_TIMEOUT_MS) {
    state.pendingSince = 0
    markDegraded()
    return
  }
  if (state.pendingSince) return

  state.pendingSince = Date.now()
  try {
    proc.stdin.write(`${state.hwnd}\n`)
  } catch {
    state.pendingSince = 0
    stopWorker()
    markDegraded()
  }
}

// -------------------------------------------------------------------------
// Публикация региона в renderer.
// -------------------------------------------------------------------------
/**
 * Пересечение региона с content-областью overlay-окна. Окно демонстрации может
 * частично выходить за край монитора (или на соседний) — рисовать вне overlay
 * физически нельзя, поэтому обрезаем, иначе часть канваса ушла бы за пределы
 * окна и штрихи в этой зоне не рисовались бы вообще.
 */
function clipToWindow(rect, bounds) {
  const left = Math.max(rect.x, bounds.x)
  const top = Math.max(rect.y, bounds.y)
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width)
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function toRendererPayload(state) {
  const bounds = state.win.getContentBounds()
  const rawRect = state.screenRect || bounds
  // Для окна регион может частично лежать за пределами overlay — обрезаем.
  // Полностью ушедшее за край окно = рисовать негде (visible: false ниже).
  const clipped = state.kind === "window" ? clipToWindow(rawRect, bounds) : rawRect
  const screenRect = clipped || rawRect
  const offscreen = state.kind === "window" && !clipped
  return {
    sourceId: state.sourceId,
    kind: state.kind,
    screenRect,
    // Координаты относительно content-области overlay-окна = CSS-пиксели renderer.
    rect: {
      left: screenRect.x - bounds.x,
      top: screenRect.y - bounds.y,
      width: screenRect.width,
      height: screenRect.height,
    },
    visible: state.visible && !offscreen,
    degraded: state.degraded,
  }
}

function emitRegion(state) {
  const payload = toRendererPayload(state)
  const serialized = JSON.stringify(payload)
  if (serialized === state.lastSent) return
  state.lastSent = serialized
  state.send("capture-region-changed", payload)
}

function setRegion(state, screenRect, visible, degraded) {
  const changedRect = !rectsEqual(state.screenRect, screenRect)
  state.screenRect = screenRect || state.screenRect
  state.visible = visible
  state.degraded = degraded

  // Окно уехало на другой монитор — overlay должен переехать за ним, иначе
  // рисовать по нему невозможно физически.
  if (changedRect && state.screenRect && state.onDisplayChange) {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(state.screenRect.x + state.screenRect.width / 2),
      y: Math.round(state.screenRect.y + state.screenRect.height / 2),
    })
    if (display.id !== state.displayId) {
      state.displayId = display.id
      state.onDisplayChange(display)
    }
  }

  emitRegion(state)
}

/** Пересчёт rect после перемещения/ресайза самого overlay-окна. */
function refreshScreenRegion() {
  const state = tracking
  if (!state || state.win.isDestroyed()) return
  if (state.kind === "screen") {
    const display = findDisplayById(state.displayId) || screen.getDisplayMatching(state.win.getBounds())
    setRegion(state, display.bounds, true, false)
    return
  }
  emitRegion(state)
}

function startCaptureRegionTracking({ sourceId, win, send, onDisplayChange }) {
  stopCaptureRegionTracking()
  if (!win || win.isDestroyed()) return false

  const parsed = parseSourceId(sourceId)
  const state = {
    sourceId: typeof sourceId === "string" ? sourceId : null,
    kind: parsed?.kind === "window" ? "window" : "screen",
    hwnd: parsed?.kind === "window" ? parsed.hwnd : null,
    win,
    send,
    onDisplayChange,
    screenRect: null,
    displayId: null,
    visible: true,
    degraded: false,
    pendingSince: 0,
    lastSent: null,
    timer: null,
    listeners: [],
  }
  tracking = state

  const onWindowGeometryChange = () => refreshScreenRegion()
  win.on("move", onWindowGeometryChange)
  win.on("resize", onWindowGeometryChange)
  state.listeners.push(() => {
    win.removeListener("move", onWindowGeometryChange)
    win.removeListener("resize", onWindowGeometryChange)
  })

  if (state.kind === "screen") {
    const display = (parsed && findDisplayById(parsed.displayId)) || screen.getDisplayMatching(win.getBounds())
    state.displayId = display.id
    setRegion(state, display.bounds, true, false)

    const onDisplaysChanged = () => refreshScreenRegion()
    screen.on("display-metrics-changed", onDisplaysChanged)
    screen.on("display-added", onDisplaysChanged)
    screen.on("display-removed", onDisplaysChanged)
    state.listeners.push(() => {
      screen.removeListener("display-metrics-changed", onDisplaysChanged)
      screen.removeListener("display-added", onDisplaysChanged)
      screen.removeListener("display-removed", onDisplaysChanged)
    })
    return true
  }

  if (process.platform !== "win32") {
    // Геометрия чужого окна доступна только через WinAPI; на остальных платформах
    // остаёмся на прежнем поведении (весь дисплей).
    markDegraded()
    return true
  }

  const display = screen.getDisplayMatching(win.getBounds())
  state.displayId = display.id
  // Стартовое значение, пока не пришёл первый ответ: весь дисплей, как раньше.
  setRegion(state, display.bounds, true, false)
  state.timer = setInterval(pollWindowRegion, CAPTURE_REGION_POLL_MS)
  pollWindowRegion()
  return true
}

function stopCaptureRegionTracking() {
  const state = tracking
  tracking = null
  degradedLogged = false
  if (!state) {
    stopWorker()
    return false
  }
  if (state.timer) clearInterval(state.timer)
  for (const off of state.listeners) {
    try {
      off()
    } catch {
      // окно могло быть уничтожено
    }
  }
  stopWorker()
  return true
}

function getCaptureRegion() {
  if (!tracking || tracking.win.isDestroyed()) return null
  return toRendererPayload(tracking)
}

module.exports = {
  startCaptureRegionTracking,
  stopCaptureRegionTracking,
  getCaptureRegion,
  resolveCaptureDisplay,
}
