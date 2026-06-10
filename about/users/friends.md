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

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/friends/request` | Отправить заявку по username |
| POST | `/api/friends/accept` | Принять заявку (по friendshipId) |
| POST | `/api/friends/decline` | Отклонить заявку (по friendshipId) |
| DELETE | `/api/friends/remove` | Удалить из друзей (по friendshipId) |
| GET | `/api/friends` | Список принятых друзей |
| GET | `/api/friends/pending` | Входящие заявки |
| GET | `/api/users/search?username=...` | Поиск юзера по username |

Все эндпоинты требуют аутентификации. `userId` берётся из сессии — никогда из тела запроса.

---

## UI

### Страница `/profile` (собственный профиль)
- Аватар (первая буква username) + username + email
- Левая панель — список друзей (`status = 'accepted'`)
- Входящие заявки вверху с кнопками "Принять" / "Отклонить"
- Кнопка "Добавить друга" — инлайн-форма ввода username

### Страница `/profile/[username]` (чужой профиль) — будущий этап
- Имя + аватар
- Статусы: нет связи / заявка отправлена / входящая заявка / уже друзья

---

## Безопасность
- Все запросы проверяют сессию через `auth.api.getSession()`
- Нельзя добавить самого себя (`requesterId !== addresseeId`)
- Нельзя отправить дублирующую заявку (UNIQUE constraint)
- При принятии/отклонении проверяется, что `addresseeId === currentUserId`
- При удалении проверяется, что текущий юзер участник дружбы
