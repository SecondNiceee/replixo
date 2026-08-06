# Nginx конфиг для Riplexo

## Структура

- Next.js фронтенд — запущен на `localhost:3000`
- Mediasoup Socket.io — запущен на `localhost:3001`

Nginx выступает reverse proxy: принимает HTTPS на 443, отдаёт на нужный порт.

---

## Конфиг

```nginx
# ВАЖНО: Connection нельзя хардкодить в 'upgrade'.
# Раньше в location / стояло `proxy_set_header Connection 'upgrade';` для ВСЕХ
# запросов, включая обычные HTTP-запросы страниц (где $http_upgrade пустой).
# Node получал `Connection: upgrade` без `Upgrade`, из-за чего keep-alive
# соединение к upstream ломалось и streaming-ответ Next.js обрывался посередине:
# chunked-ответ приходил без терминирующего чанка (ERR_INCOMPLETE_CHUNKED_ENCODING).
# Браузер такой обрыв прощает (рисует частичный HTML), а Electron показывает
# "This page couldn't load / A server error occurred".
#
# Правильный способ — map: 'upgrade' только когда клиент реально просит upgrade,
# иначе 'close'. Блок map ставится на уровне http {} (вне server {}).
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name replixo.ru www.replixo.ru;

    # Редирект HTTP → HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name replixo.ru www.replixo.ru;

    ssl_certificate     /etc/letsencrypt/live/replixo.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/replixo.ru/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # ── Next.js фронтенд ──────────────────────────────────────────────
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Next.js стримит HTML и RSC-пейлоад. С буферизацией nginx копит ответ в
        # 4/8 КБ буферах и при переполнении уходит в temp-файл — на медленном
        # диске это даёт зависшие "полуответы". Отключаем буферизацию и даём
        # запас по таймауту, чтобы стрим доходил до конца.
        proxy_buffering    off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # ── Mediasoup / Socket.io (WebSocket) ─────────────────────────────
    location /socket.io/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

---

## Установка и запуск

```bash
# Установить Nginx
sudo apt install nginx -y

# Получить SSL-сертификат (Let's Encrypt)
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d replixo.ru -d www.replixo.ru

# Скопировать конфиг
sudo nano /etc/nginx/sites-available/replixo

# Вставить конфиг выше, сохранить, затем:
sudo ln -s /etc/nginx/sites-available/replixo /etc/nginx/sites-enabled/
sudo nginx -t        # проверить конфиг
sudo systemctl reload nginx
```

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
