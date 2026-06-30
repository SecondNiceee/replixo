# Nginx конфиг для Riplexo

## Структура

- Next.js фронтенд — запущен на `localhost:3000`
- Mediasoup Socket.io + роут скачивания (`/download/`) — запущены на `localhost:3001`

Nginx выступает reverse proxy: принимает HTTPS на 443, отдаёт на нужный порт.

---

## Конфиг (`/etc/nginx/sites-available/default`)

Это твой реальный конфиг с добавленным блоком `location /download/`.
Добавлены только строки между `# ── Скачивание ...` и закрывающей `}` этого блока.

```nginx
# ── TURN сервер (только для ACME challenge) ─────────────────────────
server {
    listen 80;
    server_name turn.replixo.ru;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}


server {
    server_name replixo.ru www.replixo.ru;

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

    # ── Скачивание установщика (большой .exe) ─────────────────────────
    # Роут /download/windows живёт на Express (порт 3001), а НЕ в Next.js.
    # Без этого блока запрос уходит в Next.js (location /) и возвращает 404.
    location /download/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Для большого файла: отключаем буферизацию и поднимаем таймауты,
        # чтобы Nginx не копил файл на диск и не рвал долгую отдачу.
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
        proxy_set_header   Connection 'upgrade';
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

## Что делать

```bash
sudo nano /etc/nginx/sites-available/default
# вставь блок location /download/ { ... } перед location /socket.io/

sudo nginx -t            # проверить конфиг
sudo systemctl reload nginx
```

---

## Важно

- Кнопка «Скачать» ведёт на `${NEXT_PUBLIC_MEDIASOUP_URL}/download/windows` = `https://replixo.ru/download/windows`. Блок `location /download/` обязателен — без него весь трафик кроме `/socket.io/` уходит в Next.js (порт 3000), где такого роута нет → 404.
- Положи установщик на сервер по пути из `WINDOWS_INSTALLER_PATH` (по умолчанию `server/downloads/Replixo-Setup.exe`) — иначе Express вернёт 404 с `{"error":"Установщик временно недоступен"}`.
- `NEXT_PUBLIC_MEDIASOUP_URL` в `.env.local` должен быть `https://replixo.ru`.
- Убедись, что в `server/.env` переменная `CLIENT_ORIGIN` указывает на `https://replixo.ru`.
- UDP-порты Mediasoup (по умолчанию `10000-10100`) должны быть открыты в firewall:
  ```bash
  sudo ufw allow 10000:10100/udp
  ```
