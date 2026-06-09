# Серверная часть (`server/`)

Бэкенд — отдельный Node.js-сервис, который выполняет роль SFU (Selective
Forwarding Unit) на базе **mediasoup** и обменивается сигналами с клиентом через
**Socket.io**. По умолчанию слушает порт `3001`.

---

## `server/src/index.ts` — точка входа

- Поднимает Express-приложение с CORS и JSON-парсером.
- Эндпоинт **`GET /health`** — health-check (`{ status: "ok", uptime }`).
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
- `iceServers` — STUN (по умолчанию `stun:stun.l.google.com:19302`) и,
  опционально, TURN (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`);
- `workerSettings` — диапазон RTC-портов `40000–49999`, уровни логирования;
- `mediaCodecs` — поддерживаемые кодеки: Opus (аудио), VP8 и H264 (видео);
- `webRtcTransportOptions` — UDP/TCP, предпочтение UDP, начальный исходящий
  битрейт `3 Мбит/с`.

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

## `server/src/socket.ts` — Socket.io события

Хранит комнаты в памяти (`Map<roomId, Room>`), создаёт комнату при
необходимости и удаляет её, когда она опустела. Обрабатываемые события:

- **`joinRoom`** — проверяет: при отсутствии `create` комната должна
  существовать (иначе «Комната не найдена»); комната не должна быть полной
  (макс. 5); участник не должен уже быть в ней. Добавляет участника, уведомляет
  остальных событием `peerJoined`, возвращает RTP-capabilities и список
  существующих участников.
- **`createWebRtcTransport`** — создаёт транспорт нужного направления.
- **`connectTransport`** — подключает транспорт по DTLS-параметрам.
- **`produce`** — публикует поток участника и рассылает остальным `newProducer`.
- **`consume`** — создаёт consumer для потребления чужого потока.
- **`resumeConsumer`** — возобновляет consumer (после готовности клиента).
- **`closeProducer`** — закрывает поток (например, остановка демонстрации
  экрана) и рассылает `producerClosed`.
- **`pauseProducer`** — пауза/возобновление потока (mute/unmute микрофона),
  рассылает `producerPaused`.
- **`leaveRoom`** — явный выход.
- **`disconnect`** — неявный выход при разрыве соединения.

При выходе участник удаляется, остальным рассылается `peerLeft`, и пустая
комната уничтожается.

---

## `server/src/types.ts`

Содержит TypeScript-типы для payload'ов всех Socket.io-событий и моделей
(`JoinRoomPayload`, `ProducePayload`, `ConsumePayload`, `ExistingPeerPayload`,
`PeerData` и др.), обеспечивая типобезопасность обмена клиент↔сервер.

---

## Связь с клиентом

Все эти события вызываются из клиентского хука `useMediasoup`
(см. [`client-logic.md`](./client-logic.md)). Клиент задаёт адрес сервера через
`NEXT_PUBLIC_MEDIASOUP_URL`. Переменные окружения и запуск подробно описаны в
корневом `README.md` проекта.
