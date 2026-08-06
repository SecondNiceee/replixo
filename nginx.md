# Nginx конфиг для Replixo

## Структура

- Next.js фронтенд — запущен на `localhost:3000`
- Mediasoup Socket.io / загрузки / скачивания — запущены на `localhost:3001`

Nginx выступает reverse proxy: принимает HTTPS на 443, отдаёт на нужный порт.

Файл на сервере: `/etc/nginx/sites-available/default`

---

## Баг, который здесь был исправлен

В `location /` стояло `proxy_set_header Connection 'upgrade';` — хардкодом, для
**всех** запросов. Для обычных запросов страниц `$http_upgrade` пустой, поэтому
Node получал `Connection: upgrade` **без** заголовка `Upgrade`. Это невалидная
комбинация: keep-alive соединение к upstream ломается, и streaming-ответ Next.js
обрывается посередине — chunked-ответ приходит без терминирующего чанка.

Симптомы были асимметричные и потому запутывающие:

- **В браузере** сайт «работает»: Chrome прощает обрыв и рисует полученный
  частичный HTML (страница при этом может не гидратироваться).
- **В Electron** главный фрейм считается проваленным
  (`ERR_INCOMPLETE_CHUNKED_ENCODING`) и Chromium показывает свою заглушку
  **«This page couldn't load — A server error occurred»**.
- Ломалось не всегда, а примерно каждый третий запрос — отсюда «то работает, то нет».

Правильный способ — `map`: `upgrade` только когда клиент реально просит upgrade,
иначе `close`.

---

## Конфиг

```nginx
# Блок map обязан быть на уровне http {}, а не внутри server {}.
# sites-enabled/* подключается внутрь http {}, поэтому верх этого файла подходит.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# ── TURN сервер (только для ACME challenge) ─────────────────────────
server {
    listen 80;
    server_name turn.replixo.ru;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        # Редирект на HTTPS убран, так как SSL временно отключен
        return 404;
    }
}

server {
    server_name replixo.ru www.replixo.ru;

    # ── Next.js фронтенд ──────────────────────────────────────────────
    location / {
        client_max_body_size 30m;
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        # Было 'upgrade' хардкодом — это и рвало стрим Next.js.
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Next.js стримит HTML и RSC-пейлоад. С буферизацией nginx копит ответ в
        # 4/8 КБ буферах и при переполнении уходит в temp-файл — это добавляет
        # свои "полуответы" на медленном диске. Отдаём стрим как есть.
        proxy_buffering         off;
        proxy_request_buffering off;
        proxy_read_timeout      300s;
        proxy_send_timeout      300s;
    }

    # Загрузка файлов и room HTTP endpoints
    location /rooms/ {
        client_max_body_size 30m;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 300;
        proxy_send_timeout 300;
    }

    # Выдача загруженных вложений
    location /uploads/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /download/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering          off;
        proxy_request_buffering  off;
        proxy_read_timeout       86400;
        proxy_send_timeout       86400;
        proxy_max_temp_file_size 0;
    }

    # ── Mediasoup / Socket.io (WebSocket) ─────────────────────────────
    location /socket.io/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        # Здесь тоже был хардкод. Socket.io начинает с HTTP-polling
        # (GET /socket.io/?transport=polling) без Upgrade, и только потом
        # переключается на WebSocket — polling-запросы ломались так же.
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/replixo.ru/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/replixo.ru/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = www.replixo.ru) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    if ($host = replixo.ru) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name replixo.ru www.replixo.ru;
    return 404; # managed by Certbot
}
```

---

## Применение

```bash
sudo nano /etc/nginx/sites-available/default
# вставить конфиг выше, сохранить

sudo nginx -t                  # проверить синтаксис
sudo systemctl reload nginx
```

Проверка, что стрим больше не рвётся — все 20 значений должны быть одинаковыми:

```bash
for i in $(seq 20); do curl -s -o /dev/null -w "%{size_download}\n" https://replixo.ru/; done
```

Если хотя бы одно значение меньше остальных — стрим всё ещё обрывается.

---

## Важно

- **Socket.io URL резолвится автоматически.** Клиент (`hooks/mediasoup/types.ts`,
  функция `resolveServerUrl`) в проде по умолчанию коннектится на **тот же origin**,
  что и приложение (`https://replixo.ru`), а nginx проксирует `/socket.io/` на
  mediasoup. Поэтому отдельная переменная в проде **не обязательна** — достаточно,
  чтобы nginx проксировал `/socket.io/` (см. конфиг выше).
- Если хочешь задать URL сокет-сервера явно (например, mediasoup на другом домене),
  выстави `NEXT_PUBLIC_MEDIASOUP_URL=https://replixo.ru`.
  ⚠️ Это переменная `NEXT_PUBLIC_*` — она **вшивается в бандл на этапе `next build`**.
  После её изменения нужно **пересобрать фронтенд** (`pnpm build`) и перезапустить,
  иначе в браузере останется старое значение (частая причина `ws://localhost:3001`
  на проде).
- Единственное каноничное имя переменной для URL сокет/mediasoup сервера —
  `NEXT_PUBLIC_MEDIASOUP_URL`. Старое `NEXT_PUBLIC_MEDIASOUP_SERVER_URL` из кода
  удалено — если оно осталось в `.env`, его можно удалить.
- Убедись, что в `server/.env` переменная `CLIENT_ORIGIN` указывает на `https://replixo.ru`.
- UDP-порты Mediasoup (по умолчанию `10000-10100`) должны быть открыты в firewall:
  ```bash
  sudo ufw allow 10000:10100/udp
  sudo ufw allow 3001/tcp   # только если доступ к Mediasoup нужен напрямую
  ```
