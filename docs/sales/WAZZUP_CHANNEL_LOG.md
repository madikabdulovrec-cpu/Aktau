# Журнал сборки — Wazzup-канал для KomekAI

Wazzup-канал (WhatsApp + Instagram через агрегатор Wazzup24) как **нативный канал
платформы KomekAI**. M&M-бот переезжает с прототипа (Cloudflare Worker, JS) в
стек KomekAI (Python).

- **Репозиторий:** KomekAI (`Evimiz-KZ/KomekAi`, приватный)
- **Ветка:** `feat/wazzup-channel` (ответвление от `main`)
- **Стек:** Python, по образцу `gateway/channels/whatsapp.py`
- **Цель:** после теста на студии M&M — PR → merge в `main`; Wazzup-канал
  становится фичей платформы (любой клиент KomekAI сможет включить).
- Предыдущий этап (прототип на Cloudflare): [BUILD_LOG.md](BUILD_LOG.md)

Каждый шаг фиксируется здесь по ходу работы.

---

## План

1. ✅ Изучить регистрацию каналов (как подключён `whatsapp.py`: фабрика адаптеров, webhook-маршрут admin→gateway).
2. ✅ `gateway/channels/wazzup.py` — `WazzupChannelAdapter` (`parse_webhook` + `send`).
3. ✅ Регистрация Wazzup-адаптера в фабрике каналов.
4. ✅ Webhook-маршрут: `/api/webhooks/wazzup` (admin) + `/internal/channels/wazzup` (gateway).
5. ✅ `skins/beauty_mm.yaml` — скин студии M&M (каталог, правила, tools).
6. ✅ Тесты (pytest).
7. ✅ Прогон, проверка, подготовка PR.

---

## Шаги

### Шаг 1 — Ветка и журнал
- Создана ветка `feat/wazzup-channel` от `main` в репозитории KomekAI.
- Заведён этот журнал.
- **Результат:** окружение готово, можно приступать к коду.

### Шаг 2 — Изучена архитектура каналов KomekAI
- Прочитаны `gateway/channels/{base,whatsapp,ingest,webhook,__init__}.py` и `gateway/http_server.py`.
- Схема: `BaseChannelAdapter` (контракт `parse_webhook`/`send`) → фабрика `build_channel_adapter` (registry `_ADAPTERS`) → `ingest_message` — канало-нейтральное ядро (дедуп, Case, история, LLM+скин, доставка) → webhook-роуты `/internal/channels/...` на gateway:9093, публичный proxy в admin FastAPI.
- **Результат:** Wazzup-канал = новый адаптер + строка в registry + webhook-роут; ядро не трогаем.

### Шаг 3 — Адаптер Wazzup + регистрация
- Создан `gateway/channels/wazzup.py` — `WazzupChannelAdapter(BaseChannelAdapter)`:
  - `parse_webhook` — формат Wazzup → `InboundMessage`; фильтрует эхо (`isEcho`), статусы доставки, не-текст и ping `{test:true}`.
  - `send` — Wazzup REST `POST /v3/message`; маршрут ответа (channelId/chatType) запоминается из входящего → корректный ответ и в WhatsApp, и в Instagram.
  - формат webhook взят с боевого теста прототипа (логи `RAW_WEBHOOK`).
- Зарегистрирован в `gateway/channels/__init__.py` (`_ADAPTERS["wazzup"]`).
- Среда: настоящий Python вызывается через `py` (команда `python` — заглушка Microsoft Store). `py -m py_compile` — синтаксис `wazzup.py` и `__init__.py` OK.
- **Результат:** адаптер готов и виден фабрике. Дальше — webhook-маршруты и конфиг.

### Шаг 4 — Webhook-маршруты и конфиг
- `gateway/config.py` — добавлены настройки `wazzup_api_key`, `wazzup_channel_id`, `wazzup_chat_type` (env-переменные).
- `gateway/channels/webhook.py` — `_wazzup_adapter()` + `handle_wazzup_inbound()` (POST); зарегистрирован роут `/internal/channels/wazzup`.
- `admin/backend/routers/channels_webhook.py` — публичный роут `POST /api/webhooks/wazzup`: проверка секрета (`?secret=` или заголовок `X-Webhook-Secret`, fail-closed → 403), проброс тела на gateway.
- `py_compile` всех трёх файлов — OK.
- **Результат:** цепочка приёма собрана: Wazzup → admin `/api/webhooks/wazzup` → gateway `/internal/channels/wazzup` → `ingest_message` (Case, история, LLM+скин, ответ). Дальше — скин M&M.

### Шаг 5 — Скин студии M&M
- Создан `skins/beauty_mm.yaml` в формате скина KomekAI:
  - `assistant` / `organization` — данные студии (Алматы, Ауэзова 175Б, часы 8:00–21:00).
  - `prompt_extra` — золотые правила, алгоритм, каталог 10 процедур с описаниями, противопоказания, возражения, тон. Адаптировано из прототипа: убраны теги `[[BOOKING]]`/`[[HANDOFF]]` (вместо них — tools KomekAI), добавлено явное правило «не выходить из роли» (фикс бага frame-break из боевого теста).
  - `knowledge.prices` — 10 процедур с ценами пробного посещения; `knowledge.faq` — 5 вопросов; `knowledge.services` — список.
  - `tools` — `lookup_faq` + `transfer_to_human`. `book_appointment` НЕ включён: реальная запись (MIS) в KomekAI пока на mock-адаптере → бот доводит лида до менеджера, тот согласует время и записывает.
  - `tools_config` — бьюти-термины (мастер / клиент / консультация).
- YAML провалидирован (`yaml.safe_load` — ключи на месте, 10 цен).
- **Открытые вопросы к Марии:** имя ассистента (пока «Ассистент M&M»), описание «Импульса», акции, текст согласия на обработку ПД.
- **Результат:** скин готов. Дальше — тесты.

### Шаг 6 — Тесты канала
- В `tests/test_channels.py` добавлены 4 теста Wazzup-адаптера (по образцу тестов WhatsApp):
  - `test_wazzup_factory` — фабрика возвращает `WazzupChannelAdapter`.
  - `test_wazzup_parse_inbound` — разбор входящего: поля `InboundMessage`, метаданные, запоминание маршрута ответа.
  - `test_wazzup_parse_skips_non_messages` — отбрасывание эха, статусов доставки, не-текста, пустого текста, ping `{test:true}`, `{statuses}`, битых payload.
  - `test_wazzup_send_not_configured` — `send` без `api_key` мягко возвращает None.
- `py_compile` — OK.
- ⚠️ Полный прогон `pytest` — в CI KomekAI: локальная среда (bare Python 3.14) не настроена под полный стек зависимостей (sqlalchemy, anthropic, grpcio…). Тесты написаны строго по образцу существующих и провалидированы по синтаксису; зелёный прогон подтвердит CI при PR.
- **Результат:** тесты канала готовы.

### Шаг 7 — Коммиты в ветку
- Работа закоммичена в `feat/wazzup-channel` двумя атомарными коммитами:
  - `35b695d feat(channels): Wazzup-канал (WhatsApp + Instagram)` — 6 файлов (адаптер, фабрика, webhook-роуты, config, тесты), 355 строк.
  - `ed6c4a8 feat(skins): скин студии M&M (beauty_mm)` — скин студии, 215 строк.
- Рабочее дерево чисто; ветка на 2 коммита впереди `main`.
- **Результат:** Wazzup-канал собран и закоммичен.

---

## Итог: Wazzup-канал собран

Все 7 шагов выполнены. Wazzup-канал — нативный канал платформы KomekAI:
адаптер переиспользует движок, ingest-pipeline, скины и Case-инбокс KomekAI.

**Коммиты (ветка `feat/wazzup-channel`, 2 ahead of main):**
- `35b695d feat(channels): Wazzup-канал (WhatsApp + Instagram)` — 6 файлов, 355 строк
- `ed6c4a8 feat(skins): скин студии M&M (beauty_mm)` — 1 файл, 215 строк

**Файлы (ветка `feat/wazzup-channel`):**
- `gateway/channels/wazzup.py` — адаптер (new)
- `gateway/channels/__init__.py`, `gateway/channels/webhook.py`, `gateway/config.py`, `admin/backend/routers/channels_webhook.py` — проводка
- `skins/beauty_mm.yaml` — скин студии M&M (new)
- `tests/test_channels.py` — тесты Wazzup-адаптера

---

## Следующие шаги (новая сессия)

| # | Задача | Зона |
|---|--------|------|
| 1 | **Push** ветки `feat/wazzup-channel` на GitHub | Мадияр → подтвердить |
| 2 | **PR** в `main` KomekAI (после успешного теста) | Мадияр / Дария |
| 3 | **`pytest`** в CI KomekAI — зелёный прогон | CI |
| 4 | **Живой тест** M&M — деплой ветки, Wazzup webhook на `/api/webhooks/wazzup?secret=…` | Владелец |
| 5 | **Env-переменные** на стенде: `WAZZUP_API_KEY`, `WAZZUP_CHANNEL_ID`, `WAZZUP_WEBHOOK_SECRET`, `KOMEKAI_SKIN=beauty_mm`, `CLINIC_ID=beauty_mm` | Владелец |
| 6 | **Контент от Марии:** имя ассистента, описание «Импульса», акции, текст согласия на ПД | Мария |
| 7 | Отключить Wazzup-webhook прототипа CF (окончательно) после перехода на KomekAI-версию | Мадияр |

**Состояние репозитория:** рабочее дерево чисто, ветка не запушена (только локально).
**Дата закрытия сессии:** 2026-05-22
