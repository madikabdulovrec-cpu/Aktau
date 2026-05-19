# Backup Firestore — настройка и восстановление

Защита от потерь данных (как с карточкой Лоры Нарикбаевой 2026-05-19).
Делаем **два уровня** защиты — главный автоматический + ручной snapshot
здесь и сейчас при нужде.

## Уровень 1: Автоматический ежедневный snapshot

Два варианта реализации. **Достаточно одного** — на выбор.

### Вариант A (рекомендуется): Cloudflare Worker → R2

Изолировано от прод-сервера, бесплатно (R2 free tier: 10 GB), 5 минут
настройки.

**Через CLI (если установлен wrangler):**
```bash
# Залогиниться один раз
wrangler login

# Создать R2 bucket
wrangler r2 bucket create mm-clients-backups

# Задеплоить Worker
wrangler deploy --config worker/wrangler-mm-backup.toml

# Добавить секреты (попросит ввести значения)
wrangler secret put FIREBASE_API_KEY --config worker/wrangler-mm-backup.toml
wrangler secret put BACKUP_SECRET    --config worker/wrangler-mm-backup.toml
```

**Через Dashboard UI** (без CLI) — 5 шагов:

1. **R2 bucket:** dash.cloudflare.com → R2 → Create bucket → имя
   `mm-clients-backups`.
2. **Worker:** Workers → Create application → Worker → имя `mm-backup` →
   Deploy с дефолтным кодом → потом `Edit code` → вставить содержимое
   [mm-backup.js](mm-backup.js) → Save and deploy.
3. **R2 Binding:** Worker `mm-backup` → Settings → Bindings → Add → R2
   bucket → variable `BACKUPS`, bucket `mm-clients-backups`.
4. **Variables and Secrets:**
   - `FIREBASE_PROJECT_ID` (Plaintext) = `mmclients-eea40`
   - `FIREBASE_API_KEY` (Secret) = web API key из FIREBASE_CONFIG
   - `BACKUP_SECRET` (Secret) = случайная строка 64 hex (для ручного запуска)
   - `RETENTION_DAYS` (Plaintext) = `30` (опционально)
5. **Cron Trigger:** Settings → Trigger Events → Add Cron → `0 3 * * *`
   (03:00 UTC = 08:00 GMT+5).

**Проверка:**
- Healthcheck: `https://mm-backup.<account>.workers.dev/` — список последних 5 бэкапов.
- Ручной запуск: `https://mm-backup.<account>.workers.dev/backup?secret=<BACKUP_SECRET>` — сразу делает snapshot.
- Список всего: `https://mm-backup.<account>.workers.dev/list?secret=<BACKUP_SECRET>`.

### Вариант B: Plesk Scheduled Task → файл на сервере

Проще, но менее надёжно (если упадёт сервер — упадут и бэкапы вместе с
прод-базой клиентов).

```bash
# 1. Залить скрипт на сервер
scp worker/backup-firestore.sh user@host:/var/scripts/

# 2. Сделать исполняемым
chmod +x /var/scripts/backup-firestore.sh

# 3. Создать папку для дампов
mkdir -p /var/backups/mmclients && chmod 700 /var/backups/mmclients

# 4. В Plesk → Tools & Settings → Scheduled Tasks → Add:
#    Command: /bin/bash /var/scripts/backup-firestore.sh
#    Schedule: Cron → 0 3 * * *
```

## Уровень 2 (опционально): Manual snapshot прямо сейчас

Если автомат ещё не настроен или нужно сохранить state ad-hoc перед
рискованной операцией:

```bash
# Из корня репо
mkdir -p .local_backups
curl -s "https://firestore.googleapis.com/v1/projects/mmclients-eea40/databases/(default)/documents/mmClients/data?key=AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro" \
  -o ".local_backups/manual-$(date +%Y%m%d_%H%M%S).json"
```

`.local_backups/` уже в `.gitignore` — клиентские данные **не попадут в
git**. Если используете другую папку, обязательно добавьте её в gitignore.

## Восстановление

```bash
# Допустим, нужен snapshot за 2026-05-19
# 1. Скачать дамп (из R2 dashboard / из /var/backups/mmclients / из .local_backups)
# 2. Распарсить и применить через REST PATCH

node -e "
const fs = require('fs');
const doc = JSON.parse(fs.readFileSync('backup-2026-05-19.json', 'utf8'));
const PROJ = 'mmclients-eea40';
const KEY  = process.env.FIREBASE_API_KEY;
const url  = 'https://firestore.googleapis.com/v1/projects/' + PROJ +
             '/databases/(default)/documents/mmClients/data?key=' + KEY;
fetch(url, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fields: doc.fields }),
}).then(r => r.text()).then(t => console.log('RESTORE result:', t.slice(0, 200)));
"
```

**ВАЖНО:** restore через PATCH перезаписывает документ **целиком**. Любые
изменения, сделанные мастерами между моментом backup и моментом restore,
будут потеряны. Поэтому:
- Перед restore сделайте свежий manual snapshot текущего состояния
  (вдруг restore не то восстановит — есть откат).
- Перед restore попросите мастеров не работать в платформе 5 минут.
- После restore проверьте что важные карточки на месте (через curl GET).

## Уровень 3 (бонус, не реализован пока): Real-time snapshot

В существующем `mm-altegio` Worker можно добавить запись копии документа
в отдельный путь `mmClients_backups/<timestamp>` при каждом upsert. Это
даст защиту с гранулярностью **секунд** вместо **суток**.

Минусы:
- Удваивает write'ы Firestore (Spark Free лимит 20K/день — но у нас сейчас
  ~100-500/день, запас 40x).
- Усложняет Worker, требует rotation (хранить только последние N).
- Хранится в той же базе — если кто-то целиком дропнет Firestore (что
  невозможно через наш UI, но возможно через консоль Firebase),
  потеряется вместе с прод-документом.

Реализовать когда:
- Случится ещё один инцидент race-condition (но он уже починен мержем).
- Бизнес-критичность вырастет (> 500 активных клиентов).
