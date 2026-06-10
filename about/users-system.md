# Система друзей — план реализации

## Модель данных

### Таблица `friendship`

```sql
id          text        PK
requesterId text        FK -> user.id CASCADE DELETE
addresseeId text        FK -> user.id CASCADE DELETE
status      text        NOT NULL  -- 'pending' | 'accepted' | 'declined'
createdAt   timestamp   DEFAULT now()
updatedAt   timestamp   DEFAULT now()
```

**Индексы:**
- `(requesterId, addresseeId)` — UNIQUE, чтобы нельзя было дублировать заявку
- `addresseeId` — для быстрого поиска входящих заявок

**Правила:**
- Один из пары всегда `requester`, второй — `addressee`
- Принятая дружба — одна строка со `status = 'accepted'`
- Друзья — это все строки, где `userId IN (requesterId, addresseeId)` и `status = 'accepted'`

---

## API (Server Actions / Route Handlers)

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/friends/request` | Отправить заявку в друзья (по userId) |
| POST | `/api/friends/accept` | Принять заявку |
| POST | `/api/friends/decline` | Отклонить заявку |
| DELETE | `/api/friends/remove` | Удалить из друзей |
| GET | `/api/friends` | Список принятых друзей текущего юзера |
| GET | `/api/friends/pending` | Входящие заявки |

Все эндпоинты требуют аутентификации. `userId` берётся из сессии — никогда из тела запроса.

---

## Поиск пользователей

- GET `/api/users/search?q=имя` — поиск по `name` (ILIKE) и `email`.
- Возвращает `id`, `name`, `email` (без `passwordHash`).
- Используется на странице профиля для кнопки "Добавить в друзья".

---

## UI

### Страница `/profile` (собственный профиль)
- Аватар (первая буква имени) + имя + email
- Список друзей слева (`status = 'accepted'`)
- Входящие заявки (badge с числом) — принять / отклонить
- Кнопка "Добавить друга" → модалка с поиском по имени/email

### Страница `/profile/[userId]` (чужой профиль)
- Имя + аватар
- Статус отношений:
  - Нет связи → кнопка "Добавить в друзья"
  - Заявка отправлена → "Заявка отправлена" (disabled)
  - Входящая заявка → "Принять" / "Отклонить"
  - Уже друзья → "Удалить из друзей"

---

## Этапы реализации

### Этап 2а — Схема и миграция
1. Добавить таблицу `friendship` в `lib/db/schema.ts`
2. Запустить `pnpm db:push`

### Этап 2б — API
1. Создать route handlers в `app/api/friends/`
2. Создать `app/api/users/search/route.ts`

### Этап 2в — UI
1. Обновить `/profile` — список друзей из БД, входящие заявки
2. Создать `/profile/[userId]` — чужой профиль с кнопкой добавить
3. Модалка поиска пользователей

### Этап 2г — Presence (позже)
- Через существующий socket.io сервер передавать `userId` при коннекте
- Хранить `onlineUsers: Set<string>` в памяти сервера
- На странице профиля показывать зелёную точку рядом с именем друга

---

## Безопасность
- Все запросы проверяют сессию через `auth.api.getSession()`
- `userId` никогда не принимается из тела запроса — только из сессии
- Нельзя добавить самого себя в друзья (проверка `requesterId !== addresseeId`)
- Нельзя отправить дублирующую заявку (UNIQUE constraint)
