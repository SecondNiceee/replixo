# Авторизация пользователей

## Стек
- **Better Auth** — email + пароль, сессии в cookie; плагин `username`
  (`better-auth/plugins`) — вход/регистрация с уникальным ником
- **Drizzle ORM** + **pg** (node-postgres) — Postgres на VPS через `DATABASE_URL`
  (Better Auth подключается напрямую к пулу `pool` из `lib/db`)
- **drizzle-kit** (dev) — применение схемы (`pnpm db:push`)
- **Nodemailer** — письма для сброса пароля (см. `users/forgot-password.md`)

---

## Переменные окружения
- `DATABASE_URL` — строка подключения к Postgres
- `BETTER_AUTH_SECRET` — секрет для подписи сессий (обязателен в проде)
- `BETTER_AUTH_URL` — базовый URL приложения; при отсутствии вычисляется как
  fallback по цепочке `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL` →
  `V0_RUNTIME_URL` → `http://localhost:3000`
- `SMTP_*` — почта для сброса пароля (см. `users/forgot-password.md`)

---

## Схема БД (Better Auth требует точные имена колонок)

### `user`
| Колонка | Тип | Описание |
|---|---|---|
| id | text PK | Better Auth генерирует |
| username | text UNIQUE | Уникальный ник (нормализованный, lowercase у Better Auth); правила ниже |
| displayUsername | text | Ник как ввёл пользователь (регистр сохранён) — колонка плагина `username` |
| name | text NOT NULL | Отображаемое имя (при регистрации приравнивается к username) |
| email | text UNIQUE NOT NULL | Email |
| emailVerified | boolean | По умолчанию false |
| image | text | Аватар (опционально) |
| createdAt | timestamp | |
| updatedAt | timestamp | |

**Правила username** (одинаковы на сервере и клиенте): регэксп
`^[a-zA-Z0-9_]{2,20}$` — только латинские буквы, цифры и `_`, длина 2–20.
Задаётся плагином `username({ minUsernameLength: 2, maxUsernameLength: 20, usernameValidator })`
в `lib/auth.ts` и повторно проверяется в `PATCH /api/user/username`.

### `session`, `account`, `verification`
Стандартные таблицы Better Auth — не трогаем.

---

## Поля при регистрации
- `username` — уникальный никнейм (2–20 символов, латиница/цифры/`_`);
  при регистрации в Better Auth уходит и как `username`, и как `name`
- `email` — почта
- `password` — минимум 8 символов

## Валидация на фронте (`components/auth-form.tsx`)
- username (только на `/sign-up`): `.trim()`, не пусто, длина 2–20,
  регэксп `^[a-zA-Z0-9_]+$` — с явными сообщениями об ошибке
- email: стандартный `type="email"`
- password: `minLength={8}`

Форма (`AuthForm`) используется на обеих страницах через проп
`mode: 'sign-in' | 'sign-out'`; при `sign-in` поле username скрыто и рядом с
паролем показана ссылка «Забыли пароль?».

## Смена username (`PATCH /api/user/username`)
- Тело `{ username }`; проверяет сессию, валидирует регэксп (422 при ошибке),
  проверяет уникальность (409, если занят другим), обновляет `username` и `name`.
- UI — карандаш в `profile-header.tsx` (см. `users/friends.md`); после успеха
  страница перезагружается.

---

## Сессия
- Создаётся через `authClient.signIn.email()` / `authClient.signUp.email()`
- Получается на сервере через `auth.api.getSession({ headers })`
- Хранится в httpOnly cookie, `sameSite: none; secure` в dev (iframe preview)
- Срок жизни: 7 дней, обновляется раз в сутки

---

## Страницы
- `/sign-in` — форма входа (`AuthForm mode="sign-in"`)
- `/sign-up` — форма регистрации (`AuthForm mode="sign-up"`)
- `/forgot-password`, `/reset-password` — сброс пароля (см. `users/forgot-password.md`)
- `/profile` — профиль и друзья (см. `users/friends.md`)

После успешного входа/регистрации — `router.push('/')` + `router.refresh()`.

---

## Статус этапов
- Этап 1 — Аккаунты (email + пароль) — **реализовано**
- Этап 2 — Друзья (`users/friends.md`) — **реализовано**
- Этап 3 — Presence (онлайн-статус через socket.io) — не реализовано
- Этап 4 — Чат аккаунтов (conversations + messages) — не реализовано
  (в комнатах есть отдельный эфемерный чат, см. `room-page.md`)
