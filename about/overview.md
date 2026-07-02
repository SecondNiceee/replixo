# Обзор продукта

## Что это

**Replixo** — веб-приложение для видеосвязи, работающее целиком в браузере.
Ключевая идея — пользователю не нужно ничего устанавливать: он создаёт комнату
или входит в неё по короткому коду и сразу начинает звонок (регистрация
необязательна, но даёт аккаунт, друзей и синхронизацию настроек). Помимо видео
есть текстовый чат, совместная доска (tldraw) и настройки звуков.

Заявленные на сайте свойства (см. блок преимуществ на главной):

- работает без VPN — прямое соединение между участниками;
- без ограничений по времени звонка;
- без установки приложений (всё в браузере);
- приватность: соединения шифруются, вход только по коду;
- подключение в один клик, без регистрации;
- демонстрация экрана в высоком качестве;
- видео в 1080p — бесплатно.

Метаданные сайта (`app/layout.tsx`): заголовок «Replixo — Мгновенные
видеозвонки», язык интерфейса — русский (`lang="ru"`), тёмная тема по умолчанию.

## Технологический стек

**Фронтенд:**
- Next.js 16 (App Router), React 19, TypeScript;
- Tailwind CSS v4 + shadcn-стиль компонентов (`components/ui`);
- иконки `lucide-react`;
- шрифты Inter и JetBrains Mono (`next/font/google`);
- `socket.io-client` и `mediasoup-client` для видеосвязи через WebRTC;
- `zustand` — состояние настроек (плавающая кнопка чата, громкость звуков);
- `tldraw` — совместная доска;
- `swr` — клиентская загрузка данных (например, друзья);
- `@vercel/analytics` (только в production).

**Аутентификация и БД:**
- `better-auth` — авторизация (email + пароль), сессии;
- `drizzle-orm` + `pg` — PostgreSQL (схема в `lib/db/schema.ts`,
  миграции в `drizzle/`);
- `nodemailer` / `resend` — письма для сброса пароля.

**Бэкенд видеосвязи (`server/`):**
- Node.js + Express (health-check, загрузка/раздача вложений чата через
  `multer`, эндпоинт скачивания Windows-установщика);
- `socket.io` (сигналинг, чат, доска, аннотации);
- `mediasoup` (SFU-сервер, маршрутизация медиапотоков);
- `pg` — персистентность истории чата, доски и маркеров прочтения в той же
  PostgreSQL;
- порт по умолчанию `3001`.

**Десктоп (`electron/`):**
- `electron` + `electron-builder` — тонкая оболочка под Windows, которая
  загружает задеплоенный сайт по URL (`https://replixo.ru`);
- добавляет системный выбор источника экрана, overlay-режим поверх рабочего
  стола, кастомный титлбар и нативный буфер обмена.
- Подробно — [`desktop.md`](./desktop.md).

## Карта файлов проекта

```
/
├── app/
│   ├── layout.tsx                   # Корневой layout, метаданные, шрифты
│   ├── globals.css                  # Дизайн-токены и темы (Tailwind v4)
│   ├── page.tsx                     # Главная страница (лендинг)
│   ├── sign-in/ , sign-up/          # Вход и регистрация (Better Auth)
│   ├── forgot-password/ , reset-password/  # Сброс пароля
│   ├── profile/                     # Профиль: имя, друзья
│   ├── api/                         # Роуты: auth, friends, users, user-settings
│   └── room/[roomId]/               # Страница видеозвонка (набор компонентов)
│       ├── page.tsx                 # Серверная обёртка
│       ├── room-client.tsx          # Главный клиентский оркестратор
│       ├── room-header.tsx          # Верхняя панель
│       ├── room-controls.tsx        # Нижняя панель управления
│       ├── room-video-grid.tsx      # Раскладки видео
│       ├── room-chat.tsx            # Панель чата
│       ├── room-status.tsx          # Экраны состояний
│       ├── floating-chat-button.tsx # Плавающая кнопка чата
│       ├── room-settings-dialog.tsx # Настройки (чат + звуки)
│       └── chat-button-settings.tsx # Настройки кнопки чата
│
├── components/
│   ├── logo.tsx                     # Логотип Replixo
│   ├── site-header.tsx              # Хедер главной страницы
│   ├── hero.tsx                     # Hero-секция с кнопками действия
│   ├── features.tsx                 # Блок преимуществ
│   ├── quality-banner.tsx           # Баннер «Видео в 1080p»
│   ├── auth-form.tsx , auth-buttons.tsx  # Формы и кнопки авторизации
│   ├── start-call-dialog.tsx        # Диалог «Начать звонок»
│   ├── join-call-dialog.tsx         # Диалог «Войти по коду»
│   ├── edit-name-dialog.tsx         # Диалог «Ваше имя»
│   ├── enable-sound-banner.tsx      # Баннер «Включить звук»
│   ├── whiteboard.tsx               # Совместная доска (tldraw)
│   ├── video-tile.tsx               # Тайл участника
│   └── ui/                          # Базовые UI-компоненты (button, dialog, input, dropdown-menu, slider)
│
├── hooks/
│   ├── use-mediasoup.ts             # Оркестратор видеосвязи (join/leave, socket-события)
│   ├── mediasoup/                   # Модули ядра видеосвязи
│   │   ├── types.ts                 # Типы, константы, пресеты качества
│   │   ├── reducer.ts               # Reducer состояния комнаты
│   │   ├── use-transports.ts        # Транспорты, consume, ICE restart
│   │   ├── use-media-controls.ts    # Микрофон, камера, демонстрация экрана
│   │   ├── use-chat.ts              # Чат, вложения, маркеры прочтения
│   │   └── use-whiteboard.ts        # Доска и аннотации поверх экрана
│   ├── use-audio-devices.ts         # Список доступных микрофонов
│   ├── use-speaking.ts              # Детектор «говорит сейчас»
│   ├── use-overlay-click-through.ts # Click-through в overlay-режиме (Electron)
│   ├── use-chat-button-sync.ts      # Синхронизация настроек кнопки чата с БД
│   └── use-room-settings-sync.ts    # Синхронизация настроек звуков с БД
│
├── stores/
│   ├── chat-button-store.ts         # Позиция/видимость/хоткей кнопки чата
│   └── room-settings-store.ts       # Громкость звуков
│
├── lib/
│   ├── audio-unlock.ts              # Разблокировка автовоспроизведения звука
│   ├── sounds.ts                    # Синтезированные звуки уведомлений
│   ├── display-name.ts              # Имя пользователя в localStorage
│   ├── auth.ts , auth-client.ts     # Better Auth (сервер/клиент)
│   ├── db/                          # Drizzle: подключение и схема
│   └── utils.ts                     # Утилита cn() для классов
│
├── server/                          # Mediasoup-бэкенд (Node.js)
│   └── src/
│       ├── index.ts                 # Точка входа: Express + HTTP + worker, загрузка/раздача вложений, /download/windows
│       ├── config.ts                # Конфигурация из переменных окружения
│       ├── Room.ts                  # Комната: router, транспорты, produce/consume
│       ├── Peer.ts                  # Модель участника
│       ├── socket.ts                # Оркестратор Socket.io (регистрирует модули socket/)
│       ├── socket/                  # Обработчики событий по доменам
│       │   ├── helpers.ts           # Общие типы, ack/err, rate-limiter
│       │   ├── room-registry.ts     # In-memory комнаты, grace-window, гидрация из БД
│       │   ├── media-handlers.ts    # WebRTC-сигналинг
│       │   ├── chat-handlers.ts     # Чат и маркеры прочтения
│       │   ├── whiteboard-handlers.ts # Совместная доска
│       │   ├── presentation-handlers.ts # Слайды (зарезервировано, клиент не использует)
│       │   ├── annotation-handlers.ts # Рисование поверх демонстрации экрана
│       │   └── lifecycle-handlers.ts # Реконнект, выход, disconnect
│       ├── db.ts                    # Персистентность: чат, доска, маркеры (PostgreSQL)
│       ├── uploads.ts               # Вложения чата на диске VPS
│       └── types.ts                 # TypeScript-типы payload'ов
│
└── electron/                        # Десктоп-оболочка (Electron, Windows)
    ├── main.js                      # Главный процесс: окно, IPC, overlay, разрешения
    ├── preload.js                   # Мост contextBridge (window.electronAPI)
    ├── electron.d.ts                # Типы проброшенного API
    └── icons/icon.png               # Иконка приложения
    # см. также: electron-builder.yml (сборка .exe),
    # components/desktop-titlebar.tsx, components/overlay-controls.tsx,
    # components/electron-patches.tsx, components/annotation-toolbar.tsx,
    # components/stream-annotation-canvas.tsx, hooks/use-overlay-click-through.ts,
    # lib/clipboard.ts
```

## Главные страницы

1. **Главная `/`** — маркетинговый лендинг: `SiteHeader`, `Hero`, `Features`,
   `QualityBanner`. Подробно — [`landing-page.md`](./landing-page.md).
2. **Комната `/room/[roomId]`** — экран самого звонка (видео, чат, доска,
   настройки). Подробно — [`room-page.md`](./room-page.md).
3. **Аккаунт** — вход/регистрация (`/sign-in`, `/sign-up`), сброс пароля и
   профиль с друзьями (`/profile`). Подробно — [`users/authorization.md`](./users/authorization.md)
   и [`users/friends.md`](./users/friends.md).

Связанные документы: навигация между страницами —
[`navigation-and-flows.md`](./navigation-and-flows.md); клиентская логика
звонка — [`client-logic.md`](./client-logic.md); сервер —
[`server.md`](./server.md).
