"use client"

/**
 * Общая логика Electron-захвата экрана для renderer'а.
 *
 * Здесь живёт то, что нужно сразу двум местам:
 *  - components/electron-patches.tsx — патч navigator.mediaDevices.getDisplayMedia;
 *  - hooks/mediasoup/use-media-controls.ts — переключение захвата на окно
 *    показа слайдов PowerPoint без перезапуска демонстрации.
 *
 * Модуль вынесен отдельно, чтобы хук не импортировал React-компонент патча.
 */

/** Нестандартное поле: просим патч взять готовый источник и не показывать пикер. */
export interface ElectronDisplayMediaOptions extends DisplayMediaStreamOptions {
  __electronSourceId?: string
}

export interface NativeScreenAudioHandle {
  track: MediaStreamTrack
  stop: () => void
}

interface ScreenVideoTrack extends MediaStreamTrack {
  /** Нативный WASAPI-захват системного звука, привязанный к этой видеодорожке. */
  __electronNativeAudio?: NativeScreenAudioHandle
  /** Дорожку останавливают при смене окна — нативный звук останавливать нельзя. */
  __electronKeepNativeAudio?: boolean
}

export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI?.isElectron
}

// ---------------------------------------------------------------------------
// Последний источник, выбранный пользователем в нашем пикере.
//
// Хук демонстрации не знает про пикер (он вызывает штатный getDisplayMedia), но
// чтобы следить за окном показа слайдов, нужно знать заголовок захваченного
// окна. Патч запоминает выбор здесь, хук его читает.
// ---------------------------------------------------------------------------
let lastDisplaySource: { id: string; name: string } | null = null

export function rememberDisplaySource(source: { id: string; name: string } | null): void {
  lastDisplaySource = source
}

export function getLastDisplaySource(): { id: string; name: string } | null {
  return lastDisplaySource
}

// ---------------------------------------------------------------------------
// Владение нативной аудиодорожкой экрана.
//
// Нативный helper останавливается вместе с видеодорожкой захвата. При смене
// окна (редактор → показ слайдов) старая видеодорожка останавливается, поэтому
// владение надо передать новой, иначе звук демонстрации оборвётся посреди
// показа.
// ---------------------------------------------------------------------------
export function attachNativeScreenAudioLifecycle(
  videoTrack: MediaStreamTrack,
  native: NativeScreenAudioHandle,
): void {
  const track = videoTrack as ScreenVideoTrack
  track.__electronNativeAudio = native

  const stopNativeUnlessHandedOver = () => {
    if (track.__electronKeepNativeAudio) return
    native.stop()
  }

  // "ended" приходит только когда захват прекращает сама ОС (кнопка
  // "Stop sharing" в Chromium). Когда демонстрацию останавливает наш UI через
  // videoTrack.stop(), события нет — поэтому оборачиваем stop() вручную, иначе
  // хелпер и IPC-слушатель переживут сессию и утекут.
  track.addEventListener("ended", stopNativeUnlessHandedOver)
  const nativeStop = track.stop.bind(track)
  track.stop = () => {
    nativeStop()
    stopNativeUnlessHandedOver()
  }
}

/** Передаёт нативный звук экрана с прежней видеодорожки на новую. */
export function adoptNativeScreenAudio(
  from: MediaStreamTrack,
  to: MediaStreamTrack,
): void {
  const previous = from as ScreenVideoTrack
  const native = previous.__electronNativeAudio
  if (!native) return

  previous.__electronKeepNativeAudio = true
  previous.__electronNativeAudio = undefined
  attachNativeScreenAudioLifecycle(to, native)
}

// ---------------------------------------------------------------------------
// Захват конкретного источника без пикера (переключение окна на ходу).
// ---------------------------------------------------------------------------
export async function captureElectronSource(
  sourceId: string,
  video: MediaTrackConstraints | boolean,
): Promise<MediaStream> {
  const options: ElectronDisplayMediaOptions = {
    video: video as MediaTrackConstraints,
    audio: false,
    __electronSourceId: sourceId,
  }
  return navigator.mediaDevices.getDisplayMedia(options)
}

// ---------------------------------------------------------------------------
// Слежение за окном показа слайдов.
// ---------------------------------------------------------------------------
export function followPresentationWindow(
  source: { id: string; name: string },
  onChange: (info: PresentationSourceChange) => void,
): () => void {
  const api = window.electronAPI
  if (!api?.startPresentationWatch || !api.onPresentationSourceChanged) return () => {}

  const unsubscribe = api.onPresentationSourceChanged(onChange)
  void api.startPresentationWatch({ sourceId: source.id, sourceName: source.name })

  return () => {
    unsubscribe()
    void api.stopPresentationWatch?.()
  }
}
