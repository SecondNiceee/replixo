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
    server_name riplexo.ru www.riplexo.ru;

    # Редирект HTTP → HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name riplexo.ru www.riplexo.ru;

    ssl_certificate     /etc/letsencrypt/live/riplexo.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/riplexo.ru/privkey.pem;
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
sudo certbot --nginx -d riplexo.ru -d www.riplexo.ru

# Скопировать конфиг
sudo nano /etc/nginx/sites-available/riplexo

# Вставить конфиг выше, сохранить, затем:
sudo ln -s /etc/nginx/sites-available/riplexo /etc/nginx/sites-enabled/
sudo nginx -t        # проверить конфиг
sudo systemctl reload nginx
```

---

## Важно

- После настройки Nginx обнови `NEXT_PUBLIC_MEDIASOUP_URL` в `.env.local` на `https://riplexo.ru` — Socket.io клиент будет коннектиться через `/socket.io/` на том же домене, без порта.
- Убедись, что в `server/.env` переменная `CLIENT_ORIGIN` указывает на `https://riplexo.ru`.
- UDP-порты Mediasoup (по умолчанию `10000-10100`) должны быть открыты в firewall:
  ```bash
  sudo ufw allow 10000:10100/udp
  sudo ufw allow 3001/tcp   # только если доступ к Mediasoup нужен напрямую
  ```
