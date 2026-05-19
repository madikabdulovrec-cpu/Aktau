#!/bin/bash
# Альтернативный бэкап Firestore — bash скрипт для Plesk Scheduled Tasks.
# Использовать ЛИБО Cloudflare Worker mm-backup (рекомендуется), ЛИБО этот
# скрипт через Plesk cron — не оба сразу. Различия:
#
#   Cloudflare Worker → R2:  изолировано от Plesk-сервера, бэкап доступен
#                            даже если сервер упал. Free tier (R2: 10 GB).
#   Plesk cron → файл:       проще настроить, но если упадёт сервер —
#                            упадут и бэкапы. Сделать резервное копирование
#                            папки /var/backups/mmclients средствами Plesk.
#
# Установка в Plesk:
#   1. Залить этот файл на сервер, например: /var/scripts/backup-firestore.sh
#   2. chmod +x /var/scripts/backup-firestore.sh
#   3. Plesk → Tools & Settings → Scheduled Tasks → Add Task:
#        Command: /bin/bash /var/scripts/backup-firestore.sh
#        Run:     Cron-style → 0 3 * * *  (каждый день в 03:00)
#   4. Создать папку: mkdir -p /var/backups/mmclients && chmod 700 /var/backups/mmclients
#   5. Опционально: настроить отправку tar-архива на email раз в неделю.

set -euo pipefail

# ==== Конфиг ====
PROJECT_ID="mmclients-eea40"
API_KEY="AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro"  # public Web API key, не секрет
BACKUP_DIR="/var/backups/mmclients"
RETENTION_DAYS=30

# ==== Подготовка ====
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"  # только owner — клиентские PII не светим
DATE_KEY="$(date +%Y-%m-%d)"
OUT="$BACKUP_DIR/${DATE_KEY}.json"
URL="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/mmClients/data?key=${API_KEY}"

# ==== Скачивание ====
HTTP_CODE=$(curl -s -o "$OUT.tmp" -w "%{http_code}" "$URL")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[backup] FAIL: Firestore HTTP $HTTP_CODE"
  rm -f "$OUT.tmp"
  exit 1
fi

# ==== Минимальная валидация — это вообще валидный JSON с полями? ====
if ! grep -q '"fields"' "$OUT.tmp"; then
  echo "[backup] FAIL: ответ не содержит 'fields' — наверно ошибка от Firestore, не сохраняю"
  cat "$OUT.tmp" | head -c 500
  rm -f "$OUT.tmp"
  exit 1
fi

mv "$OUT.tmp" "$OUT"
SIZE=$(stat -c '%s' "$OUT")
echo "[backup] OK: $OUT ($SIZE bytes)"

# ==== Cleanup: удаляем старше RETENTION_DAYS ====
find "$BACKUP_DIR" -name '*.json' -type f -mtime "+$RETENTION_DAYS" -print -delete

echo "[backup] retention $RETENTION_DAYS days enforced"
