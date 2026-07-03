# Система друзей

## Модель данных

### Таблица `friendship`

```sql
id          text        PK (cuid)
requesterId text        FK -> user.id CASCADE DELETE
addresseeId text        FK -> user.id CASCADE DELETE
status      text        NOT NULL  -- 'pending' | 'accepted' | 'declined'
createdAt   timestamp   DEFAULT now()
updatedAt   timestamp   DEFAULT now()
```

**Индексы:**
- `(requesterId, addresseeId)` — UNIQUE, нельзя дублировать заявку
- `addresseeId` — быстрый поиск входящих заявок

**Правила:**
- Один из пары всегда `requester`, второй — `addressee`
- Принятая дружба — одна строка со `status = 'accepted'`
- Друзья — все строки, где `userId IN (requesterId, addresseeId)` и `status = 'accepted'`

---

## Добавление по username

- Поиск пользователя ведётся по полю `username` (уникальное, макс. 20 символов, без пробелов по краям)
- Запрос `POST /api/friends/request` принимает `{ username }` и ищет юзера по нему

---

## API

| Метод | Путь | Тело / параметры | Описание |
|---|---|---|---|
| POST | `/api/friends/request` | `{ username }` | Отправить заявку по username |
| POST | `/api/friends/accept` | `{ friendshipId }` | Принять входящую заявку |
| POST | `/api/friends/decline` | `{ friendshipId }` | Отклонить входящую заявку |
| DELETE | `/api/friends/remove` | `{ friendshipId }` | Удалить из друзей |
| DELETE | `/api/friends/cancel` | `{ friendshipId }` | Отменить свою исходящую заявку (только `status = 'pending'`, только автор) |
| GET | `/api/friends` | — | Список принятых друзей |
| GET | `/api/friends/pending` | — | Входящие заявки (где текущий юзер — `addressee`) |
| GET | `/api/friends/sent` | — | Исходящие заявки текущего юзера (где он `requester`, `status = 'pending'`) |
| GET | `/api/users/search?username=...` | `?username=` | Точный поиск пользователя по username |

Все эндпоинты требуют аутентификации (`auth.api.getSession()`). `userId` берётся
из сессии — никогда из тела запроса. Поиск в `/api/users/search` — по **точному**
совпадению username (не подстрока), возвращает `{ id, username, name }`.

---

## UI

Страница `/profile` (`app/profile/page.tsx`) — серверная обёртка: читает сессию
(редирект на `/sign-in`, если гость) и рендерит клиентский `ProfileClient`.
Данные грузятся через **SWR** (`/api/friends`, `/api/friends/pending`,
`/api/friends/sent`). Профиль разбит на компоненты в `app/profile/`:

| Файл | Назначение |
|---|---|
| `page.tsx` | Серверная обёртка: сессия, редирект гостя, рендер `ProfileClient`. |
| `profile-client.tsx` | Оркестратор: SWR-запросы, переключатель вкладок, раскладка. |
| `profile-header.tsx` | Шапка: аватар (первая буква username) + username + email; карандаш для смены username через `PATCH /api/user/username`. |
| `friends-list.tsx` | Список принятых друзей; кнопка «Удалить» (`UserMinus`) по наведению. |
| `sent-requests.tsx` | Исходящие заявки; кнопка «Отменить» (`/api/friends/cancel`). |
| `pending-requests.tsx` | Входящие заявки; кнопки «Принять» / «Отклонить». |
| `add-friend-form.tsx` | Инлайн-форма ввода username → `POST /api/friends/request`. |
| `types.ts` | Типы (`User`, `Friend`, `PendingRequest`, `SentRequest`) и `fetcher`. |

### Раскладка `/profile`

- **Шапка** — `ProfileHeader` (аватар + username + email + смена username).
- **Левая колонка** — переключатель вкладок **«Друзья» / «Мои заявки»**
  (у каждой — бейдж со счётчиком):
  - вкладка «Друзья» → `FriendsList` (принятые друзья, удаление);
  - вкладка «Мои заявки» → `SentRequests` (исходящие заявки, отмена).
- **Правая колонка** — `AddFriendForm` (добавить друга по username) и под ней
  `PendingRequests` (входящие заявки; блок скрыт, если заявок нет).

Имена везде показываются как `username ?? name` (fallback на `name`, если
username не задан).

### Страница `/profile/[username]` (чужой профиль) — не реализовано

Зарезервировано на будущее: имя + аватар и статусы «нет связи / заявка
отправлена / входящая заявка / уже друзья». Роут пока не создан.

---

## Безопасность
- Все запросы проверяют сессию через `auth.api.getSession()`
- Нельзя добавить самого себя (`requesterId !== addresseeId`)
- Нельзя отправить дублирующую заявку (UNIQUE constraint)
- При принятии/отклонении проверяется, что `addresseeId === currentUserId`
- При удалении проверяется, что текущий юзер участник дружбы
