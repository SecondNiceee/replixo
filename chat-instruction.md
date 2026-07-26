# Личный чат между друзьями — план реализации

> Версия v1. Объём: **1:1 диалоги между принятыми друзьями**. Групповые чаты — не входят,
> но схема БД сразу заложена так, чтобы их можно было добавить без миграции-переписывания.

---

## 1. Что уже есть в проекте (и что переиспользуем)

| Что | Где | Как используем |
|---|---|---|
| Better Auth (email+password, username plugin) | `lib/auth.ts`, `lib/auth-client.ts` | Источник личности в чате: `session.user.id` |
| Друзья (`friendship`: pending/accepted) | `lib/db/schema.ts`, `app/api/friends/*` | Право на чат = есть `accepted` дружба |
| Socket.IO сервер (mediasoup) | `server/src/socket.ts` + `server/src/socket/*` | Добавляем **namespace `/dm`** |
| Постоянка через `pg` пул | `server/src/db.ts` | Тот же паттерн: параметризованные запросы, no-op без `DATABASE_URL` |
| Загрузка файлов (multer + `/uploads`) | `server/src/index.ts`, `server/src/uploads.ts` | Клонируем паттерн под `/dm-uploads` |
| Эфемерный чат комнаты (UI/UX эталон) | `app/room/[roomId]/room-chat.tsx`, `chat-message-list.tsx`, `chat-attachment-view.tsx`, `chat-helpers.ts` | Компоненты вложений/пузырей выносим в общие и переиспользуем |
| Звуки уведомлений | `lib/sounds.ts` | Звук нового ЛС |
| SWR | уже в зависимостях | Загрузка списка диалогов и истории |

**Ключевое отличие от чата комнаты:** там идентичность — эфемерный `peerId`, история удаляется
вместе с комнатой. Здесь идентичность — `user.id`, история **постоянна**.

---

## 2. Архитектура

```
Браузер (/chat)
  │
  ├── HTTP (Next.js route handlers)  ← «холодные» данные
  │     GET  /api/chat/conversations           список диалогов + непрочитанные
  │     POST /api/chat/conversations           создать/получить диалог с другом
  │     GET  /api/chat/conversations/:id/messages?before=&limit=   пагинация истории
  │     POST /api/chat/upload                  загрузка вложения (proxy → mediasoup серверу)
  │
  └── WebSocket (Socket.IO namespace /dm на mediasoup-сервере :3001)  ← «горячие» события
        dm:send / dm:message / dm:read / dm:typing / dm:presence
```

**Почему так:** первая отрисовка и пагинация — обычные server-side запросы (SEO/скорость/
простая авторизация через Better Auth). Realtime-доставка, галочки, «печатает», presence —
через уже работающий Socket.IO, без нового сервиса.

---

## 3. Схема БД (Drizzle)

Добавить в `lib/db/schema.ts`. Имена таблиц с префиксом `dm_`, чтобы не путать с
эфемерными `message` / `message_read` комнаты.

```ts
// --- Личные чаты -----------------------------------------------------------

// Диалог. type заложен на будущее: 'direct' (1:1) | 'group'.
export const conversation = pgTable('dm_conversation', {
  id: text('id').primaryKey(),
  type: text('type').notNull().default('direct'),
  // Денормализованный указатель на последнее сообщение — чтобы список диалогов
  // строился одним запросом без коррелированных подзапросов.
  lastMessageId: text('lastMessageId'),
  lastMessageAt: timestamp('lastMessageAt'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

// Участник диалога + его личное состояние прочитанности.
export const conversationMember = pgTable(
  'dm_conversation_member',
  {
    conversationId: text('conversationId').notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // До какого момента пользователь прочитал диалог.
    lastReadAt: timestamp('lastReadAt').notNull().defaultNow(),
    // Кэш непрочитанных: инкремент при доставке, сброс при dm:read.
    unreadCount: integer('unreadCount').notNull().default(0),
    joinedAt: timestamp('joinedAt').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('dm_member_userId_idx').on(t.userId),
  ],
)

export const directMessage = pgTable(
  'dm_message',
  {
    id: text('id').primaryKey(),           // ULID/uuid, генерирует клиент (оптимистичная копия)
    conversationId: text('conversationId').notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    senderId: text('senderId').notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    text: text('text').notNull().default(''),
    attachment: jsonb('attachment'),       // { url, name, size, mime } | null
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    editedAt: timestamp('editedAt'),
    deletedAt: timestamp('deletedAt'),     // soft delete («сообщение удалено»)
  },
  (t) => [
    index('dm_message_conv_createdAt_idx').on(t.conversationId, t.createdAt),
  ],
)
```

### Уникальность диалога 1:1
Пары не должны дублироваться. Решение: детерминированный `id` диалога —
`direct:<minUserId>:<maxUserId>` (сортировка id лексикографически). Тогда создание —
`INSERT ... ON CONFLICT DO NOTHING`, а поиск — по ключу, без сканирования.

### Индексы / производительность
- `dm_message_conv_createdAt_idx` — курсорная пагинация `WHERE conversationId = $1 AND createdAt < $2 ORDER BY createdAt DESC LIMIT 50`.
- `dm_member_userId_idx` — «мои диалоги».
- `lastMessageAt` в `dm_conversation` — сортировка списка диалогов.

Миграция: `pnpm db:generate` → проверить SQL → `pnpm db:push`.

---

## 4. Аутентификация сокета

Отдельная задача: mediasoup-сервер не знает про Better Auth.

**Решение:** сервер валидирует сессионный токен напрямую в Postgres (у него уже есть `pg` пул).

1. Клиент читает токен и передаёт в handshake:
   `io(SERVER_URL + '/dm', { auth: { token }, withCredentials: true })`.
   Токен получаем с сервера — новый route `GET /api/chat/socket-token`, который возвращает
   `session.token` для текущей сессии (не кладём httpOnly cookie в JS напрямую).
2. Middleware namespace `/dm` на сервере:
   ```sql
   SELECT s."userId", s."expiresAt", u."name", u."username", u."image"
   FROM "session" s JOIN "user" u ON u.id = s."userId"
   WHERE s."token" = $1 AND s."expiresAt" > now()
   ```
   Нет строки → `next(new Error('unauthorized'))`.
3. `socket.data.userId` — единственный источник авторства. **Никогда** не доверяем
   `senderId` из payload (в отличие от `peerId` в чате комнаты, где авторство проверяется
   по реестру комнаты).
4. Сокет сразу входит в комнату `user:<userId>` — так доставляем события на все устройства
   пользователя, даже когда чат закрыт (нужно для счётчиков и звука).

> Если `DATABASE_URL` не задан — namespace `/dm` не регистрируется, клиент получает
> «чат недоступен». Личный чат без постоянки бессмысленен (в отличие от чата комнаты).

---

## 5. Серверная часть (`server/src/`)

### Новые файлы
| Файл | Ответственность |
|---|---|
| `server/src/dm/namespace.ts` | Создание namespace `/dm`, auth middleware, регистрация хендлеров |
| `server/src/dm/handlers.ts` | `dm:send`, `dm:read`, `dm:typing` |
| `server/src/dm/presence.ts` | In-memory `Map<userId, Set<socketId>>`, broadcast `dm:presence` друзьям |
| `server/src/dm/db.ts` | Параметризованные запросы: `insertMessage`, `markRead`, `assertMembership`, `listMemberIds`, `bumpUnread` |
| `server/src/dm/uploads.ts` | Папки `<UPLOAD_DIR>/dm/<conversationId>/`, **без** TTL-сборщика |

### Точка подключения
В `server/src/socket.ts` после `setupSocketIO(...)` вызвать `setupDmNamespace(io)`.
Корневой namespace (комнаты) не трогаем — нулевой риск регрессии звонков.

### Контракт событий

**Клиент → сервер**

```ts
// dm:send
{ conversationId: string, id: string, text: string, attachment?: Attachment | null }
// → ack: { ok: true, id, createdAt } | { ok: false, error }

// dm:read
{ conversationId: string, ts: number }   // прочитано до момента ts

// dm:typing
{ conversationId: string, typing: boolean }
```

**Сервер → клиент**

```ts
// dm:message — новое сообщение (всем участникам, включая другие устройства автора)
{ conversationId, message: { id, senderId, senderName, text, attachment, createdAt } }

// dm:read — собеседник прочитал
{ conversationId, userId, ts }

// dm:typing
{ conversationId, userId, typing }       // авто-сброс на клиенте через 3 с

// dm:presence
{ userId, online: boolean, lastSeenAt?: number }

// dm:error
{ code: 'unauthorized' | 'not_member' | 'rate_limited' | 'not_friends', message }
```

### Валидация в `dm:send` (по порядку)
1. `socket.data.userId` существует (иначе — disconnect).
2. `conversationId` — строка ≤ 128, `id` — строка ≤ 64.
3. `text.trim().slice(0, 4000)`; пусто **и** без вложения → отбросить.
4. Вложение: `url` начинается строго с `/uploads/dm/<conversationId>/`, без `..`,
   `size` — финитное число ≥ 0, `name` ≤ 255, `mime` ≤ 128 (копия проверки из `chat-handlers.ts`).
5. **Membership:** `socket.data.userId` есть в `dm_conversation_member` этого диалога.
6. **Дружба:** для `direct` — есть `friendship` со `status='accepted'` между участниками.
   Дружбу удалили → писать нельзя (историю читать можно).
7. Rate limit: `createRateLimiter(10, 2000)` per socket (переиспользуем `socket/helpers.ts`).

### Порядок записи (важно для консистентности)
```
INSERT dm_message
  → UPDATE dm_conversation SET lastMessageId, lastMessageAt
  → UPDATE dm_conversation_member SET unreadCount = unreadCount + 1 WHERE userId <> sender
  → ack отправителю
  → io.of('/dm').to(участники: 'user:<id>').emit('dm:message', ...)
```
Всё в одной транзакции; `ON CONFLICT (id) DO NOTHING` делает повторную отправку
(ретрай после реконнекта) идемпотентной.

### `dm:read`
```
UPDATE dm_conversation_member SET lastReadAt = greatest(lastReadAt, $ts), unreadCount = 0
  WHERE conversationId = $1 AND userId = $2
  → emit('dm:read') остальным участникам
```

### Presence
- `connection` → добавить socketId в `Map`; если это первый сокет пользователя —
  разослать `dm:presence {online:true}` его друзьям (список друзей берём из БД, кэш 30 с).
- `disconnect` → удалить; если сокетов не осталось — `dm:presence {online:false, lastSeenAt}`.
- При входе клиент получает снапшот: `dm:presence:snapshot { onlineUserIds: string[] }`.
- In-memory — приемлемо: один процесс сервера. Для нескольких инстансов позже понадобится
  Redis-адаптер Socket.IO (отметить как будущий пункт).

### Вложения
- `POST /dm/:conversationId/upload` на express (multer, `MAX_FILE_SIZE` из `config.ts`).
- **Авторизация обязательна** (в отличие от `/rooms/:roomId/upload`): токен в
  `Authorization: Bearer` или cookie → та же проверка сессии + membership.
- Путь: `<UPLOAD_DIR>/dm/<conversationId>/<uuid><ext>`, имя — UUID, оригинальное имя в БД.
- Раздача через существующий `express.static('/uploads')` — `nosniff` + `attachment`
  для не-картинок уже настроены.
- **Не** попадает в `sweepOrphanUploads` (там TTL 48 ч убил бы историю) — явно
  исключить папку `dm/` в `server/src/uploads.ts`.

---

## 6. Next.js API (`app/api/chat/`)

Все хендлеры: `auth.api.getSession({ headers: await headers() })` → 401 без сессии.
Next 16: `params`, `headers`, `cookies` — **await**.

| Route | Метод | Логика |
|---|---|---|
| `conversations/route.ts` | GET | Диалоги пользователя: join `dm_conversation_member` → `dm_conversation` → `dm_message` (последнее) → `user` (собеседник). Сортировка по `lastMessageAt DESC`. Возвращает `unreadCount`. |
| `conversations/route.ts` | POST | `{ friendId }` → проверить `accepted` дружбу → детерминированный id → upsert диалога + двух members → `{ conversationId }` |
| `conversations/[id]/messages/route.ts` | GET | Проверка membership → курсорная пагинация `?before=<iso>&limit=50` → `{ messages, hasMore }` (по возрастанию для рендера) |
| `conversations/[id]/read/route.ts` | POST | Fallback для отметки прочитанного без сокета |
| `socket-token/route.ts` | GET | `{ token: session.session.token, userId }` для handshake |
| `upload/route.ts` | POST | Проксирует файл на mediasoup-сервер, добавляя токен (клиент не знает секретов) |

---

## 7. Клиентская часть

### Новые файлы
```
app/chat/page.tsx                     — server component: сессия, редирект на /sign-in
app/chat/chat-client.tsx              — 'use client', двухколоночный layout
app/chat/conversation-list.tsx        — список диалогов: аватар, имя, превью, время, badge, точка online
app/chat/conversation-view.tsx        — шапка + лента + composer
app/chat/dm-message-list.tsx          — лента, группировка по дате/автору, «догрузить ещё» вверх
app/chat/dm-composer.tsx              — textarea (Enter/Shift+Enter), скрепка, превью вложения
app/chat/typing-indicator.tsx         — «Иван печатает…»
app/chat/empty-state.tsx              — «Выберите диалог»
app/chat/types.ts                     — Conversation, DirectMessage, Attachment

hooks/dm/use-dm-socket.ts             — подключение к /dm, реконнект, listeners (refcount, одно на вкладку)
hooks/dm/use-conversations.ts         — SWR список + мутации от сокета. Единый источник правды:
                                        сам берёт сокет из use-dm-socket, отдаёт conversations,
                                        totalUnread, zeroUnreadLocally, refreshKeepingRead,
                                        startWithFriend, markReadFallback
hooks/dm/use-unread-total.ts          — тонкая обёртка над use-conversations для бейджей вне /chat
hooks/dm/use-conversation-messages.ts — история + пагинация + оптимистичная отправка
hooks/dm/use-typing.ts               — debounce отправки typing, авто-сброс приёма
stores/dm-store.ts                    — zustand: activeConversationId, unread map, online set, typing map
```

### Общие компоненты (рефакторинг, без изменения поведения комнаты)
Вынести из `app/room/[roomId]/` в `components/chat/`:
- `chat-attachment-view.tsx` → `components/chat/attachment-view.tsx` (превью картинок, файл-чип, размер)
- часть `chat-helpers.ts` (форматирование времени, `formatBytes`, группировка) → `lib/chat-format.ts`

В `app/room/[roomId]/*` заменить импорты на новые пути. Логику не менять.

### Оптимистичная отправка
1. Клиент генерирует `id` (тот же паттерн, что `hooks/mediasoup/use-chat.ts`).
2. Сразу добавляет сообщение со `status: 'sending'`.
3. `ack` → `status: 'sent'`; таймаут 10 с или `ok:false` → `status: 'failed'` + кнопка «Повторить»
   (повтор с тем же `id` — идемпотентно).
4. Входящий `dm:message` с уже известным `id` игнорируется (дедуп).

### Галочки
- `sent` — одна галочка (есть ack).
- `read` — две галочки: `собеседник.lastReadAt >= message.createdAt`
  (та же модель, что `messageRead` в комнате — маркер по времени, не по каждому сообщению).

### Отметка прочитанного
Шлём `dm:read` когда: диалог открыт **и** `document.visibilityState === 'visible'`
**и** лента доскроллена до низа. Дебаунс 500 мс.

### Непрочитанные и уведомления
- Badge в `conversation-list` и суммарный badge в шапке/на аватаре профиля.
- Звук через `lib/sounds.ts` (новая функция `playIncomingMessage`) — только если диалог
  не активен или вкладка скрыта. Уважает `soundVolume` из `roomSettings`.
- `document.title` = `(3) Replixo` при непрочитанных.

### Точки входа
- Пункт «Сообщения» в навигации → `/chat`.
- Кнопка «Написать» в `app/profile/friends-list.tsx` → `POST /api/chat/conversations` →
  `router.push('/chat?c=<id>')`.
- Точка online у каждого друга в списке (из `dm-store`).

### Дизайн
Строго существующие токены `app/globals.css` (`bg-background`, `bg-card`, `text-foreground`,
`border-border`, `bg-secondary`). Иконки — `lucide-react` (Send, Paperclip, Check, CheckCheck,
MessageSquare, Users), размер 16/20. Layout: flexbox. Мобильный вид — одна колонка:
список ↔ диалог по состоянию, без второй колонки до `md:`.

---

## 8. Порядок реализации

1. **Схема БД** — таблицы `dm_*` в `lib/db/schema.ts`, `db:generate` + `db:push`.
2. **Next API** — `conversations` (GET/POST), `messages` (GET), `socket-token`. Проверить curl'ом.
3. **UI на HTTP** — `/chat` со списком и историей, отправка через временный
   `POST /api/chat/messages`. Уже полезный чат без realtime.
4. **Socket namespace `/dm`** — auth middleware, `dm:send` + `dm:message`. Переключить
   отправку на сокет, временный POST удалить.
5. **Прочитано/галочки** — `dm:read`, `lastReadAt`, `unreadCount`, badge, звук.
6. **Typing + presence** — `dm:typing`, `dm:presence`, точки online.
7. **Вложения** — `/dm/:id/upload`, proxy-route, переиспользование `attachment-view`.
8. **Интеграция** — кнопка «Написать» в профиле, навигация, `document.title`.

Каждый шаг — рабочее состояние приложения; звонки/комнаты не ломаются ни на одном.

---

## 9. Безопасность (чеклист)

- [ ] Авторство **только** из `socket.data.userId` / серверной сессии. Никогда из payload.
- [ ] Membership-проверка на **каждом** событии и **каждом** route.
- [ ] Проверка `accepted` дружбы при отправке в `direct`.
- [ ] Все SQL — параметризованные (`$1, $2, ...`), как в `server/src/db.ts`.
- [ ] `attachment.url` — префикс `/uploads/dm/<conversationId>/`, запрет `..`.
- [ ] Загрузка файлов авторизована + лимит `MAX_FILE_SIZE` + `nosniff` + `Content-Disposition`.
- [ ] Rate limit: сокет 10 сообщений / 2 с; upload 20 файлов / мин на пользователя.
- [ ] Текст обрезается до 4000, имя файла до 255, mime до 128.
- [ ] Никакого рендера HTML из сообщений — только текст (React экранирует по умолчанию).
- [ ] CORS namespace `/dm` — тот же `CLIENT_ORIGIN`. Отдельно в `dm/namespace.ts` **не задаётся**:
      namespace наследует `cors` от корневого `io` в `server/src/socket.ts`, где origin уже равен
      `CLIENT_ORIGIN`. Дублировать настройку не нужно — достаточно убедиться, что корневой
      конфиг не открыт в `*`.

---

## 10. Тестирование

**Ручные сценарии (два браузера / инкогнито):**
1. A пишет B → B получает мгновенно, badge растёт, звук играет.
2. B открывает диалог → badge=0, у A появляются две галочки.
3. B печатает → A видит «печатает…»; через 3 с молчания индикатор гаснет.
4. B закрывает вкладку → у A точка гаснет, показывается «был(а) недавно».
5. A отправляет в оффлайне → `failed` + «Повторить»; после реконнекта повтор проходит, дубля нет.
6. Перезагрузка страницы → история на месте, порядок и галочки корректны.
7. Скролл вверх → догрузка старых сообщений без прыжка позиции.
8. Вложение: картинка → превью inline; pdf → чип со скачиванием.
9. Не-друг пытается писать в диалог → `not_friends`, ничего не сохранено.
10. Подделанный `attachment.url` на чужую папку → сообщение отброшено.
11. Два устройства одного пользователя → сообщение и статус прочитанного синхронны.
12. Звонок в комнате работает как раньше (регрессия чата комнаты).

**Проверить нагрузку:** 50 диалогов × 5000 сообщений — `EXPLAIN ANALYZE` на пагинации
должен показывать index scan, не seq scan.

---

## 11. Вне объёма v1 (задел на будущее)

- Групповые чаты (`type='group'` уже в с��еме; нужен UI участников и права).
- Редактирование/удаление (`editedAt`, `deletedAt` уже в схеме).
- Ответы (reply-to), реакции, пересылка.
- Поиск по истории (Postgres full-text по `dm_message.text`).
- Push-уведомления (Web Push / Electron tray).
- Кнопка «Позвонить» из диалога → создание комнаты и приглашение.
- Несколько инстансов сервера → Redis-адаптер Socket.IO для presence и broadcast.
