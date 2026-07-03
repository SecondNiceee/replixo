# Восстановление пароля

Функция «Забыл пароль» реализована и доступна пользователям.

---

## Как это работает (для пользователя)

1. На странице `/sign-in`, под полем «Пароль», нажать **«Забыли пароль?»**
2. Ввести email своего аккаунта на странице `/forgot-password`
3. Нажать **«Отправить ссылку»** — на почту придёт письмо от Replixo
4. В письме нажать кнопку **«Сбросить пароль»** — откроется страница `/reset-password`
5. Ввести новый пароль (минимум 8 символов) и подтвердить его
6. После сохранения — автоматический переход на `/sign-in`

Ссылка в письме **действует 1 час**. После истечения нужно запросить новую.

---

## Технические детали

### Стек
- **Better Auth** — встроенный flow `requestPasswordReset` / `resetPassword`
- **Nodemailer** — отправка писем через любой SMTP-сервер

### Задействованные файлы
| Файл | Роль |
|------|------|
| `lib/auth.ts` | `sendResetPassword` — генерирует токен, отправляет письмо через Nodemailer |
| `app/forgot-password/page.tsx` | Форма ввода email; вызывает `authClient.requestPasswordReset()` |
| `app/reset-password/page.tsx` | Форма нового пароля; читает `?token=` из URL, вызывает `authClient.resetPassword()` |
| `components/auth-form.tsx` | Ссылка «Забыли пароль?» рядом с полем пароля на `/sign-in` |

### Переменные окружения
| Переменная | Обязательна | Описание |
|------------|-------------|----------|
| `SMTP_HOST` | **да** | Хост почтового сервера, напр. `smtp.gmail.com` |
| `SMTP_PORT` | нет | Порт. По умолчанию `587`. Используй `465` для SSL. |
| `SMTP_USER` | **да** | Логин на SMTP-сервере (обычно email) |
| `SMTP_PASS` | **да** | Пароль или app-пароль |
| `SMTP_FROM` | нет | Адрес отправителя в письме. По умолчанию = `SMTP_USER`. |

Если переменные не заданы — письмо не отправляется, в серверных логах будет ошибка `[auth] SMTP env vars not set`.

---

## Настройка SMTP

### Gmail

1. Включить двухфакторную аутентификацию на аккаунте Google.
2. Зайти в **Google Account → Security → App Passwords**.
3. Создать пароль для приложения → скопировать (16 символов без пробелов).
4. Заполнить переменные:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=ты@gmail.com
   SMTP_PASS=xxxx xxxx xxxx xxxx
   SMTP_FROM=noreply@replixo.com   # опционально
   ```

### Yandex

```
SMTP_HOST=smtp.yandex.ru
SMTP_PORT=465
SMTP_USER=ты@yandex.ru
SMTP_PASS=<пароль приложения из Яндекс ID>
```

Включить «Пароли приложений» в настройках Яндекс ID → Безопасность.

### Mail.ru

```
SMTP_HOST=smtp.mail.ru
SMTP_PORT=465
SMTP_USER=ты@mail.ru
SMTP_PASS=<пароль приложения>
```

Включить «Внешние клиенты» в настройках почты Mail.ru, создать пароль приложения.

---

## Если письмо не приходит

1. Проверить папку **«Спам»**
2. Убедиться, что все четыре SMTP-переменные заданы в Vercel (Settings → Vars)
3. Проверить логи в Vercel Dashboard — там будет конкретная ошибка от Nodemailer
4. Для Gmail убедиться, что используется **app-пароль**, а не основной пароль аккаунта

---

## Ручной сброс (для администратора)

Если SMTP-сервер недоступен, администратор может задать пароль вручную. Важно:
Better Auth хранит пароль в `account.password` как **scrypt**-хэш (формат
`salt:key`), а не bcrypt. Поэтому нельзя вставить в БД bcrypt-хэш — он не
пройдёт проверку при входе. Совместимый хэш нужно сгенерировать через сам
Better Auth.

Генерация scrypt-хэша и обновление БД (Node.js, из корня проекта):
```js
import { auth } from '@/lib/auth'

const ctx = await auth.$context
const hash = await ctx.password.hash('ВременныйПароль123')
console.log(hash) // salt:key — этот формат понимает Better Auth
```

```sql
-- 1. Найти userId
SELECT id FROM "user" WHERE email = 'user@example.com';

-- 2. Записать сгенерированный scrypt-хэш
UPDATE account
SET password = '<scrypt-хэш из скрипта выше>'
WHERE "userId" = '<id>' AND "providerId" = 'credential';
```

Проще и надёжнее — воспользоваться встроенным серверным API Better Auth
(`ctx.internalAdapter` / `auth.api`), не трогая таблицы напрямую.

---

## Смена username (не пароля)

Если нужно сменить **имя**, а не пароль — открыть `/profile` и нажать иконку карандаша рядом с именем.
