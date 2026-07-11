# Десктопная версия (Electron)

Помимо веб-версии у Replixo есть **десктопное приложение на Electron** (Windows).
Оно не дублирует фронтенд: `.exe` — это тонкая оболочка Electron, которая просто
**загружает задеплоенный сайт по URL** (`https://replixo.ru`) в окно. Весь UI и
логика звонка остаются те же, что и в браузере, но Electron добавляет
возможности, недоступные обычной веб-странице:

- **системный выбор источника для демонстрации экрана** (через `desktopCapturer`);
- **overlay-режим** — пока вы демонстрируете экран, окно становится прозрачным и
  «поверх всего», превращаясь в полупрозрачный слой над рабочим столом с
  плавающими контролами и рисованием поверх экрана;
- **кастомный титлбар** (безрамочное окно с собственными кнопками
  свернуть/развернуть/закрыть);
- **надёжное копирование в буфер обмена** через нативный clipboard Electron.

> Документ описывает **только то, что уже реализовано**. Сам сайт (страницы,
> комната, чат, доска) описан в остальных файлах `about/`. Здесь — только то, что
> добавляет/меняет Electron-оболочка.

---

## Из чего состоит

| Файл | Роль |
|---|---|
| `electron/main.js` | Главный процесс: создание окна, разрешения медиа, IPC-обработчики (захват экрана, управление окном, overlay-режим, буфер обмена), single-instance lock. |
| `electron/preload.js` | Безопасный мост (`contextBridge`): пробрасывает в renderer `window.electronAPI` и `window.replixoDesktop`. |
| `electron/electron.d.ts` | TypeScript-типы для проброшенного API (`ElectronAPI`, `DesktopSource`, `ReplixoDesktop`, `MediaDevices.__electronPatched`). |
| `electron/icons/icon.png` | Иконка приложения и ресурс сборки. |
| `electron-builder.yml` | Конфигурация сборки `.exe` (NSIS-инсталлятор под Windows x64). |
| `package.json` | `"main": "electron/main.js"` + скрипты `electron`, `dist`, `dist:dir`; devDeps `electron`, `electron-builder`. |

**Renderer-часть (тот же Next.js-фронтенд, но активна только в Electron):**

| Файл | Роль |
|---|---|
| `components/electron-patches.tsx` | Монтируется в корневом `layout.tsx`. Патчит `getDisplayMedia` под Electron и помечает `<html>` классом `is-electron`. |
| `components/desktop-titlebar.tsx` | Кастомный титлбар (рендерится только в Electron). |
| `components/overlay-controls.tsx` | Плавающая панель управления в overlay-режиме (микрофон, камера, рисование, «Остановить демонстрацию»). |
| `components/annotation-toolbar.tsx` | Компактный тулбар рисования (карандаш/ластик, цвета, очистить, закрыть). |
| `components/stream-annotation-canvas.tsx` | Прозрачный `<canvas>` для рисования поверх демонстрируемого экрана (используется и в вебе, и в overlay). |
| `hooks/use-overlay-click-through.ts` | Менеджер click-through для overlay-режима + маркер интерактивных областей. |
| `lib/clipboard.ts` | `copyText()` — копирование с приоритетом нативного clipboard Electron. |
| `app/globals.css` | CSS для `is-electron` (резерв 32px под титлбар) и `data-overlay` (прозрачный фон, скрытие титлбара). |

---

## Главный процесс — `electron/main.js`

### Окно
- Создаётся **безрамочным и прозрачным**: `frame: false`, `transparent: true`,
  `backgroundColor: "#00000000"`. Это нужно для overlay-режима — на Windows
  прозрачность задаётся только при создании окна и не переключается позже,
  поэтому окно всегда безрамочное, а нативную рамку заменяет `DesktopTitlebar`.
- Размер `1280×800`, минимум `940×600`, меню скрыто (`autoHideMenuBar`),
  показывается по событию `ready-to-show`.
- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`,
  `preload: preload.js`, `backgroundThrottling: false` (чтобы не душить медиа в
  фоне).
- Загружает `APP_URL` (по умолчанию `https://replixo.ru`, переопределяется
  переменной окружения `APP_URL`).
- **Внешние ссылки** (mailto, другие домены) открываются в системном браузере
  через `setWindowOpenHandler` + `shell.openExternal`; ссылки на сам `APP_URL`
  открываются внутри окна.
- **Single-instance lock**: второй запуск не создаёт новое окно, а фокусирует
  существующее.

### Разрешения медиа
`setPermissionRequestHandler` / `setPermissionCheckHandler` разрешают только:
`media`, `display-capture`, `mediaKeySystem`, `notifications`, `clipboard-read`.

### IPC-обработчики
| Канал | Тип | Назначение |
|---|---|---|
| `get-desktop-sources` | `handle` | `desktopCapturer.getSources({screen, window})` → список источников (id, name, thumbnail DataURL, appIcon) для своего picker'а. |
| `set-display-source` | `handle` | Renderer сообщает, какой источник выбрал пользователь в кастомном пикере, ПЕРЕД вызовом штатного `getDisplayMedia()`. Сохраняется в `pendingDisplaySourceId`. |
| `window-minimize` / `window-maximize-toggle` / `window-close` | `on` | Управление окном из кастомного титлбара. |
| `window-is-maximized` | `handle` | Текущее состояние развёрнутости. |
| `window-maximize-changed` | `send`→renderer | Уведомление об изменении развёрнутости (для иконки кнопки). |
| `set-ignore-mouse-events` | `on` | Включение/выключение click-through (`setIgnoreMouseEvents`). |
| `get-cursor-point` | `handle` | Позиция курсора относительно содержимого окна (DIP-координаты) для надёжного hit-test в overlay. |
| `enter-overlay-mode` / `exit-overlay-mode` | `on` | Вход/выход из overlay-режима (см. ниже). |
| `clipboard-write-text` | `handle` | Нативная запись текста в буфер обмена ОС. |

---

## Мост preload — `window.electronAPI`

`preload.js` через `contextBridge` пробрасывает два объекта:

- **`window.replixoDesktop`** — `{ isDesktop: true, platform }` (флаг «это десктоп»).
- **`window.electronAPI`** — основной API:
  - `isElectron`, `platform`
  - `getDesktopSources()`
  - `enterOverlayMode()` / `exitOverlayMode()`
  - `windowMinimize()` / `windowMaximizeToggle()` / `windowClose()`
  - `isWindowMaximized()` / `onMaximizeChange(cb)` (возвращает функцию отписки)
  - `setIgnoreMouseEvents(ignore, options)`
  - `getCursorPoint()`
  - `writeClipboardText(text)`

Renderer везде проверяет `window.electronAPI?.isElectron`, чтобы один и ��от же
код работал и в браузере (где API отсутствует), и в Electron.

---

## Демонстрация экрана в Electron — `electron-patches.tsx` + `main.js`

В Electron `navigator.mediaDevices.getDisplayMedia()` сам не показывает
системный picker. Поэтому `ElectronPatches` **подменяет `getDisplayMedia`**, но
важно: подмена **сохраняет штатный путь захвата**, а не уводит на legacy-API.

Актуальный поток (renderer → main):

1. renderer запрашивает источники через `electronAPI.getDesktopSources()`;
2. показывает **собственный picker** (`showScreenPicker`) — сетка карточек с
   превью окон/экранов, построенная вручную на DOM;
3. передаёт выбранный `sourceId` в main через `electronAPI.setDisplaySource()`
   (IPC `set-display-source` → `pendingDisplaySourceId`);
4. вызывает **настоящий** `getDisplayMedia(constraints)` (сохранённый оригинал),
   передавая те же constraints, что и веб-версия — `restrictOwnAudio: true`
   (см. `hooks/mediasoup/use-media-controls.ts`);

> ⚠️ **Регрессия и фикс (нет входящего звука при демонстрации):**
> `suppressLocalAudioPlayback` здесь **не передаётся**. В связке с
> `audio: "loopback"` он переводит Chromium в режим «loopback с заглушением» и
> глушит локальное воспроизведение всего системного микса — то есть
> демонстрирующий переставал слышать **всех** участников. Constraint убран,
> входящий звук восстановлен.
5. в main `setDisplayMediaRequestHandler` подставляет выбранный источник и
   отдаёт `audio: "loopback"` **только если** звук реально запрошен
   (`request.audioRequested`).

> ⚠️ **Регрессия и фикс (плавающий 50/50: участника «то слышно, то нет»):**
> удалённые треки приходят от mediasoup-консьюмера **на паузе** и размьючиваются
> только после `resumeConsumer`. Если `AudioContext`-узел
> (`createMediaStreamSource`) создавался, пока трек ещё `muted`, Chromium
> оставлял его **навсегда немым** — участник, зашедший «вглухую», так и оставался
> неслышным. Фикс в `lib/audio-unlock.ts`: узел строится **отложенно** — по
> событию `unmute` трека, а до этого звук идёт напрямую через `<audio>`, так что
> тишины не бывает. См. `buildStreamNodes` / `connectStreamToContext`.

### Почему НЕ legacy `chromeMediaSource: "desktop"`

Раньше renderer подменял захват на legacy-`getUserMedia({ chromeMediaSource: "desktop" })`.
Этот путь захватывает системный звук целиком и **полностью игнорирует
constraints** — включая `restrictOwnAudio`. Из-за этого при «демонстрации со
звуком» в аудиодорожку попадал звук самого звонка (голоса других участников,
которые проигрываются на машине демонстрирующего), возвращался обратно, и
зритель слышал самого себя с задержкой (эхо). Сейчас этот путь **удалён**.

Electron 42 = **Chromium 148**, где `restrictOwnAudio` уже поддержан. Через
штатный `getDisplayMedia` Chromium честно вычитает **аудио собственной вкладки**
(голоса участников, которые проигрывает наше приложение) из loopback-микса.

### Граница возможного (важно для диагностики эха)

`restrictOwnAudio` вычитает **только звук, который издаёт само окно Electron**
(наш renderer с воспроизведением звонка). Он **не может** убрать эхо, если
голоса участников звучат **вне** этого окна, например:

- звонок открыт **параллельно в обычном браузере**, а демонстрация идёт из
  Electron (или наоборот) — для Electron это «чужой» звук в системном миксе;
- захватывается **окно/экран другого приложения** со своим звуком, который ОС
  всё равно отдаёт как часть системного loopback-микса.

В этих случаях штатного вычитания недостаточно и остаётся только DSP-путь
(адаптивный AEC-воркл��т, см. `about/AEC/`). Практический вывод: тестировать
эхо в Electron нужно, когда **весь звонок сидит в одном и том же окне Electron**,
а не «звонок в браузере + демонстрация в приложении».

Патч ставится один раз (флаг `navigator.mediaDevices.__electronPatched`). В
браузере функция ничего не делает. Также `ElectronPatches` добавляет
`<html class="is-electron">` для CSS-резерва под титлбар.

---

## Кастомный титлбар — `desktop-titlebar.tsx`

- Рендерится **только в Electron** (`window.electronAPI?.isElectron`).
- Фиксированная полоса высотой 32px (`h-8`) сверху, зона перетаскивания через
  CSS `-webkit-app-region: drag`, кнопки — `no-drag`.
- Кнопки: свернуть (`windowMinimize`), развернуть/восстановить
  (`windowMaximizeToggle`, иконка меняется по `onMaximizeChange`), закрыть
  (`windowClose`).
- В overlay-режиме скрывается через CSS (`html[data-overlay='1'] .desktop-titlebar`).
- В `globals.css`: `html.is-electron body { padding-top: 32px }` резервирует
  место под полосу, чтобы контент не уезжал под неё.

---

## Overlay-режим (демонстрация экрана)

Когда пользователь **сам демонстрирует экран** в Electron, окно превращается в
полупрозрачный слой поверх рабочего стола. Логика — в `room-client.tsx`
(`useEffect` по `isScreenSharing` + `isElectron`).

### Что происходит при входе
1. Renderer ставит `document.documentElement.dataset.overlay = "1"` → CSS делает
   фон документа прозрачным и убирает резерв под титлбар.
2. Вызывает `electronAPI.enterOverlayMode()`. Главный процесс:
   - сохраняет прежние bounds/maximize/alwaysOnTop для восстановления;
   - растягивает окно на весь дисплей, ставит `alwaysOnTop("screen-saver")` и
     `setVisibleOnAllWorkspaces`;
   - включает `setIgnoreMouseEvents(true, { forward: true })` — клики по умолчанию
     **проходят сквозь окно на рабочий стол**.
3. Прячется обычный UI комнаты (хедер, контролы, баннеры). Остаются только
   `OverlayControls` (плавающая панель снизу) и, при необходимости, холст
   рисования + тулбар.

При остановке демонстрации — `exitOverlayMode()` восстанавливает прежнее
состояние окна, убирает `data-overlay`.

### Click-through — `use-overlay-click-through.ts`
Проблема: на Windows над прозрачными пикселями forwarded-события мыши доходят
ненадёжно, поэтому hit-test по DOM-событиям не срабатывает. Решение:
`useOverlayMouseManager` **опрашивает реальную позицию курсора из ОС** (~30 раз/с)
через `electronAPI.getCursorPoint()` и сам делает hit-test через
`document.elementFromPoint`:
- курсор над элементом с атрибутом `data-overlay-interactive`
  (`OVERLAY_INTERACTIVE_ATTR`) → перехватываем мышь (`setIgnoreMouseEvents(false)`),
  клики работают;
- иначе → клики снова проходят на рабочий стол.

Интерактивные области помечаются `useOverlayClickThrough()` (возвращает props с
маркером): панель `OverlayControls`, сайдбар участников, панель чата с её
стрелкой-хэндлом, обёртки холста и тулбара рисования.

### `OverlayControls`
Минимальная плавающая панель снизу по центру: микрофон, камера, рисование,
«Остановить демонстрацию». Всё с `pointer-events` и маркером интерактивности.

Панель можно свернуть/развернуть стрелкой-«язычком» — так же, как нижнюю
панель в веб-версии (`RoomControls`). В свёрнутом состоянии панель уезжает за
нижнюю кромку экрана (через `translateY` на величину измеренной высоты панели
+ отступ), а у кромки остаётся только язычок со стрелкой `ChevronUp`, по клику
на который панель возвращается. Высота панели измеряется `ResizeObserver`, сам
язычок остаётся видимым и интерактивным в overlay-режиме.

---

## Рисование поверх экрана (annotation)

Доступно, пока идёт демонстрация экрана — **своя или чужая** (в `room-client.tsx`
флаг `canAnnotate = isScreenSharing || hasRemoteScreen`). Работает и в вебе, и в
overlay-режиме Electron.

- `stream-annotation-canvas.tsx` — прозрачный `<canvas>`. Штрихи хранятся как
  **векторы в нормализованных координатах (0..1)** и рассылаются всем участникам,
  поэтому ложатся в одно и то же место на любом размере экрана. Ластик —
  штрих с `globalCompositeOperation: "destination-out"`. Ничего не сохраняется:
  при остановке демонстрации холст размонтируется.
- Рассылка/подписка идут через mediasoup-хук: `sendAnnotationStroke`,
  `sendAnnotationClear`, `subscribeAnnotationStroke`, `subscribeAnnotationClear`.
- `annotation-toolbar.tsx` — выбор инструмента (карандаш/ластик), цвета,
  очистить всё, закрыть.
- В вебе холст накладывается на тайл экрана в `RoomVideoGrid`; в overlay-режиме
  — полноэкранный холст поверх рабочего стола (в тех же координатах, что у
  остальных участников).

---

## Буфер обмена — `lib/clipboard.ts`

`copyText()` копирует с тремя попытками по приоритету:
1. **нативный clipboard Electron** (`electronAPI.writeClipboardText`) — основной
   путь в десктопе, т.к. `navigator.clipboard` в безрамочном/прозрачном окне
   ненадёжен;
2. `navigator.clipboard.writeText` — ��бычный веб;
3. `document.execCommand("copy")` через скрытый `textarea` — запасной путь.

---

## Сборка и запуск

Скрипты в `package.json`:

| Скрипт | Команда | Что делает |
|---|---|---|
| `electron` | `electron .` | Запуск десктоп-оболочки локально (грузит `APP_URL`). |
| `dist` | `electron-builder --win --config electron-builder.yml` | Сборка NSIS-инсталлято��а `.exe` под Windows x64. |
| `dist:dir` | `electron-builder --win --dir ...` | Сборка распакованной папки (без инсталлятора) для отладки. |

`electron-builder.yml`:
- `appId: ru.replixo.desktop`, `productName: Replixo`, вывод в `release/`;
- в сборку попадают только `electron/**/*` и `package.json` — само приложение
  грузится по URL, поэтому `.exe` лёгкий;
- target — `nsis` (x64): не one-click, разрешает выбор папки установки, создаёт
  ярлыки на рабочем столе и в меню «Пуск».

> Переменная окружения `APP_URL` позволяет указать другой адрес (например,
> локальный `http://localhost:3000`) вместо продакшн-сайта.
