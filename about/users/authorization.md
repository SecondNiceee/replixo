# Авторизация пользователей

## Стек
- **Better Auth** — email + пароль, сессии в cookie (JWT)
- **Drizzle ORM** + **pg** (node-postgres) — Postgres на VPS через `DATABASE_URL`
- **drizzle-kit** (dev) — применение схемы (`pnpm db:push`)

---

## Переменные окружения
- `DATABASE_URL` — строка подключения к Postgres
- `BETTER_AUTH_SECRET` — секрет для подписи сессий (обязателен в проде)
- `BETTER_AUTH_URL` — базовый URL приложения (fallback на VERCEL_URL / V0_RUNTIME_URL)

---

## Схема БД (Better Auth требует точные имена колонок)

### `user`
| Колонка | Тип | Описание |
|---|---|---|
| id | text PK | Better Auth генерирует |
| username | text UNIQUE | Уникальное имя, макс. 20 символов, без пробелов по краям |
| name | text | Отображаемое имя (от Better Auth, пока совпадает с username) |
| email | text UNIQUE | Email |
| emailVerified | boolean | По умолчанию false |
| image | text | Аватар (опционально) |
| createdAt | timestamp | |
| updatedAt | timestamp | |

### `session`, `account`, `verification`
Стандартные таблицы Better Auth — не трогаем.

---

## Поля при регистрации
- `username` — уникальный никнейм (макс. 20 символов, обрезать пробелы)
- `email` — почта
- `password` — минимум 8 символов

## Валидация на фронте (auth-form.tsx)
- username: `.trim()`, макс. 20 символов
- email: стандартный `type="email"`
- password: `minLength={8}`

---

## Сессия
- Создаётся через `authClient.signIn.email()` / `authClient.signUp.email()`
- Получается на сервере через `auth.api.getSession({ headers })`
- Хранится в httpOnly cookie, `sameSite: none; secure` в dev (iframe preview)
- Срок жизни: 7 дней, обновляется раз в сутки

---

## Страницы
- `/sign-in` — форма входа
- `/sign-up` — форма регистрации
- Оба редиректят на `/` если уже залогинен

---

## Будущие этапы
- Этап 2 — Друзья (см. friends.md)
- Этап 3 — Presence (онлайн-статус через socket.io)
- Этап 4 — Чат (conversations + messages)
