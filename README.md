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

Создать: `cp .env.example .env.local`, затем заполнить.

| Переменная | Описание | Пример |
|---|---|---|
| `DATABASE_URL` | Postgres (тот же, что у сервера) | `postgres://user:pass@host:5432/db` |
| `INTERNAL_HOOK_SECRET` | Секрет для хука дружбы. **Должен совпадать с `server/.env`** | `openssl rand -hex 32` |
| `MEDIASOUP_URL` | Приватный адрес сервера для запросов сервер→сервер | `http://localhost:3001` |
| `NEXT_PUBLIC_MEDIASOUP_URL` | URL Mediasoup сервера | `http://YOUR_SERVER_IP:3001` |

> STUN/TURN во фронтенде не настраиваются: сервер передаёт их клиенту сам (см. `server/.env` ниже).

### Бэкенд — `server/.env` (папка `server/`)

Создать: `cp server/.env.example server/.env`, затем заполнить.

| Переменная | Описание | Пример |
|---|---|---|
| `PORT` | Порт Mediasoup сервера | `3001` |
| `ANNOUNCED_IP` | **Публичный IP сервера** (обязательно!) | `1.2.3.4` |
| `CLIENT_ORIGIN` | URL фронтенда для CORS | `http://localhost:3000` |
| `DATABASE_URL` | Postgres для истории чата | `postgres://user:pass@host:5432/db` |
| `INTERNAL_HOOK_SECRET` | Секрет для `/internal/*`. **Должен совпадать с корневым `.env.local`** | `openssl rand -hex 32` |
| `TURN_URL` | TURN сервер | `turn:turn.example.com:3478` |
| `TURN_USERNAME` | Логин TURN | `your_username` |
| `TURN_CREDENTIAL` | Пароль TURN | `your_password` |
| `STUN_URL` | STUN сервер | `stun:stun.l.google.com:19302` |
| `MEDIASOUP_WORKERS` | Число mediasoup-воркеров (1 воркер = 1 ядро). Каждый слушает `RTC_PORT + i` — все эти порты нужно пробросить в балансере | `1` |
| `MAX_ROOMS` | Максимум комнат на сервере | `300` |
| `MAX_SOCKETS_PER_IP` | Максимум сокетов звонка с одного IP | `40` |
| `MAX_ROOM_CREATIONS_PER_IP` | Новых комнат с одного IP за 10 минут | `20` |
| `MAX_UPLOADS_PER_IP_PER_MINUTE` | Загрузок файлов в чат комнаты с одного IP в минуту | `20` |
| `ROOM_UPLOAD_QUOTA` | Лимит файлов на одну комнату, байты | `524288000` |
| `TRUST_PROXY` | `0` — не доверять `X-Real-IP` (если порт 3001 открыт наружу напрямую) | `1` |

> `ANNOUNCED_IP` — самое важное поле. Укажи публичный IP VPS, иначе WebRTC не установит соединение между участниками.

> `INTERNAL_HOOK_SECRET` задаётся **в обоих файлах одним и тем же значением**.
> Если значения различаются — хук вернёт 401; если переменной нет — 503. В обоих
> случаях realtime дружбы деградирует до фолбэка через websocket инициатора:
> второй участник увидит заявку или удаление только после перезагрузки страницы,
> если у первого не было живого соединения. Секрет не имеет префикса
> `NEXT_PUBLIC_` и в браузер не попадает.

---

## Запуск

### Подготовка

```bash
# Заполни переменные окружения
cp .env.example .env.local
cp server/.env.example server/.env

# Один секрет для внутреннего хука — в оба файла одно и то же значение
openssl rand -hex 32

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

### Обновление Windows-приложения

Клиент проверяет обновления при запуске и каждые четыре часа. Скачанная
версия устанавливается при обычном выходе из приложения. Версии до 0.1.1
нужно один раз обновить вручную.

1. Разверни и пересобери сервер звонков. При необходимости задай
   `WINDOWS_UPDATES_DIR=/var/www/replixo/server/downloads/updates` в
   `server/.env` и перезапусти процесс `server`. По умолчанию используется
   `downloads/updates` относительно рабочей папки процесса.
2. Для каждого нового выпуска подними `version` в `package.json` и на Windows
   запусти `pnpm run dist`. Если отсутствует нативный аудиохелпер, сначала
   выполни `pnpm run build:native`.
3. Загрузи в папку обновлений `Replixo-Setup-<версия>.exe` и соседний
   `.exe.blockmap`. Сохраняй предыдущие файлы для скачивания разницы версий.
   Загрузи `latest.yml` последним и замени старый манифест атомарным переименованием
   в той же папке. Все три файла должны быть из одной сборки.
4. Проверь `https://replixo.ru/download/updates/windows/latest.yml` и обновление
   с предыдущей установленной версии. Логи клиента ищи по метке `[updates]`
   в `%APPDATA%\Replixo\logs\main.log`.
5. Для ручной установки отдельно обнови файл по `WINDOWS_INSTALLER_PATH`
   (по умолчанию `server/downloads/Replixo-Setup-version-4.exe`). Его скачивают
   через `/download/windows`.

Публичный URL записан в конфигурации electron-builder. Nginx уже направляет
`/download/` на сервер звонков. Для публичного выпуска настрой подпись
Windows-установщика и используй того же подписанта в следующих сборках.

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
