# Этап 1: Аккаунты (Postgres + Auth.js, email/пароль)

## Цель
Добавить регистрацию и вход по email + паролю поверх существующего Next.js 16
приложения. Каждый пользователь имеет имя (displayName). Сессия хранится в cookie
(JWT). Фундамент рассчитан на будущие этапы (друзья, presence, чат), но сейчас
реализуем только аутентификацию.

## Стек
- **Auth.js v5** (`next-auth@beta`) — Credentials provider + JWT-сессии.
- **Drizzle ORM** + **postgres.js** (`postgres`) — обычный Postgres на VPS через `DATABASE_URL`.
- **bcryptjs** — хеширование паролей.
- **drizzle-kit** (dev) — генерация и применение миграций.

> Credentials provider в Auth.js работает только со стратегией `jwt`, поэтому
> адаптер БД для сессий не нужен. Таблицу `users` ведём сами — это проще и
> расширяемо под будущие таблицы (friendships, messages).

## Переменные окружения
- `DATABASE_URL` — строка подключения к Postgres (у пользователя уже есть).
- `AUTH_SECRET` — секрет для подписи JWT (сгенерировать; запросить у пользователя
  через форму env vars при реализации).

## Новые файлы

### БД
- `lib/db/schema.ts` — таблица `users`:
  - `id` (uuid, pk, default gen_random_uuid)
  - `email` (text, unique, not null, нормализуем в lowercase)
  - `name` (text, not null) — отображаемое имя
  - `passwordHash` (text, not null)
  - `createdAt` (timestamp, default now)
- `lib/db/index.ts` — инициализация drizzle-клиента поверх `postgres(DATABASE_URL)`.
- `drizzle.config.ts` — конфиг drizzle-kit (schema path, out=`drizzle/`, dialect postgresql).

### Auth
- `lib/auth.ts` — конфиг NextAuth:
  - `providers: [Credentials({...})]` с `authorize()`: ищет юзера по email,
    сверяет пароль через `bcrypt.compare`, возвращает `{ id, email, name }`.
  - `session.strategy = "jwt"`.
  - колбэки `jwt` и `session`: прокидывают `id` и `name` в `session.user`.
  - страница входа `pages.signIn = "/login"`.
  - экспортирует `handlers`, `auth`, `signIn`, `signOut`.
- `app/api/auth/[...nextauth]/route.ts` — реэкспорт `handlers` (GET, POST).
- `app/api/register/route.ts` — POST: валидирует email/name/password, проверяет
  уникальность email, хеширует пароль, создаёт юзера. Возвращает 201 либо 409/400.

### Страницы (client components)
- `app/login/page.tsx` — форма входа (email, пароль). Вызывает
  `signIn("credentials", { redirect:false })`, при успехе → `router.push("/")`.
  Ссылка на регистрацию. Использует существующие `Input`/`Button` и стиль из диалогов.
- `app/register/page.tsx` — форма регистрации (имя, email, пароль). POST на
  `/api/register`, затем автоматический `signIn`. Ссылка на вход.

### Типы
- `types/next-auth.d.ts` — расширение `Session`/`User`/`JWT`: добавить `id` и `name`.

## Изменяемые файлы

- `app/layout.tsx` — обернуть `children` в `<SessionProvider>` (из `next-auth/react`)
  через тонкий клиентский провайдер `components/session-provider.tsx`.
- `components/site-header.tsx` — кнопка «Войти» становится умной:
  - не залогинен → ссылка на `/login`;
  - залогинен → имя пользователя + кнопка «Выйти» (`signOut`).
  Использовать `useSession()`.
- `components/start-call-dialog.tsx` и `components/join-call-dialog.tsx` —
  предзаполнять поле имени из `session.user.name`, если пользователь залогинен
  (оставляя fallback на `getDisplayName()` для гостей). Существующая логика
  комнат и гостевой вход НЕ ломаются.

## Что НЕ трогаем на этапе 1
- `lib/display-name.ts` остаётся как fallback для гостей.
- mediasoup-сервер, логика комнат, video-tile — без изменений.
- Друзья, presence, чат — следующие этапы (фундамент таблиц это позволит).

## Зависимости для установки
```
pnpm add next-auth@beta drizzle-orm postgres bcryptjs
pnpm add -D drizzle-kit @types/bcryptjs
```

## Скрипты в package.json
- `"db:generate": "drizzle-kit generate"`
- `"db:migrate": "drizzle-kit migrate"`
- `"db:push": "drizzle-kit push"`

## Проверка (типовые сценарии)
1. Регистрация нового пользователя → запись в `users`, авто-вход, редирект на `/`.
2. Повторная регистрация с тем же email → 409, понятная ошибка в форме.
3. Вход с верным/неверным паролем.
4. В хедере видно имя залогиненного, кнопка «Выйти» работает.
5. В диалоге «Начать конференцию» имя предзаполнено из аккаунта.
6. Гость (без входа) по-прежнему может зайти в комнату по коду.

## Замечания по безопасности
- Пароль хешируется bcrypt (10 раундов), в БД только hash.
- Email нормализуется в lowercase и помечен unique на уровне БД.
- `AUTH_SECRET` обязателен в проде.
- Миграции применяет пользователь на VPS командой `pnpm db:migrate` (или `db:push`).

## Будущие этапы (фундамент закладываем сейчас)
- **Этап 2 — Друзья:** таблица `friendships`, REST-эндпоинты (add/accept/remove),
  панель друзей слева как в Discord.
- **Этап 3 — Presence:** статус онлайн/оффлайн через существующий socket.io-сервер.
- **Этап 4 — Чат:** таблицы `conversations`/`messages`, реалтайм через socket.io,
  история через REST. socket.io проверяет сессию Auth.js по `AUTH_SECRET`.
