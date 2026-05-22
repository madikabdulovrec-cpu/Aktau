# Развёртывание бота «Пульс продаж» — `mm-pulse-bot`

Cron-бот: каждые 3 часа считает метрики продаж дня и шлёт сводку в рабочий
Telegram-чат отдела продаж. Код — [`mm-pulse-bot.js`](mm-pulse-bot.js).
Конфиг — [`wrangler-mm-pulse-bot.toml`](wrangler-mm-pulse-bot.toml).
ТЗ — [`../docs/sales/TASK_pulse_bot.md`](../docs/sales/TASK_pulse_bot.md).

Не заменяет вечерний отчёт продажника — добавляет объективную картину по цифрам.
Бот первичной обработки заявок (`mh-bot`) — отдельный бот; `mm-pulse-bot` от его
деплоя **не зависит** (см. «Ветка B2» ниже — единственное исключение).

## Архитектура — ветка B1 (webhook-коллектор)

API message.help на чтение подтвердить не удалось (справка API — за логином),
поэтому источник данных — вебхук `channel.message`:

- `mm-pulse-bot` регистрирует **свой** вебхук в message.help;
- на каждое сообщение воркер дописывает событие в KV-бакет дня `events:YYYY-MM-DD`;
- cron в 08/11/14/17/20 Алматы читает бакет, считает метрики (код, не LLM),
  персона РОП пишет короткий блок «на что смотреть», отчёт уходит в Telegram.

Если окажется, что message.help допускает только **один** вебхук на проект —
перейти на ветку B2 (раздел в конце).

## Что нужно иметь

- Доступ к аккаунту **Cloudflare** (тот же, где `mh-bot` / `mm-altegio`).
- **Telegram-бот** — создать у [@BotFather](https://t.me/BotFather), `/newbot`.
- **Рабочий чат отдела продаж** — тот, где продажник пишет вечерний отчёт.
- **Anthropic API-ключ** — с прошлой сборки (`worker/anthropic-key.local.txt`, в .gitignore).
- Аккаунт **message.help** (`medstarcompany@mail.ru`) — логин и пароль (нужны
  только для регистрации вебхука; воркер логинится сам).
- `MH_PROJECT_ID` — id проекта message.help (предположительно `220763` — подтвердить).

## Шаг 1 — Telegram-бот и chat_id

1. [@BotFather](https://t.me/BotFather) → `/newbot` → получить **токен бота**.
2. Добавить бота в рабочий чат отдела продаж (дать право писать сообщения).
3. Узнать `chat_id`: написать любое сообщение в чат, затем открыть
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → взять `chat.id`.
   Для группы id отрицательный, вида `-100…`.

## Шаг 2 — KV namespace

```
wrangler kv namespace create mm-pulse-kv
```

Выданный `id` вписать в `wrangler-mm-pulse-bot.toml` → `[[kv_namespaces]] id = "…"`.

## Шаг 3 — переменные

В `wrangler-mm-pulse-bot.toml`, секция `[vars]`:

- `MH_PROJECT_ID` — id проекта message.help (`220763` — подтвердить).
- `TELEGRAM_CHAT_ID` — id чата из шага 1.
- `ANTHROPIC_MODEL` — по умолчанию `claude-sonnet-4-6` (для максимума — `claude-opus-4-7`).
- `UNANSWERED_THRESHOLD_MIN` — порог «без ответа», по умолчанию `20`.

## Шаг 4 — секреты

`wrangler secret put <ИМЯ> --config worker/wrangler-mm-pulse-bot.toml`:

- `ANTHROPIC_API_KEY` — ключ Claude.
- `TELEGRAM_BOT_TOKEN` — токен бота из шага 1.
- `DIGEST_SECRET` — случайная строка; ручной триггер дайджеста и регистрация вебхука.
- `WEBHOOK_SECRET` — случайная строка 32+ символов; зашивается в URL вебхука
  (message.help вебхуки не подписывает).
- `MH_LOGIN` — email аккаунта message.help.
- `MH_PASSWORD` — пароль аккаунта message.help.

## Шаг 5 — деплой

```
wrangler deploy --config worker/wrangler-mm-pulse-bot.toml
```

Проверка: `GET https://mm-pulse-bot.<account>.workers.dev/` →
`{"status":"ok","service":"mm-pulse-bot",…}`.

## Шаг 6 — регистрация вебхука в message.help

Открыть один раз в браузере:

```
https://mm-pulse-bot.<account>.workers.dev/?register=<DIGEST_SECRET>
```

Воркер сам залогинится в message.help и зарегистрирует вебхук
`POST /api/app/projects/{MH_PROJECT_ID}/webhooks/` с entity `channel.message` на
URL `…/?secret=<WEBHOOK_SECRET>`. Ответ `{"ok":true,"registered":…}` — готово.

Альтернатива вручную (если нужно):
1. `POST https://message.help/api/app/user/login` тело `{"login":"…","password":"…"}`
   → взять `data.access_token`.
2. `POST https://message.help/api/app/projects/{MH_PROJECT_ID}/webhooks/`
   заголовок `Authorization: Bearer <token>`, тело
   `{"url":"https://mm-pulse-bot.<account>.workers.dev/?secret=<WEBHOOK_SECRET>","entities":["channel.message"]}`.

Если ответ — ошибка про «только один вебхук» на проект → перейти на ветку B2 ниже.

## Шаг 7 — боевой тест

1. Ручной триггер: `GET …workers.dev/?secret=<DIGEST_SECRET>` → в чат приходит
   отчёт. На пустом дне это короткое «Тихо: 0 новых…» — пайплайн работает.
2. Написать тестовое сообщение на WhatsApp студии → дёрнуть ручной триггер ещё
   раз → заявка должна посчитаться; ответ менеджера попадёт в «скорость ответа».
3. Cron виден в Cloudflare → Worker `mm-pulse-bot` → Triggers
   (`0 3,6,9,12,15 * * *`). После первого автозапуска сообщение придёт в чат в
   08:00 / 11:00 / 14:00 / 17:00 / 20:00 Алматы.
4. Логи: Cloudflare → Workers → `mm-pulse-bot` → Logs. Строка `RAW_WEBHOOK`
   показывает реальный формат события — после диагностики её можно убрать.

## Проверить на боевом тесте (VERIFY)

Написано по `mh-bot.js` и спецификации message.help — подтвердить на проде
(в `mm-pulse-bot.js` помечено `VERIFY`):

- формат вебхука `channel.message.created` и поля payload (лог `RAW_WEBHOOK`);
- `destination`: `from` = клиент, `from_operator` = оператор/бот;
- формат `created_at` (epoch sec/ms или ISO-строка) — разбирается `parseTs`;
- строки `message_type` — особенно реакции-эмодзи; лог «message types seen»
  показывает встреченные типы, при необходимости поправить `NON_LEAD_MESSAGE_TYPES`;
- message.help допускает несколько вебхуков на проект (иначе — ветка B2).

После проверки сверить цифры бота с ручным «разбором за сегодня» за тот же день:
расхождение по числу живых заявок — не более ±10–15% (воронка CRM завышена
автозаписями, бот считает по потоку сообщений — это ориентир).

## Ветка B2 — фоллбэк, если вебхук на проект только один

Тогда единственный вебхук остаётся у `mh-bot` (ему события нужны, чтобы
отвечать клиентам), а `mh-bot` дублирует копию каждого события в `mm-pulse-kv`:

1. Вебхук `mm-pulse-bot` **не регистрировать** (шаг 6 пропустить). Воркер
   работает только по cron, читая бакет, который наполняет `mh-bot`.
2. В `wrangler-mh-bot.toml` добавить биндинг на тот же KV namespace:
   ```toml
   [[kv_namespaces]]
   binding = "PULSE_KV"
   id = "<id mm-pulse-kv из шага 2>"
   ```
3. В `mh-bot.js` скопировать из `mm-pulse-bot.js` функции `parseWebhook` (под
   другим именем, напр. `parsePulseEvent` — у `mh-bot` уже есть свой
   `parseWebhook`), `recordEvent` (→ `teeToPulse`), `parseTs`, `almatyDateStr`,
   `pad2` и константы `EVENTS_TTL`, `ALMATY_UTC_OFFSET`,
   `NON_LEAD_MESSAGE_TYPES`. В обработчике `fetch`, рядом с разбором вебхука,
   добавить `ctx.waitUntil(teeToPulse(body, env))`.
4. Передеплоить `mh-bot`. Дайджест `mm-pulse-bot` при этом не меняется — он
   читает тот же ключ `events:YYYY-MM-DD`.

Минус B2: `mm-pulse-bot` начинает зависеть от деплоя `mh-bot`. Поэтому ветка по
умолчанию — B1; B2 — только если message.help не даёт второй вебхук.

## Расписание и формат

- Cron `0 3,6,9,12,15 * * *` (UTC) = 08:00 / 11:00 / 14:00 / 17:00 / 20:00 Алматы,
  7 дней в неделю. 20:00 — итоговый отчёт дня (чуть полнее).
- 5 сообщений в день — держать коротко. Если команда жалуется на частоту —
  сузить слоты правкой `crons` в конфиге (напр. `0 3,9,15 * * *` — 3 раза).
- Тон и правила цифр — персона РОП (`docs/sales/04_sales_lead_ai_persona.md`) и
  раздел 6 ТЗ: считать только живые обращения, в примерах диалогов указывать
  номер, нет данных за метрику — строку честно опускать.
