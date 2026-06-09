# Riplexo — Видеоплатформа

Бессрочные видеозвонки в один клик. Никаких таймеров и сложных настроек.

---

## Структура проекта

```
/
├── app/
│   ├── page.tsx                     # Главная страница
│   └── room/[roomId]/page.tsx       # Страница видеозвонка
├── components/
│   ├── hero.tsx                     # Hero-секция с кнопками
│   ├── start-call-dialog.tsx        # Попап «Начать звонок»
│   ├── join-call-dialog.tsx         # Попап «Войти по коду»
│   ├── video-tile.tsx               # Тайл участника
│   └── site-header.tsx              # Хедер
├── hooks/
│   └── use-mediasoup.ts             # Вся логика WebRTC / mediasoup-client
└── server/                          # Mediasoup бэкенд (Node.js, порт 3001)
    └── src/
        ├── index.ts                 # Точка входа — HTTP + Socket.io
        ├── config.ts                # Конфигурация из .env
        ├── Room.ts                  # Управление комнатой
        ├── Peer.ts                  # Модель участника
        ├── socket.ts                # Все Socket.io события
        └── types.ts                 # TypeScript типы
```

---

## Переменные окружения

### Фронтенд — `.env.local` (корень проекта)

Создать: `cp .env.local .env.local` — файл уже есть, заполни своими значениями.

| Переменная | Описание | Пример |
|---|---|---|
| `NEXT_PUBLIC_MEDIASOUP_URL` | URL Mediasoup сервера | `http://YOUR_SERVER_IP:3001` |
| `NEXT_PUBLIC_STUN_URL` | STUN сервер | `stun:stun.example.com:3478` |
| `NEXT_PUBLIC_TURN_URL` | TURN сервер | `turn:turn.example.com:3478` |
| `NEXT_PUBLIC_TURN_USERNAME` | Логин TURN | `your_username` |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | Пароль TURN | `your_password` |

### Бэкенд — `server/.env` (папка `server/`)

Создать: `cp server/.env.example server/.env`, затем заполнить.

| Переменная | Описание | Пример |
|---|---|---|
| `PORT` | Порт Mediasoup сервера | `3001` |
| `ANNOUNCED_IP` | **Публичный IP сервера** (обязательно!) | `1.2.3.4` |
| `CLIENT_ORIGIN` | URL фронтенда для CORS | `http://localhost:3000` |
| `TURN_URL` | TURN сервер | `turn:turn.example.com:3478` |
| `TURN_USERNAME` | Логин TURN | `your_username` |
| `TURN_CREDENTIAL` | Пароль TURN | `your_password` |
| `STUN_URL` | STUN сервер | `stun:stun.l.google.com:19302` |

> `ANNOUNCED_IP` — самое важное поле. Укажи публичный IP VPS, иначе WebRTC не установит соединение между участниками.

---

## Запуск

### Подготовка

```bash
# Заполни переменные окружения
cp server/.env.example server/.env
# Отредактируй server/.env — обязательно ANNOUNCED_IP и TURN-данные
```

### Разработка

```bash
# Фронтенд Next.js на :3000
pnpm dev

# Mediasoup сервер на :3001 (в отдельном терминале)
pnpm mediasoup:dev
```

### Продакшн

```bash
# Фронтенд
pnpm build && pnpm start

# Mediasoup (собирает TypeScript и запускает)
pnpm mediasoup
```

---

## Как работает звонок

1. Пользователь нажимает **«Начать звонок»** — генерируется код вида `4X9T-8WJS`
2. Нажимает **«Начать конференцию»** — переход на `/room/4X9T-8WJS`
3. Страница подключается к Mediasoup серверу через Socket.io ([`hooks/use-mediasoup.ts`](./hooks/use-mediasoup.ts))
4. Создаются WebRTC транспорты (send + recv) через TURN/STUN
5. Видео/аудио каждого участника публикуется как **Producer** на сервере
6. Остальные участники получают потоки через **Consumer**
7. Второй пользователь входит через **«Войти по коду»** — вводит `4X9T-8WJS` — попадает в ту же комнату

---

Built with [v0](https://v0.app) · [Continue working on v0 →](https://v0.app/chat/projects/prj_HDb0R94z8Xxx1aty1lMixmUtz788)
