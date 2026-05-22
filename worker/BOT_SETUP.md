# Развёртывание бота M&M Fabrica (mm-bot)

Инструкция по запуску бота первичной обработки заявок.
Код: [mm-bot.js](mm-bot.js) · Конфиг: [wrangler-mm-bot.toml](wrangler-mm-bot.toml) · Бриф: [../docs/sales/Для бота.md](../docs/sales/Для%20бота.md)

Архитектура: `Клиент пишет в WhatsApp/Instagram → Wazzup24 → webhook → Cloudflare Worker (mm-bot) → Claude API → ответ клиенту`.

---

## Шаг 0. Что нужно заранее

| Что | Где взять |
|---|---|
| Аккаунт Cloudflare | dashboard.cloudflare.com (тот же, где `mm-altegio`) |
| Ключ Claude API | console.anthropic.com → API Keys |
| Аккаунт Wazzup24 + ключ API | wazzup24.com → личный кабинет → Интеграции → API |
| Подключённый канал WhatsApp в Wazzup | Wazzup кабинет → Каналы |
| Номер менеджера для handoff | формат `7701XXXXXXX` |

---

## Шаг 1. KV namespace

Cloudflare Dashboard → Workers & Pages → KV → **Create namespace** → имя `mm-bot-kv`.
Скопировать его **ID** — понадобится в конфиге.

## Шаг 2. Деплой Worker

### Вариант A — через Dashboard (без установки инструментов)

1. Workers & Pages → **Create** → Worker → имя `mm-bot` → Deploy (заглушка).
2. **Edit code** → удалить заглушку → вставить весь [mm-bot.js](mm-bot.js).
   Файл большой — копировать через буфер целиком (как при правке `altegio-webhook.js`).
3. Save and deploy.
4. Settings → **Bindings** → Add → KV namespace: переменная `BOT_KV` → namespace `mm-bot-kv`.
5. Settings → **Variables**:
   - Plaintext: `ANTHROPIC_MODEL` = `claude-sonnet-4-6`, `MANAGER_CHAT_ID` = номер менеджера, `MANAGER_CHAT_TYPE` = `whatsapp`
   - Secret: `ANTHROPIC_API_KEY`, `WAZZUP_API_KEY`, `WEBHOOK_SECRET`
6. Save and deploy ещё раз.

### Вариант B — через wrangler CLI

1. В [wrangler-mm-bot.toml](wrangler-mm-bot.toml) подставить `id` KV namespace и `MANAGER_CHAT_ID`.
2. ```
   wrangler deploy --config worker/wrangler-mm-bot.toml
   wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler-mm-bot.toml
   wrangler secret put WAZZUP_API_KEY    --config worker/wrangler-mm-bot.toml
   wrangler secret put WEBHOOK_SECRET    --config worker/wrangler-mm-bot.toml
   ```

`WEBHOOK_SECRET` — придумать случайную строку 32+ символов.

## Шаг 3. Webhook в Wazzup24

Wazzup кабинет → Интеграции → Webhooks (или «Адрес для уведомлений»):
```
https://mm-bot.<ваш-субдомен>.workers.dev/?secret=<WEBHOOK_SECRET>
```
Включить уведомления о входящих сообщениях.

## Шаг 4. Проверка

1. **Healthcheck:** открыть `https://mm-bot.<субдомен>.workers.dev/` в браузере → должно вернуть `{"status":"ok","service":"mm-bot",...}`.
2. **Боевой тест:** написать на номер студии в WhatsApp «Здравствуйте, сколько стоит торнадо?» — бот должен ответить за секунды с ценой 12 000 ₸ и слотами.
3. **Логи:** Cloudflare → mm-bot → Logs (Real-time) — строки `claude ok cache_read=...`, `done ...`.

---

## Переменные окружения

| Переменная | Тип | Значение |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | Ключ Claude API |
| `WAZZUP_API_KEY` | Secret | Ключ Wazzup24 API |
| `WEBHOOK_SECRET` | Secret | Случайная строка 32+ символов |
| `ANTHROPIC_MODEL` | Plaintext | `claude-sonnet-4-6` (или `claude-opus-4-7` для макс. качества) |
| `MANAGER_CHAT_ID` | Plaintext | Номер менеджера, `7701XXXXXXX` |
| `MANAGER_CHAT_TYPE` | Plaintext | `whatsapp` |
| `BOT_KV` | KV binding | namespace `mm-bot-kv` |

---

## UTM-метки (отслеживание источников)

Чтобы видеть, откуда пришёл клиент, каждый рекламный канал ведёт на свою ссылку с предзаполненным текстом:
```
https://wa.me/77XXXXXXXXX?text=Здравствуйте!%20Видел(а)%20рекламу%20%5Bistochnik:instagram_reels%5D
```
Бот получит метку в первом сообщении. (Привязка метки к карточке лида — доработка следующей итерации; сейчас метка просто попадёт в историю диалога.)

---

## Ограничения MVP (доработать)

- **Слоты** генерируются по графику консультаций (10:00-19:00), без реальной занятости Altegio. Менеджер сверяет с расписанием при подтверждении. Доработка: интеграция Altegio `book_times`.
- **Согласие на обработку ПД** (ЗРК «О персональных данных») — добавить уведомление в первое автосообщение + ссылку на политику. Получить финальный текст у Марии.
- **Цены 7 процедур** (Золотое сечение, Торнадо по лицу, Импульс, Аргоновая плазма, ХП на голову, Медовый массаж, Чистка лица) — в промпте плейсхолдеры, бот отвечает «уточнит мастер». Заполнить в `mm-bot.js` (`SYSTEM_PROMPT`) и `docs/sales/05_bot_system_prompt.md`.
- **Webhook secret** передаётся через `?secret=` в URL. Если Wazzup24 обрезает query-параметры (как делал Altegio) — webhook будет возвращать 401; тогда настроить авторизацию иначе (заголовок/подпись Wazzup).
- **Напоминания о записи** (борьба с неявкой 52%) — отдельный модуль, в этом боте не реализован.

---

## Связанные документы

- [../docs/sales/05_bot_system_prompt.md](../docs/sales/05_bot_system_prompt.md) — системный промпт (синхронизировать с `SYSTEM_PROMPT` в mm-bot.js)
- [../docs/sales/Для бота.md](../docs/sales/Для%20бота.md) — бриф и база знаний
- [../docs/sales/BUILD_LOG.md](../docs/sales/BUILD_LOG.md) — журнал сборки
