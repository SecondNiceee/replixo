# Nginx конфиг для Replixo (обычный сервер, без балансера)

## Структура

- Next.js фронтенд — запущен на `localhost:3000`
- Mediasoup Socket.io / загрузки / скачивания — запущены на `localhost:3001`

Nginx выступает reverse proxy: принимает HTTPS на 443, отдаёт на нужный порт.

Файл на сервере: `/etc/nginx/sites-available/default`
(`/etc/nginx/sites-enabled/default` — ссылка на него).

Ставится в два шага, потому что nginx не запустится, если в конфиге указан
сертификат, которого ещё нет:

1. **Шаг 1** — временный конфиг только на 80-м порту, выпускаем сертификат.
2. **Шаг 2** — полный конфиг с HTTPS.

Если сертификат уже выпущен (`ls /etc/letsencrypt/live/replixo.ru/` показывает
`fullchain.pem` и `privkey.pem`), сразу переходите к шагу 2.

---

## Шаг 1. Временный конфиг и выпуск сертификата

Перед этим DNS `replixo.ru` и `www.replixo.ru` должны указывать на IP этого
сервера, а порт 80 должен быть открыт (`sudo ufw allow 80/tcp`).

```nginx
server {
    listen 80 default_server;
    server_name replixo.ru www.replixo.ru;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        return 404;
    }
}
```

```bash
sudo nano /etc/nginx/sites-available/default
sudo mkdir -p /var/www/html
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot
sudo certbot certonly --webroot -w /var/www/html -d replixo.ru -d www.replixo.ru
```

Если `www.replixo.ru` пока не ведёт на этот сервер, выпустите только на
`-d replixo.ru`, а потом повторите команду с обоими именами.

После успеха должны появиться файлы:

```bash
sudo ls /etc/letsencrypt/live/replixo.ru/
```

---

## Шаг 2. Полный конфиг

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80 default_server;
    server_name replixo.ru www.replixo.ru;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        return 301 https://replixo.ru$request_uri;
    }
}

server {
    listen 80;
    server_name turn.replixo.ru;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        return 404;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name www.replixo.ru;

    ssl_certificate /etc/letsencrypt/live/replixo.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/replixo.ru/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    return 301 https://replixo.ru$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name replixo.ru;

    ssl_certificate /etc/letsencrypt/live/replixo.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/replixo.ru/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    location / {
        client_max_body_size 30m;
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering         off;
        proxy_request_buffering off;
        proxy_read_timeout      300s;
        proxy_send_timeout      300s;
    }

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

```bash
sudo nano /etc/nginx/sites-available/default
sudo ufw allow 443/tcp
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Последняя команда проверяет автопродление: оно идёт через тот же
`/.well-known/acme-challenge/` на 80-м порту, поэтому этот блок не удаляйте.

---

## Сертификат для `turn.replixo.ru` (coturn)

Нужна A-запись `turn` на IP этого сервера. Сертификат выпускается через тот же
nginx на 80-м порту (блок `server_name turn.replixo.ru` из шага 2):

```bash
sudo certbot certonly --webroot -w /var/www/html -d turn.replixo.ru
sudo chmod -R o+rx /etc/letsencrypt/live /etc/letsencrypt/archive
sudo systemctl restart coturn
```

Чтобы coturn подхватывал продлённый сертификат автоматически:

```bash
echo 'systemctl restart coturn' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
```

---

## Пояснения к конфигу

### Почему `map $http_upgrade $connection_upgrade`

Раньше в `location /` стояло `proxy_set_header Connection 'upgrade';` хардкодом.
Для обычных запросов Node получал `Connection: upgrade` без заголовка `Upgrade`,
keep-alive соединение ломалось, и streaming-ответ Next.js обрывался посередине.
В браузере это выглядело как «иногда не гидратируется», в Electron — как
`ERR_INCOMPLETE_CHUNKED_ENCODING` и заглушка «This page couldn't load».
`map` ставит `upgrade` только когда клиент реально просит upgrade, иначе `close`.

`map` обязан быть на уровне `http {}`. Файлы из `sites-enabled/` подключаются
внутрь `http {}`, поэтому верх этого файла подходит.

### Почему без gzip в nginx

Next.js (`next start`) сам сжимает ответы. Если включить `gzip on` в `location /`,
nginx начнёт буферизовать стрим и снова появится риск «полуответов».

### Про `http2` и файлы certbot

Конфиг использует `http2 on;` (nginx 1.25.1+). На более старом nginx уберите
`http2 on;` и пишите `listen 443 ssl http2;`. Версию смотрите командой `nginx -v`.

Файлы `/etc/letsencrypt/options-ssl-nginx.conf` и `ssl-dhparams.pem` создаёт
только плагин `certbot --nginx`, поэтому настройки TLS прописаны прямо в конфиге.

---

## Частые ошибки `nginx -t`

- `cannot load certificate ".../fullchain.pem"` — сертификата ещё нет. Поставьте
  конфиг из шага 1 и выпустите сертификат.
- `open() "/etc/letsencrypt/options-ssl-nginx.conf" failed` — в конфиге остались
  строки `include ...options-ssl-nginx.conf` / `ssl_dhparam`. Удалите их.
- `the "listen ... http2" directive is deprecated` — предупреждение, не ошибка.
  Замените `listen 443 ssl http2;` на `listen 443 ssl;` + `http2 on;`.

---

## Проверка

Стрим не рвётся — все 20 значений должны быть одинаковыми:

```bash
for i in $(seq 20); do curl -s -o /dev/null -w "%{size_download}\n" https://replixo.ru/; done
```

Редиректы — оба должны вернуть `301` на `https://replixo.ru/`:

```bash
curl -sI https://www.replixo.ru/ | grep -i -E "^(HTTP|location)"
curl -sI http://replixo.ru/      | grep -i -E "^(HTTP|location)"
```

HTTP/2 — должно быть `HTTP/2 200`:

```bash
curl -sI --http2 https://replixo.ru/ | head -1
```

---

## Важно

- **Socket.io URL резолвится автоматически.** Клиент (`hooks/mediasoup/types.ts`,
  функция `resolveServerUrl`) в проде коннектится на тот же origin, что и
  приложение (`https://replixo.ru`), а nginx проксирует `/socket.io/` на mediasoup.
- Если хочешь задать URL сокет-сервера явно, выстави
  `NEXT_PUBLIC_MEDIASOUP_URL=https://replixo.ru`. Это переменная `NEXT_PUBLIC_*` —
  она вшивается в бандл на этапе `next build`, после изменения нужно пересобрать
  фронтенд (`pnpm build`) и перезапустить.
- Единственное каноничное имя переменной — `NEXT_PUBLIC_MEDIASOUP_URL`. Старое
  `NEXT_PUBLIC_MEDIASOUP_SERVER_URL` удалено.
- В `server/.env` переменная `CLIENT_ORIGIN` должна указывать на `https://replixo.ru`.
- UDP-порты Mediasoup (по умолчанию `10000-10100`) должны быть открыты в firewall:
  ```bash
  sudo ufw allow 10000:10100/udp
  ```
