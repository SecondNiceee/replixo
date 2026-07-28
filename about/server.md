# Серверная часть (`server/`)

Бэкенд — отдельный Node.js-сервис, который выполняет роль SFU (Selective
Forwarding Unit) на базе **mediasoup** и обменивается сигналами с клиентом через
**Socket.io**. По умолчанию слушает порт `3001`.

---

## `server/src/index.ts` — точка входа

- Поднимает Express-приложение с CORS и JSON-парсером.
- Эндпоинт **`GET /health`** — health-check (`{ status: "ok", uptime }`).
- **Вложения чата** (файлы хранятся на диске VPS, см. `uploads.ts`):
  - **`POST /rooms/:roomId/upload`** — загрузка файла (multer, лимит
    `MAX_FILE_SIZE`, по умолчанию 25 МБ; файл сохраняется под случайным UUID);
  - **`GET /uploads/<roomId>/<file>`** — раздача файлов (`express.static`) с
    заголовками безопасности: `nosniff`, не-картинки отдаются как `attachment`;
  - фоновый сборщик `sweepOrphanUploads` запускается при старте и раз в час —
    удаляет папки комнат, осиротевшие после жёсткого падения (`UPLOAD_TTL_MS`).
- **`GET /download/windows`** — отдаёт `.exe`-установщик десктоп-приложения с
  диска VPS (`WINDOWS_INSTALLER_PATH`, не в git) через `res.download()` с
  поддержкой Range-запросов (докачка). Ссылка стоит в хедере лендинга.
- Создаёт HTTP-сервер.
- Создаёт mediasoup **Worker**; при его падении логирует и выходит через 2 сек.
- Запускает Socket.io (`setupSocketIO`).
- Корректно завершается по `SIGINT`/`SIGTERM` (закрывает worker и сервер).

---

## `server/src/config.ts` — конфигурация

Читает настройки из переменных окружения:

- `PORT` — порт сервера (по умолчанию `3001`);
- `CLIENT_ORIGIN` — разрешённый origin для CORS (по умолчанию
  `http://localhost:3000`);
- `MAX_PEERS_PER_ROOM = 5` — максимум участников в комнате;
- `ANNOUNCED_IP` — публичный IP сервера для ICE (важно для соединения);
- `iceServers` — два STUN Google (`STUN_URL` переопределяет первый) и,
  опционально, собственный TURN-релей: `TURN_URL` (можно список через запятую —
  UDP/TCP/TLS-варианты), `TURN_USERNAME`, `TURN_CREDENTIAL`. TURN критичен для
  звонков телефон↔ПК (симметричный NAT/CGNAT у мобильных операторов);
- вложения чата: `UPLOAD_DIR` (по умолчанию `<cwd>/uploads`),
  `MAX_FILE_SIZE` (25 МБ), `UPLOAD_TTL_MS` (48 ч — TTL осиротевших папок);
- установщик: `WINDOWS_INSTALLER_PATH` (по умолчанию
  `<cwd>/downloads/Replixo-Setup-version-3.exe`), `WINDOWS_INSTALLER_NAME`;
- `workerSettings` — диапазон RTC-портов `40000–49999`, уровни логирования;
- `mediaCodecs` — поддерживаемые кодеки: Opus с FEC и DTX (аудио), VP8 и H264
  (видео);
- `webRtcTransportOptions` — UDP/TCP, предпочтение UDP, начальный исходящий
  битрейт `6 Мбит/с` (чтобы демонстрация экрана была резкой с первой секунды),
  минимальный `300 Кбит/с`.

---

## `server/src/Room.ts` — комната

Класс `Room` инкапсулирует одну комнату звонка. Создаётся фабрикой
`Room.create(id, worker)`, которая поднимает mediasoup `Router` с заданными
кодеками. Возможности:

- **Управление участниками**: `addPeer`, `removePeer`, `hasPeer`, `getPeer`,
  `isFull` (≥ 5), `isEmpty`, `getPeerIds`.
- **`getExistingPeersFor(peerId)`** — состояние всех участников, кроме
  запрашивающего, чтобы новый клиент мог подписаться на их потоки.
- **Транспорты**: `createWebRtcTransport(peerId, direction)` (`send`/`recv`),
  `connectTransport`. При закрытии DTLS транспорт закрывается.
- **Produce**: `produce(...)` — создаёт producer на транспорте участника.
- **Consume**: `consume(...)` — находит recv-транспорт, проверяет
  `canConsume`, создаёт consumer (стартует на паузе, возобновляется после ack
  клиента).
- **Управление потоками**: `closeProducer`, `pauseProducer`, `resumeProducer`,
  `resumeConsumer`.
- **`getRtpCapabilities()`** — capabilities роутера.
- **`close()`** — закрывает всех участников и роутер.

---

## `server/src/Peer.ts` — участник

Класс `Peer` хранит данные одного участника: `peerId`, `displayName`,
`socketId`, а также `Map` его транспортов, producer'ов и consumer'ов, и его
`rtpCapabilities`. Предоставляет методы добавления/получения транспортов,
producer'ов, consumer'ов и `close()` для очистки (закрывает транспорты и
очищает коллекции).

---

## `server/src/socket.ts` + `server/src/socket/` — Socket.io события

`socket.ts` — тонкий оркестратор: создаёт Socket.io-сервер (CORS по
`CLIENT_ORIGIN`, `pingTimeout: 30 c`, `pingInterval: 10 c` — чтобы пережить
кратковременный обрыв сети) и на каждое подключение регистрирует обработчики
из модулей папки `socket/`, сгруппированных по доменам:

| Модуль | Назначение |
|---|---|
| `socket/helpers.ts` | Общие типы (`Callback`, `SocketSession`, `HandlerContext`), `ack`/`err`, фабрика rate-limiter'а (скользящее окно). |
| `socket/room-registry.ts` | In-memory хранилище: `rooms` (`Map<roomId, Room>`), `peerSockets` (peerId → socketId), таймеры grace-window, `getOrCreateRoom` (с гидрацией доски и рисунков из БД), `cleanupRoomIfEmpty` (удаляет пустую комнату + историю чата и вложения), `authedRoom` (проверка, что отправитель владеет peerId). |
| `socket/media-handlers.ts` | WebRTC-сигналинг (см. ниже). |
| `socket/chat-handlers.ts` | Текстовый чат комнаты. |
| `socket/whiteboard-handlers.ts` | Совместна�� доска (tldraw). |
| `socket/presentation-handlers.ts` | Синхронизация слайдов + рисование поверх слайдов. |
| `socket/annotation-handlers.ts` | Эфемерное рисование поверх демонстрации экрана. |
| `socket/lifecycle-handlers.ts` | Переподключение и выход (`rejoinProbe`, `leaveRoom`, `disconnect`). |

### Медиа-события (`media-handlers.ts`)

- **`joinRoom`** — проверяет: при отсутствии `create` комната должна
  существовать (иначе «Комната не найдена»); комната не должна быть полной
  (макс. 5). Если этот `peerId` уже подключён с другого сокета (другая
  вкладка/устройство), ��тарая сессия «кикается» (`kicked`). Добавляет
  участника, уведомляет остальных `peerJoined`, возвра��ает RTP-capabilities,
  список участников, историю чата, отметки о прочтении, состояние доски,
  текущий слайд презентации и рисунки по слайдам.
- **`createWebRtcTransport`** — создаёт транспорт нужного направления.
- **`connectTransport`** — подключает транспорт по DTLS-параметрам.
- **`restartIce`** — перезапуск ICE (клиент вызывает при
  `disconnected`/`failed` состоянии транспорта).
- **`produce`** — публикует поток участника и рассылает остальным `newProducer`.
- **`consume`** — создаёт consumer для потребления чужого потока.
- **`resumeConsumer`** — возобновляет consumer (после готовности клиента).
- **`closeProducer`** — закрывает поток (например, остановка демонстрации
  экрана) и рассылает `producerClosed`.
- **`pauseProducer`** — пауза/возобновление потока (mute/unmute микрофона),
  рассылает `producerPaused`.

### Чат (`chat-handlers.ts`)

- **`chatMessage`** — валидация (текст ≤ 2000 символов, вложение только из
  `/uploads/<roomId>/`), аутентификация отправителя, rate-limit
  (5 сообщений / 2 c), персист в БД (`saveMessage`) и рассылка остальным
  (`socket.to()` — отправитель добавляет сообщение оптимистично).
- **`chatRead`** — участник прочитал чат до отметки времени; персист
  (`saveReadMarker`) и рассылка остальным для «галочек» прочтения.

### Доска (`whiteboard-handlers.ts`)

- **`whiteboardOpen` / `whiteboardClose`** — открывают/закрывают доску для
  всех (флаг на Room, персист через `saveWhiteboard`), при открытии остальным
  передаётся текущий снапшот.
- **`whiteboardChange`** — ретрансляция инкрементального diff'а tldraw
  (rate-limit 240/с).
- **`whiteboardSnapshot`** — полный снапшот документа (≤ 5 МБ), хранится в
  памяти и БД для «поздних» участников.

### Презентация (`presentation-handlers.ts`)

> Примечание: серверные обработчики презентации реализованы, но текущий
> веб-клиент эти события не отправляет (UI показа слайдов на клиенте нет) —
> функциональность зарезервирована.

- **`presentationSlide`** — докладчик сменил слайд; состояние хранится на Room
  (для latecomer'ов) и рассылается всем (rate-limit 10/с, валидация индексов).
- **`presentationEnded`** — докладчик закрыл файл; только активный докладчик
  может завершить показ.
- **`presentationStroke`** — ретрансляция штриха рисунка на слайде
  (rate-limit 300/с).
- **`presentationDrawClear`** — очистить рисунок на слайде для всех (персист).
- **`presentationDrawSnapshot`** — снапшот канвы слайда (≤ 5 МБ) для
  персистентности и поздних участников (без broadcast).

### Аннотации демонстрации экрана (`annotation-handlers.ts`)

- **`annotationStroke`** — ретрансляция vector-штриха поверх демонстрации
  (rate-limit 300/с). НЕ персистятся — живут пока идёт демонстрация.
- **`annotationClear`** — стереть все аннотации для всех.

### Жизненный цикл (`lifecycle-handlers.ts`)

- **`rejoinProbe`** — после реконнекта клиент проверяет, жив ли ещё его peer.
  Если да — отменяется отложенное удаление, сокет заново входит в комнату и
  перепривязывается к peerId; если нет — клиент делает полный rejoin.
- **`leaveRoom`** — явный выход.
- **`disconnect`** — неявный обрыв. Участник НЕ удаляется сразу; длительность
  grace-window выбирается по самому надёжному сигналу (Socket.io передаёт
  причину обрыва в событие `disconnect(reason)`):
  1. **6 с** (`CLOSE_GRACE_MS`) — клиент прислал beacon о закрытии (см. ниже);
  2. **10 с** (`CLEAN_CLOSE_GRACE_MS`) — чистое закрытие сокета
     (`transport close` / namespace disconnect) без beacon: вкладку почти
     наверняка закрыли/перезагрузили. Приходит мгновенно, без ожидания
     ping-таймаута, поэтому остальные не «висят» с ушедшим участником по минуте;
     запаса хватает на перезагрузку страницы или смену сети (WiFi↔4G), которые
     переподключатся через `rejoinProbe`;
  3. **45 с** (`DISCONNECT_GRACE_MS`) — всё остальное (`ping timeout`,
     `transport error`): похоже на реальный обрыв сети / блокировку телефона,
     держим щедрое окно, чтобы кратковременная потеря связи не «выкидывала»
     человека.
  Удаление происходит, только если участник не вернулся в пределах окна.

При выходе участник удаляется, остальным рассылается `peerLeft` (и
`presentationEnded`, если уходил докладчик), пустая комната уничтожается
вместе с историей чата и загруженными файлами.

---

## `server/src/uploads.ts` — файлы вложений на диске

Утилиты хранения вложений чата: файлы лежат в `<UPLOAD_DIR>/<roomId>/<uuid>.<ext>`.
Валидация `roomId` строгим регулярным выражением (защита от path traversal).
Папка комнаты удаляется целиком при уничтожении комнаты (`deleteRoomUploads`),
а `sweepOrphanUploads` фоново подчищает папки старше `UPLOAD_TTL_MS` после
жёстких падений процесса.

---

## `server/src/db.ts` — персистентность комнат

Слой работы с PostgreSQL (та же БД, что у Next.js-приложения): сохраняет
историю чата (`saveMessage`), маркеры прочтения (`saveReadMarker`), состояние
и снапшот доски (`saveWhiteboard`), состояние презентации и рисунки по слайдам.
Используется для гидрации комнаты при её пересо��дании (`getOrCreateRoom`) и
чистки при уничтожении пустой комнаты.

---

## `server/src/types.ts`

Содержит TypeScript-типы для payload'ов всех Socket.io-событий и моделей
(`JoinRoomPayload`, `ProducePayload`, `ConsumePayload`, `ExistingPeerPayload`,
`PeerData` и др.), обеспечивая типобезопасность обмена клиент↔сервер.

---

## Связь с клиентом

Все эти события вызываются из клиентского хука `useMediasoup`
(см. [`client-logic.md`](./client-logic.md)). Адрес сервера резолвится в
`hooks/mediasoup/types.ts` (`resolveServerUrl`): сначала берётся единая
переменная `NEXT_PUBLIC_MEDIASOUP_URL`; если её нет — в проде используется тот же
origin, что и у приложения (nginx проксирует `/socket.io/`), а на localhost —
`http://localhost:3001`. Та же переменная используется в
`components/site-header.tsx` для ссылки на скачивание Windows-установщика
(`/download/windows`). Переменные окружения и запуск подробно описаны в корневом
`README.md` проекта.
