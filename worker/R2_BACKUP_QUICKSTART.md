# R2 Backup — пошаговая инструкция для пользователя (5 кликов)

Цель: каждый день в 08:00 утра Cloudflare сам сохраняет копию ВСЕХ
карточек клиентов в надёжное хранилище (R2, отдельно от Firestore).
Если когда-нибудь снова потеряется карточка — восстанавливаем за 2 минуты.

**Что нужно:** аккаунт Cloudflare (уже есть — там же где worker mm-altegio).
**Сколько займёт:** 5 минут.

---

## Шаг 1. Создать R2 bucket

Открой: **https://dash.cloudflare.com/?to=/:account/r2/overview**

1. Кнопка **«Create bucket»**.
2. **Bucket name:** `mm-clients-backups`
3. **Location:** Automatic (или Eastern Europe — поближе).
4. **Create bucket**.

> Если Cloudflare попросит включить R2 — нажми «Enable R2». Бесплатный
> тариф: 10 ГБ хранения + 1 млн операций/мес. Наши бэкапы ~300 КБ × 30 дней
> = 9 МБ. Запас в 1100x.

---

## Шаг 2. Создать Worker

Открой: **https://dash.cloudflare.com/?to=/:account/workers-and-pages**

1. **Create application** → **Worker** → **Get started**.
2. **Name:** `mm-backup`
3. **Deploy** (с дефолтным «Hello World» кодом — заменим в следующем шаге).
4. После deploy → кнопка **Edit code**.
5. Скопируй ВЕСЬ файл [`worker/mm-backup.js`](mm-backup.js) и вставь в редактор поверх дефолтного кода.
6. **Save and deploy**.

---

## Шаг 3. Привязать R2 к Worker'у

Worker `mm-backup` → **Settings** → **Bindings** → **Add binding** → **R2 bucket**.

| Поле | Значение |
|------|----------|
| Variable name | `BACKUPS` |
| R2 bucket | `mm-clients-backups` |

→ **Save**.

---

## Шаг 4. Variables and Secrets

Worker `mm-backup` → **Settings** → **Variables and Secrets** → **Add**.

Добавь **4 переменные**:

| Variable name | Type | Value |
|---------------|------|-------|
| `FIREBASE_PROJECT_ID` | Plaintext | `mmclients-eea40` |
| `FIREBASE_API_KEY` | Secret | `AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro` |
| `BACKUP_SECRET` | Secret | `df1f8003974dba4485a9a47c514863792f1e5f6bbc3a4230333d4072c17f0021` |
| `RETENTION_DAYS` | Plaintext | `30` |

→ **Save and deploy**.

> `FIREBASE_API_KEY` — это тот же ключ, что уже в `clients_platform/index.html`
> (публичный ключ, видим в коде сайта; чтобы Worker мог делать REST-запросы
> к Firestore).
>
> `BACKUP_SECRET` — для ручного запуска бэкапа (мы его сгенерировали выше).
> Запиши себе — пригодится в Шаге 6.

---

## Шаг 5. Cron Trigger (ежедневно в 08:00 утра)

Worker `mm-backup` → **Settings** → **Trigger Events** → **Add Cron**.

| Поле | Значение |
|------|----------|
| Cron expression | `0 3 * * *` |

(`0 3 * * *` = 03:00 UTC = 08:00 GMT+5, утро в Алматы).

→ **Add**.

---

## Шаг 6. Проверка

Открой в браузере: **`https://mm-backup.<твой-аккаунт>.workers.dev/`**
(точный URL покажет Cloudflare после Шага 2).

Должен показать JSON примерно так:

```json
{
  "status": "ok",
  "service": "mm-backup",
  "firestore": "mmclients-eea40",
  "retention_days": 30,
  "last_backups": [],
  "time": "2026-05-29T..."
}
```

**Запустить первый бэкап вручную (не ждать 8 утра):**
```
https://mm-backup.<твой-аккаунт>.workers.dev/backup?secret=df1f8003974dba4485a9a47c514863792f1e5f6bbc3a4230333d4072c17f0021
```

Должен ответить:
```json
{
  "ok": true,
  "manual": true,
  "key": "backups/2026-05-29.json",
  "size_bytes": 327000,
  "clients": 255,
  "staff": 3,
  "retention_days": 30
}
```

Проверь в R2: dash.cloudflare.com → R2 → `mm-clients-backups` →
файл `backups/2026-05-29.json` появился. **Готово.**

---

## Как восстановить карточку из бэкапа

Если когда-нибудь снова пропадёт клиент — напиши Claude:

> «Восстанови карточку из бэкапа за дату YYYY-MM-DD»

Он:
1. Скачает файл `backups/YYYY-MM-DD.json` из R2.
2. Найдёт нужную карточку.
3. Зальёт обратно в Firestore через PATCH с precondition.

Полная инструкция восстановления — в [`worker/BACKUP_SETUP.md`](BACKUP_SETUP.md),
раздел «Восстановление».

---

## Важно: где взять «account ID» для URL Worker'а

После Шага 2 (Deploy) Cloudflare покажет полный URL, например:
`https://mm-backup.madik-abdulov-rec.workers.dev/`

Это тот же поддомен, что и у `mm-altegio.madik-abdulov-rec.workers.dev/`.
