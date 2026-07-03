# Nginx конфиг для Riplexo

## Структура

- Next.js фронтенд — запущен на `localhost:3000`
- Mediasoup Socket.io — запущен на `localhost:3001`

Nginx выступает reverse proxy: принимает HTTPS на 443, отдаёт на нужный порт.

---

## Конфиг

```nginx
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
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # ── Mediasoup / Socket.io (WebSocket) ─────────────────────────────
    location /socket.io/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
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
- Легаси-имя `NEXT_PUBLIC_MEDIASOUP_SERVER_URL` всё ещё поддерживается как fallback,
  но новое каноничное имя — `NEXT_PUBLIC_MEDIASOUP_URL`.
- Убедись, что в `server/.env` переменная `CLIENT_ORIGIN` указывает на `https://replixo.ru`.
- UDP-порты Mediasoup (по умолчанию `10000-10100`) должны быть открыты в firewall:
  ```bash
  sudo ufw allow 10000:10100/udp
  sudo ufw allow 3001/tcp   # только если доступ к Mediasoup нужен напрямую
  ```
