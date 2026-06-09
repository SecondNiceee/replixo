# Обзор продукта

## Что это

**Riplexo** — веб-приложение для видеосвязи, работающее целиком в браузере.
Слоган проекта: «Бессрочные видеозвонки в один клик». Ключевая идея —
пользователю не нужно ничего устанавливать и регистрироваться: он создаёт
комнату или входит в неё по короткому коду и сразу начинает звонок.

Заявленные на сайте свойства (см. блок преимуществ на главной):

- работает без VPN — прямое соединение между участниками;
- без ограничений по времени звонка;
- без установки приложений (всё в браузере);
- приватность: соединения шифруются, вход только по коду;
- подключение в один клик, без регистрации;
- демонстрация экрана в высоком качестве;
- видео в 1080p — бесплатно.

Метаданные сайта (`app/layout.tsx`): заголовок «Riplexo — Мгновенные
видеозвонки», язык интерфейса — русский (`lang="ru"`), тёмная тема по умолчанию.

## Технологический стек

**Фронтенд:**
- Next.js (App Router), React, TypeScript;
- Tailwind CSS v4 + shadcn-стиль компонентов (`components/ui`);
- иконки `lucide-react`;
- шрифты Geist Sans и Geist Mono (`next/font/google`);
- `socket.io-client` и `mediasoup-client` для видеосвязи через WebRTC;
- `@vercel/analytics` (только в production).

**Бэкенд (`server/`):**
- Node.js + Express (HTTP-сервер и health-check);
- `socket.io` (сигналинг);
- `mediasoup` (SFU-сервер, маршрутизация медиапотоков);
- порт по умолчанию `3001`.

## Карта файлов проекта

```
/
├── app/
│   ├── layout.tsx                   # Корневой layout, метаданные, шрифты
│   ├── globals.css                  # Дизайн-токены и темы (Tailwind v4)
│   ├── page.tsx                     # Главная страница (лендинг)
│   └── room/[roomId]/page.tsx       # Страница видеозвонка
│
├── components/
│   ├── logo.tsx                     # Логотип Riplexo
│   ├── site-header.tsx              # Хедер главной страницы
│   ├── hero.tsx                     # Hero-секция с кнопками действия
│   ├── features.tsx                 # Блок преимуществ (6 карточек)
│   ├── quality-banner.tsx           # Баннер «Видео в 1080p»
│   ├── start-call-dialog.tsx        # Диалог «Начать звонок»
│   ├── join-call-dialog.tsx         # Диалог «Войти по коду»
│   ├── edit-name-dialog.tsx         # Диалог «Изменить имя»
│   ├── enable-sound-banner.tsx      # Баннер «Включить звук»
│   ├── video-tile.tsx               # Тайл участника
│   └── ui/                          # Базовые UI-компоненты (button, dialog, input, dropdown-menu)
│
├── hooks/
│   ├── use-mediasoup.ts             # Вся логика WebRTC / mediasoup-client
│   ├── use-audio-devices.ts         # Список доступных микрофонов
│   └── use-speaking.ts              # Детектор «говорит сейчас»
│
├── lib/
│   ├── audio-unlock.ts              # Разблокировка автовоспроизведения звука
│   ├── display-name.ts              # Имя пользователя в localStorage
│   └── utils.ts                     # Утилита cn() для классов
│
└── server/                          # Mediasoup-бэкенд (Node.js)
    └── src/
        ├── index.ts                 # Точка входа: Express + HTTP + worker
        ├── config.ts                # Конфигурация из переменных окружения
        ├── Room.ts                  # Комната: router, транспорты, produce/consume
        ├── Peer.ts                  # Модель участника
        ├── socket.ts                # Все Socket.io события
        └── types.ts                 # TypeScript-типы payload'ов
```

## Две главные страницы

1. **Главная `/`** — маркетинговый лендинг. Состоит из четырёх блоков:
   `SiteHeader`, `Hero`, `Features`, `QualityBanner`. Подробно —
   [`landing-page.md`](./landing-page.md).
2. **Комната `/room/[roomId]`** — экран самого звонка. Подробно —
   [`room-page.md`](./room-page.md).

Связанные документы: навигация между страницами —
[`navigation-and-flows.md`](./navigation-and-flows.md); клиентская логика
звонка — [`client-logic.md`](./client-logic.md); сервер —
[`server.md`](./server.md).
