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

    # ── Скачивание установщика (большой .exe ~900 МБ) ─────────────────
    # Роут /download/windows живёт на Express (порт 3001), а НЕ в Next.js.
    # Без этого блока запрос уходит в Next.js (location /) и возвращает 404.
    location /download/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Для большого файла: отключаем буферизацию (иначе Nginx копит файл на
        # диск перед отдачей), поднимаем таймауты и пропускаем Range-запросы,
        # чтобы работала докачка.
        proxy_buffering    off;
        proxy_request_buffering off;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_max_temp_file_size 0;
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

- После настройки Nginx обнови `NEXT_PUBLIC_MEDIASOUP_URL` в `.env.local` на `https://replixo.ru` — Socket.io клиент будет коннектиться через `/socket.io/` на том же домене, без порта.
- Кнопка «Скачать» ведёт на `${NEXT_PUBLIC_MEDIASOUP_URL}/download/windows` = `https://replixo.ru/download/windows`. Чтобы это не упало в 404, в конфиге **обязателен** блок `location /download/` (см. выше) — он отдаёт запрос на Express (порт 3001). Без него весь трафик кроме `/socket.io/` уходит в Next.js, где такого роута нет.
- Положи установщик на сервер по пути из `WINDOWS_INSTALLER_PATH` (по умолчанию `server/downloads/Replixo-Setup.exe`) — иначе Express вернёт 404 с `{"error":"Установщик временно недоступен"}`.
- Убедись, что в `server/.env` переменная `CLIENT_ORIGIN` указывает на `https://replixo.ru`.
- UDP-порты Mediasoup (по умолчанию `10000-10100`) должны быть открыты в firewall:
  ```bash
  sudo ufw allow 10000:10100/udp
  sudo ufw allow 3001/tcp   # только если доступ к Mediasoup нужен напрямую
  ```
