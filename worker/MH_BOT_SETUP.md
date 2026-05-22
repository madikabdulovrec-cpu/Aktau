# Развёртывание бота M&M — `mh-bot` (интеграция message.help)

Бот первичной обработки заявок: message.help (WhatsApp) → Claude API → ответ клиенту.
Код — [`mh-bot.js`](mh-bot.js). Конфиг — [`wrangler-mh-bot.toml`](wrangler-mh-bot.toml).

Заменяет Wazzup-прототип `mm-bot.js`: канал WhatsApp и отдел продаж студии живут
в message.help, поэтому бот интегрируется напрямую с message.help.

## Что нужно иметь

- Доступ к аккаунту **Cloudflare** (тот же, где `mm-altegio`).
- Аккаунт **message.help** (`medstarcompany@mail.ru`) — логин и пароль (бот логинится в API сам).
- **Anthropic API-ключ** — с прошлой сборки (`worker/anthropic-key.local.txt`, в .gitignore).
- *(Опционально)* токены **Altegio** — для гейта «новый/действующий клиент» и реальных
  слотов. Без них бот работает; гейт опирается на остальные слои.

## Шаг 1 — KV namespace

Переиспользовать существующий `mm-bot-kv` (прототип Wazzup отключён) — его id уже
прописан в `wrangler-mh-bot.toml`. Либо создать новый:
`wrangler kv namespace create mh-bot-kv` → вписать выданный id в конфиг.

## Шаг 2 — переменные

В `wrangler-mh-bot.toml`, секция `[vars]`:
- `MH_PROJECT_ID` — id проекта message.help (предположительно `220763` — подтвердить).
- `MH_CHANNEL_UUID` — uuid WhatsApp-канала. Узнать:
  `GET https://message.help/api/app/projects/{project_id}/channels/` (с Bearer-токеном) →
  найти WhatsApp-канал, взять его `uuid`.
- `MANAGER_OPERATOR_ID` — id оператора-менеджера message.help (для назначения чата). Опц.
- `ALTEGIO_COMPANY_ID`, `ALTEGIO_CONSULT_SERVICE_ID` — опц.

## Шаг 3 — секреты

`wrangler secret put <ИМЯ> --config worker/wrangler-mh-bot.toml`:
- `ANTHROPIC_API_KEY` — ключ Claude.
- `MH_LOGIN` — email аккаунта message.help.
- `MH_PASSWORD` — пароль аккаунта message.help.
- `WEBHOOK_SECRET` — случайная строка 32+ символов (зашивается в URL вебхука).
- `ALTEGIO_PARTNER_TOKEN`, `ALTEGIO_USER_TOKEN` — опц.

## Шаг 4 — деплой

`wrangler deploy --config worker/wrangler-mh-bot.toml`
Проверка: `GET https://mh-bot.<account>.workers.dev/` → `{"status":"ok","service":"mh-bot"}`.

## Шаг 5 — регистрация вебхука в message.help

1. Получить токен: `POST https://message.help/api/app/user/login`
   тело `{"login":"...","password":"..."}` → взять `data.access_token`.
2. Зарегистрировать вебхук: `POST https://message.help/api/app/projects/{project_id}/webhooks/`
   заголовок `Authorization: Bearer <token>`, тело:
   `{"url":"https://mh-bot.<account>.workers.dev/?secret=<WEBHOOK_SECRET>","entities":["channel.message"]}`

## Шаг 6 — выключить встроенный меню-бот message.help

В кабинете message.help отключить английский «бот главного меню» на WhatsApp-канале —
иначе два бота будут отвечать одновременно.

## Шаг 7 — боевой тест

Написать тестовое сообщение на WhatsApp студии. Бот должен ответить за секунды.
Логи: Cloudflare → Workers → mh-bot → Logs. Строка `RAW_WEBHOOK` показывает реальный
формат вебхука. После успешного теста — убрать `RAW_WEBHOOK`-лог из `mh-bot.js`.

## Проверить на боевом тесте (VERIFY)

Эти места написаны по спецификации message.help/Altegio, но требуют подтверждения
на реальных данных — в `mh-bot.js` они помечены `VERIFY`:
- формат вебхука `channel.message.created` (лог `RAW_WEBHOOK`);
- `send_message` с `destination=from_operator` — доходит ли ответ клиенту;
- возвращает ли message.help наши исходящие сообщения вебхуком (эхо-защита);
- `get-user` — точное поле телефона клиента;
- `contact_by_phone` — поле `id` контакта;
- Altegio: `clients/search`, `book_dates`/`book_times`, id услуги-консультации.

## Контент от Марии (для полного промпта)

Бот работает и без этого (на неизвестное честно отвечает «уточнит мастер на
консультации»), но для полноты каталога: описание процедуры «Импульс», условия
рассрочки, текущие акции, текст согласия на обработку ПД, имя менеджера,
подтверждение что Крио отключено.
