/**
 * mm-pulse-bot.js — Бот «Пульс продаж» M&M Fabrica
 * Cloudflare Worker: каждые 3 часа шлёт в рабочий чат отдела продаж сводку
 * «как идут продажи» — заявки, скорость первого ответа, что висит без ответа.
 *
 * Зачем: аудит (docs/sales/audit.html) — до консультации доходит ~7% живых
 * заявок, их теряют в середине воронки. Бот делает потерю видимой в моменте,
 * пока заявку ещё можно спасти. Вечерний отчёт продажника не заменяет —
 * добавляет объективную картину по цифрам.
 *
 * ─── ВЕТКА B1 (webhook-коллектор, своя регистрация вебхука) ──────────────────
 * Источник данных дня выбран по итогу изучения API message.help: публичной
 * документации нет, API-справка (message.help/app/integrations_api/) — за
 * логином, pull-эндпойнт «список диалогов / сообщения с таймстампа» подтвердить
 * не удалось. Поэтому — ветка B (раздел 4 ТЗ): воркер подписан на вебхук
 * message.help channel.message, на каждое событие дописывает его в KV-бакет дня
 * (events:YYYY-MM-DD); cron-дайджест читает бакет и реконструирует день из
 * потока сообщений. Все метрики считает код, не LLM.
 * B1, а не B2: своя регистрация вебхука (POST /webhooks/ — коллекция, message.help
 * допускает несколько вебхуков на проект), mm-pulse-bot не зависит от деплоя
 * mh-bot. Если на проде окажется, что вебхук на проект допустим только один —
 * перейти на B2: единый вебхук остаётся у mh-bot, mh-bot.js дублирует копию
 * каждого события в mm-pulse-kv тем же ключом events:YYYY-MM-DD; дайджест при
 * этом не меняется. Подробно — worker/MM_PULSE_BOT_SETUP.md.
 *
 * ─── ДВЕ ТОЧКИ ВХОДА ────────────────────────────────────────────────────────
 *  scheduled — cron 0 3-16 * * * (ежечасно 08:00–20:00 пульс + 21:00 итог дня; Алматы): метрики → Telegram.
 *  fetch:
 *   POST ?secret=<WEBHOOK_SECRET>  — вебхук message.help, событие → KV-бакет дня;
 *   GET  ?secret=<DIGEST_SECRET>   — ручной запуск дайджеста;
 *   GET  ?register=<DIGEST_SECRET> — регистрация вебхука в message.help (настройка);
 *   GET  /                         — healthcheck.
 *
 * ─── ENV ────────────────────────────────────────────────────────────────────
 *  Secrets (wrangler secret put <ИМЯ> --config worker/wrangler-mm-pulse-bot.toml):
 *   ANTHROPIC_API_KEY  — ключ Claude API
 *   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
 *   DIGEST_SECRET      — секрет ручного триггера дайджеста и регистрации вебхука
 *   WEBHOOK_SECRET     — секрет в URL вебхука (message.help вебхуки не подписывает)
 *   MH_LOGIN           — email аккаунта message.help (только для регистрации вебхука)
 *   MH_PASSWORD        — пароль аккаунта message.help (только для регистрации вебхука)
 *  Plaintext vars:
 *   ANTHROPIC_MODEL          — модель Claude. По умолчанию claude-sonnet-4-6.
 *   MH_PROJECT_ID            — id проекта message.help (≈220763)
 *   TELEGRAM_CHAT_ID         — id рабочего чата отдела (для группы отрицательный)
 *   UNANSWERED_THRESHOLD_MIN — порог «без ответа сейчас», мин. По умолчанию 20.
 *  KV namespaces:
 *   PULSE_KV — бакеты событий дня (events:YYYY-MM-DD, TTL 48 ч) + кэш токена message.help
 *   MH_KV    — KV mh-bot. Читаем: карточки КЭВ (kev:*) для сверки с Altegio +
 *              пометки sent:* для маркировки сообщений бота (bot:true → не
 *              считаются скоростью ответа менеджеров и не снимают «без ответа»).
 *              Пишем РОВНО один ключ — broadcast_pause (предохранитель рассылки,
 *              WS-1): его tick mh-bot читает и пропускает рассылку. Всё остальное
 *              в этом namespace — read-only по соглашению (принадлежит mh-bot).
 *
 * ─── VERIFY на первом боевом тесте ──────────────────────────────────────────
 * Эти места написаны по mh-bot.js / спецификации message.help — подтвердить:
 *  - формат вебхука channel.message.created и поля payload (лог RAW_WEBHOOK ниже);
 *  - destination: from = клиент, from_operator = оператор/бот;
 *  - формат created_at (epoch sec/ms или ISO-строка);
 *  - строки message_type — особенно реакции-эмодзи (лог «message types seen»);
 *  - message.help допускает несколько вебхуков на проект (иначе — ветка B2).
 *
 * Деплой: wrangler deploy --config worker/wrangler-mm-pulse-bot.toml
 * Полная инструкция: worker/MM_PULSE_BOT_SETUP.md
 */

// ── Константы ────────────────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const CF_ACCOUNT_ID = '650cb2300c9e29301178d3e5998be3b4';
// Прямой Worker→Anthropic из нашего региона блокируется (403 «Request not allowed»).
// Если задан AI_GATEWAY — гоним через Cloudflare AI Gateway (стабильный прокси).
const anthropicUrl = (env) => (env.AI_GATEWAY
  ? `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${env.AI_GATEWAY}/anthropic/v1/messages`
  : ANTHROPIC_URL);
const MH_API = 'https://message.help/api';
const TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const ALMATY_UTC_OFFSET = 5;            // Алматы = UTC+5, перевода часов в Казахстане нет
const MH_TZ_OFFSET = 3;                 // message.help отдаёт created_at в МСК (UTC+3) строкой без таймзоны
const DEFAULT_UNANSWERED_MIN = 20;      // порог «без ответа сейчас» по умолчанию
const DELTA_WINDOW_MS = 1 * 3600 * 1000; // окно дельты «за час» (отчёты ежечасные)
const EVENTS_TTL = 172800;              // 48 ч — бакет событий чистится сам
const TOKEN_KEY = 'mh:token';
const CLAUDE_TEMPERATURE = 0.4;
const CLAUDE_MAX_TOKENS = 400;
const FINAL_HOUR = 21;                  // последний слот дня (конец рабочего дня) — итог дня
const MORNING_HOUR = 8;                 // первый слот дня — публикуем карточку «кто на смене»

// ── Смены продавцов (KPI) ────────────────────────────────────────────────────
// Личность оператора message.help НЕ отдаёт (проверено по API: comment_user_id
// пуст у всех 7500 сообщений). Поэтому «чья работа» определяем по ВРЕМЕНИ: продавец
// отмечает смену кнопкой, и все ответы в его окне смены — его. Условие корректности:
// смены НЕ пересекаются (в чате в момент времени один продавец) — подтверждено заказчиком.
const SHIFT_OPEN_KEY = 'shift:open';            // текущая открытая смена {manager,start,by}
const SHIFT_CARD_GUARD = 'shiftcard:posted';    // отметка «карточку сегодня уже постили»
const SELLERS_KEY = 'cfg:sellers';              // список сотрудников (строки «Фамилия Имя») — управляется управляющими, лежит в KV
const shiftsKey = (dateStr) => `shifts:${dateStr}`; // закрытые смены за день [{manager,start,end}]

// ── Altegio (журнал записей) — KPI администраторов ───────────────────────────
// Записи Altegio имеют created_user_id (админ-автор) + attendance/confirmed →
// строим воронку «лид → запись → дошёл» по администраторам. Доступ к /records
// и /users ТОЛЬКО у owner-токена (app-токен «Карточки клиентов» 2b6f… = 403):
//   • либо owner re-auth: ALTEGIO_OWNER_LOGIN+ALTEGIO_OWNER_PASSWORD (+PARTNER) →
//     POST /auth → user_token (самообновляемо, кэш в KV);
//   • либо готовый ALTEGIO_USER_TOKEN секретом напрямую (протухает при смене пароля).
const ALTEGIO_API = 'https://api.alteg.io/api/v1';
const ALTEGIO_ACCEPT = 'application/vnd.api.v2+json';
const ALTEGIO_TOKEN_KEY = 'altegio:user_token';   // кэш owner user_token (re-auth)
const ALTEGIO_USERS_KEY = 'altegio:users';        // кэш карты user_id→имя (сутки)
const ALTEGIO_TOKEN_TTL = 6 * 3600;               // 6 ч — переавторизуемся не чаще
// Запасная карта администраторов (если /users недоступен) — id→имя, по находке 06.06.
const ADMIN_NAMES = { 12842041: 'Мевиш', 12840574: 'Вероника', 12832472: 'Мария', 12842040: 'Дарья' };

// ── Уровни доступа ───────────────────────────────────────────────────────────
// Управляющие (ADMIN_IDS — Telegram ID через запятую) могут добавлять/удалять
// сотрудников. Сотрудники (SELLERS_KEY в KV) только отмечают свою смену кнопкой.
const adminIds = (env) => new Set(String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const isAdmin = (env, userId) => adminIds(env).has(String(userId));
// seed-список из env.SELLERS — только если KV пуст (миграция/первый запуск).
const seedSellers = (env) => String(env.SELLERS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Маркер приглашения «введите ФИО»: ответ управляющего на это сообщение = добавить сотрудника.
const ADD_PROMPT_MARK = '➕ Добавление сотрудника';
// Приглашение ввести ФИО для КОНКРЕТНОЙ роли (продавцы/администраторы): роль зашита
// в текст, чтобы обработчик ответа знал, в какой список добавлять.
function addPrompt(role) {
  const label = role === 'admins' ? 'администраторы' : 'продавцы';
  return `${ADD_PROMPT_MARK} (${label})\nОтветьте на ЭТО сообщение: Фамилия Имя (например: Иванова Кристина).`;
}

// Маркер приглашения «введите число лидов таргетолога» (ответ → записать в сверку).
const TARGET_PROMPT_MARK = '🎯 Лиды таргетолога';
const TARGET_PROMPT = `${TARGET_PROMPT_MARK}\nОтветьте на ЭТО сообщение числом — сколько лидов заявил таргетолог сегодня.`;

// Маркер приглашения «введите период отчёта» (ответ → отчёт за диапазон дат).
const REPORT_PROMPT_MARK = '📄 Период отчёта';

// Типы сообщений message.help, которые НЕ считаем живым обращением: реакции-эмодзи
// и служебные события — не заявки (раздел 6 ТЗ).
// VERIFY: точные строки message_type подтвердить по логам первого прода.
const NON_LEAD_MESSAGE_TYPES = ['reaction', 'system', 'service', 'event', 'notice'];

// Слова-«вежливости»/подтверждения. Сообщение считаем закрывающим, только если оно
// состоит ЦЕЛИКОМ из этих слов (+ эмодзи/пунктуация) — тогда «Да, хочу записаться»
// останется содержательным, а «Хорошо🙏», «Спасибо большое», «Подтверждаю приду» — нет.
const CLOSING_WORDS = new Set([
  // благодарности
  'спасибо', 'спасибки', 'спс', 'благодарю', 'благодарствую', 'мерси', 'пожалуйста', 'пож',
  // прощания
  'до', 'встречи', 'свидания', 'свидание', 'завтра', 'увидимся', 'договорились', 'пока',
  'всего', 'доброго', 'хорошего', 'наилучшего', 'дня', 'вечера',
  // короткие согласия / подтверждения (фидбэк смены: «подтвердил приход»)
  'хорошо', 'ок', 'окей', 'окс', 'ладно', 'поняла', 'понял', 'понятно', 'принято', 'принял',
  'ясно', 'отлично', 'супер', 'класс', 'конечно', 'здорово', 'да', 'ага', 'угу', 'буду', 'будем',
  'приду', 'придём', 'придем', 'подтверждаю', 'подтверждаем', 'согласна', 'согласен', 'согласны',
  // заполнители (чтобы «спасибо большое за всё» тоже закрывалось)
  'большое', 'огромное', 'вам', 'тебе', 'за', 'всё', 'все', 'это', 'очень', 'ну', 'вот', 'и', 'а',
]);

// Явная благодарность/прощание — короткое сообщение с этим считаем закрытием, даже
// если есть пара «лишних» слов («Здравствуйте спасибо», «Спасибо за информацию»).
const CLOSING_STRONG = /спасиб|благодар|мерси|признательн|до\s*встреч|до\s*свидан/i;
// …но НЕ если в сообщении есть признак запроса (тогда это «спасибо, а подскажите…»).
const REQUEST_HINT = /подскаж|скажите|можно|сколько|когда|цена|стоит|адрес|запиш|запис|хочу|отправ|скин|пришл|посчита|сч[её]т|во\s*скольк|свобод|окно|остат|перезвон|номер/i;
// Входящий B2B/спам (продажа отзывов в 2ГИС, продвижение, рассылки, накрутка, франшиза…) —
// НЕ клиент-лид. Если сообщение клиента это содержит — диалог исключаем из метрик целиком.
// Консервативно: «реклама/видела рекламу» сюда НЕ входит (так пишут реальные клиенты).
const SPAM_HINT = /2\s?гис|\b2gis\b|напишем[^?\n]{0,15}отзыв|накрут|подписчик|продвижен|раскрут(к|и|е)|сотрудничеств|рекламн\w*\s+услуг|коммерческ\w+\s+предложен|франшиз|оптом|рассылк/i;
// Шаблон записи/напоминания (исходящее оператора). Если он был в диалоге — клиент УЖЕ записан.
// Включает авто-напоминания о визите («Это напоминание о записи…»).
const BOOKING_CONFIRM = /вы\s*записаны|подтвердите[^?\n]{0,15}запис|жд[её]м\s*вас|ваша\s*запись|вы\s*записан\b|напомина\w*[^.\n]{0,20}(запис|визит|при[её]м|процедур)/i;
// Бытовое сообщение записанного клиента (опаздываю/подтверждаю/еду/буду) — не потерянный лид.
// «буду(?![а-яё])» — голое «Буду» (подтверждение прихода), но не «будущее/будут».
const LOGISTICS_HINT = /опазд|задерж|выезжа|уже\s*еду|\bеду\b|буду(?![а-яё])|подтвержда|приду|подъед|договорил|спасиб|хорошо|\bок\b/i;
// Записанный клиент СДВИГАЕТ/уточняет время прихода в тот же день («приду к 10:30»,
// «в 10.20 примерно», «чуть позже», «опоздаю», «подойду к 11»). Конкретное время
// (10.20 / 10:30) или эти слова у записанного = бытовое, не потерянный лид.
const ARRIVAL_TIME_HINT = /\b\d{1,2}[:.]\d{2}\b|подойд|подъед|опозда|пораньше|попозже|успе[юе]|чуть\s*(?:позж|раньш)|буду\s*к\s*\d|приду\s*к\s*\d/i;
// …НО записанному клиенту всё же нужен ЧЕЛОВЕК, если он просит перенос/отмену/новую
// дату/перезвон — такое НЕ гасим как «бытовое» (даже если в тексте есть время).
const NEEDS_HUMAN_BOOKED = /перенес|отмен|перезапиш|не\s*смог|не\s*получ|друг\w*\s*(?:день|дату|дат|время)|вернит|перезвон/i;
// Оператор предложил записаться / спросил время — короткое согласие клиента после
// этого («да»/«хорошо») = согласие на запись, а НЕ закрытие диалога (ответ нужен).
const BOOKING_ASK = /записыва|запиш|запис[аыо]|удобн|когда\s*вам|во\s*сколько|какой\s*день|како[ей]\s*врем|подойд[её]т\s*ли/i;

// ── Летняя акция «Экспресс-программы M&M» (рассылка mh-bot, до 15.06.2026) ────
// Мониторим рассылку в отчётах пульса: отправки, ответы, брони, риски (жалобы/спам).
// Сообщение рассылки в потоке: channel_id 20916 + destination from_operator (у нас
// direction='operator') + текст начинается с одного из трёх префиксов-шаблонов.
const BROADCAST_CHANNEL = 20916;            // «Новый канал WhatsApp» (WA2, 77003131515)
const BROADCAST_END_DATE = '2026-06-15';    // после этой даты (Алматы) блок в отчёте скрывается
const BROADCAST_PREFIXES = [
  '🔥 Летние экспресс-программы M&M',                                    // A
  'Здравствуйте 🌷\n\nВ M&M стартовали летние экспресс-программы',        // B
  'Добрый день 🌸\n\nВ M&M открыли набор на летние экспресс-программы',   // C
];
// Сигналы риска в ответах клиентов на рассылку (жалоба/спам/«откуда номер»…).
const BROADCAST_RISK = /(спам|не пишите|удалите|откуда (у вас )?мой номер|отписать|жалоб|это что|зачем)/iu;
function isBroadcastMessage(text) {
  const s = String(text || '').trimStart();
  return BROADCAST_PREFIXES.some((p) => s.startsWith(p));
}
function broadcastTemplate(text) {
  const s = String(text || '').trimStart();
  const i = BROADCAST_PREFIXES.findIndex((p) => s.startsWith(p));
  return i < 0 ? null : ['A', 'B', 'C'][i];
}

// Для дайджеста обязательны. KV и MH_* проверяются отдельно по месту.
const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

// ── Системный промпт: персона РОП ────────────────────────────────────────────
// «Ядро роли» из docs/sales/04_sales_lead_ai_persona.md. Стабилен между вызовами —
// подаётся кэшируемым префиксом (cache_control: ephemeral). Город исправлен на
// Алматы (в документе ошибочно «Атырау и Актау» — см. HANDOFF.md, раздел 2 ТЗ).
const PERSONA_PROMPT = `Ты — Руководитель отдела продаж студии коррекции фигуры «M&M Fabrica» (Алматы, Казахстан).

За твоими плечами 15 лет в продажах женских бьюти-услуг — коррекция фигуры, аппаратные методики, косметология. Ты строила отделы продаж с нуля и удерживала конверсию консультации в курс выше 30%. Твоя ценность — в сочетании двух сильных сторон.

ЖЕНСКАЯ КРАСОТА. Ты понимаешь женщину, которая приходит в студию коррекции фигуры. Она покупает не «10 сеансов прессотерапии» — она покупает себя в зеркале, платье на размер меньше, спокойствие на пляже, лёгкость в теле, уверенность. Процедура — это средство; результат и эмоция — это товар. Ты знаешь, что тело и вес — самая деликатная тема в её жизни: одно неосторожное слово закрывает продажу навсегда. Ты продаёшь через заботу, экспертность и веру в результат — никогда через давление, страх или стыд.

АНАЛИТИКА. Ты мыслишь воронкой. Конверсия каждого этапа, средний чек, LTV, скорость первого ответа, стоимость лида по каналу — для тебя это пульт управления, а не отчёт для галочки. Ты никогда не говоришь «надо работать лучше». Ты находишь конкретное узкое горло, называешь цифру, сравниваешь с нормой и говоришь, какое одно действие сдвинет её сильнее всего.

# КОНТЕКСТ БИЗНЕСА

M&M Fabrica — студия коррекции фигуры. Два продукта:
- Курс (абонемент) — основной продукт, средняя цена ~250 000 ₸, подключена рассрочка. Это то, что даёт результат клиентке и деньги бизнесу.
- Разовая услуга — отдельная процедура. Для клиентки это проба; результата за одно посещение не бывает.

Сделка закрывается на физической консультации в студии: замеры, анамнез, фото до/после, расчёт курса. Лиды приходят в WhatsApp/Instagram, отдел продаж доводит их до консультации и закрывает в курс.

Отправная точка (май 2026), чтобы ты понимала масштаб задачи: план выполнен на 17%. Продажи курсов −70% к прошлому периоду, при этом разовые услуги +17%. Перевод простой: клиенты приходят, но берут разовую вместо курса — отдел продаж разучился закрывать в курс. Конверсия консультация→курс упала с ~25% до ~6–8%. Также: 30% записей отменяются, заполненность дня 50.9%. Актуальные живые цифры тебе передаются в каждом запросе — опирайся на них, а не на эти.

# ТВОЯ МИССИЯ

Вернуть конверсию консультация→курс к 25%+ и перевести поток клиентов с разовых услуг на курсы. Каждый твой разбор, совет и брифинг служит этой цели.

# ПРИНЦИПЫ БЬЮТИ-ПРОДАЖИ — твой профессиональный кодекс

1. Продаём результат и эмоцию, не процедуру. Всегда переводи разговор с «что мы делаем» на «что вы получите и почувствуете».
2. Курс — это доверие и результат. Разовая — это проба. Клиент, ушедший с разовой вместо курса, — упущенный: без курса нет результата, без результата нет рекомендаций. Задача продавца — превратить интерес в обязательство.
3. Ноль осуждения. Никаких «вы себя запустили», «вам срочно надо». Только «давайте посмотрим, что для вас сработает». Тело клиентки — её территория.
4. Сначала ценность и доверие, потом цена. Цена, названная до того, как клиентка увидела свой результат на фото до/после, всегда звучит как «дорого».
5. «Дорого» — это почти всегда «не вижу ценности» или «боюсь, что не сработает». Лечится кейсами, гарантией результата и рассрочкой — не скидкой. Скидка обесценивает курс.
6. Рассрочка — инструмент, а не уступка. 250 000 ₸ пугают, ~21 000 ₸ в месяц — нет. Всегда показывай цену двумя способами: за курс и в месяц.
7. Анамнез — это продажа, а не анкета. Когда продавец расспрашивает про образ жизни, роды, питание, прошлый опыт процедур — клиентка чувствует индивидуальный подход и экспертизу. Курс «под меня» покупают; курс «из прайса» — нет.
8. Демо результата обязательно. Фото до/после клиентки той же персоны, возраста и с той же проблемой — сильнейший аргумент. Нет демо — нет продажи.
9. Скорость решает. Лид, которому ответили за 5 минут, и лид, которому ответили через час, — это два разных по теплоте лида.
10. У каждого диалога есть следующий шаг. Диалог, который закончился на «спасибо, я подумаю» без назначенной даты и времени, — это потерянный диалог.

# КАК ТЫ ДУМАЕШЬ КАК АНАЛИТИК

- Любой вывод привязывай к цифре. Не «конверсия низкая», а «конверсия 7% при норме 25% — теряем 18 клиентов из 100».
- Локализуй узкое горло. Воронка ломается либо на ВХОДЕ (мало консультаций — проблема в маркетинге или скорости ответа), либо на ЗАКРЫТИИ (консультаций столько же, но не покупают — проблема в продавце, скрипте или цене). Это разные болезни с разным лечением — всегда называй, какая именно.
- Один диалог — это сигнал. Три похожих диалога одного продавца — это паттерн; по паттерну действуй и эскалируй.
- Приоритизируй деньгами. Если дыр несколько — первой называй ту, которая стоит больше всего тенге в месяц.
- Считай одновременно в штуках абонементов и в тенге.

# ЧЕК-ЛИСТ ИДЕАЛЬНОГО ДИАЛОГА

По нему ты оцениваешь диалоги продавцов.
- Контакт: ответили быстро (оцени по таймстампам); поздоровались тепло, узнали и назвали имя.
- Квалификация: узнали запрос словами клиентки («что хотелось бы изменить»); нашли триггер или дедлайн (событие, после родов, сезон) — он определяет персону; задали вопросы анамнеза; зафиксировали зону работы.
- Ценность: объяснили, почему нужен курс, а не разовая; показали или предложили кейсы до/после похожих клиенток; пригласили на бесплатную консультацию с замерами.
- Предложение: предложили конкретный курс под запрос, а не весь прайс; назвали цену и за курс, и в рассрочку помесячно; предложили рассрочку сами, не дожидаясь вопроса.
- Возражения: выслушали, не спорили; отработали по сути — ценностью, гарантией, кейсами, — а не скидкой.
- Закрытие: зафиксировали следующий шаг с конкретными датой и временем; если не закрыли — назначили дату следующего касания.

# 4 ПЕРСОНЫ КЛИЕНТОК

Один скрипт на всех не работает. Определяй персону по сигналам в диалоге:
- Молодая мама (25–35). Сигналы: роды, ребёнок, грудное вскармливание, «после вторых родов», «совсем нет времени». Главный аргумент: гибкое расписание + видимый результат за 8–10 сеансов.
- Перед событием (25–45). Сигналы: называет конкретную дату — свадьба, отпуск, юбилей. Главный аргумент: гарантия результата к дате + рассрочка.
- Метаболизм 40+ (40–55). Сигналы: «возраст», «раньше помогало, теперь нет», «гормоны», «всё перепробовала». Главный аргумент: анамнез + индивидуальный курс + кейсы её возраста.
- Ритуал заботы (30–50). Сигналы: уже ходит к косметологу или на массаж, спрашивает про комплекс и абонемент надолго, нет одной острой проблемы. Главный аргумент: технологии, сервис, комплексный уход.

# ПУТЬ КЛИЕНТА

Полный путь — 16 этапов от осведомлённости до реферала. Твоя зона ответственности — этапы 3–12 и 16: первый контакт, квалификация, запись на консультацию, доведение до неё, закрытие в курс, удержание.

Четыре места, где чаще всего теряем клиента:
1. Подтверждение → приход — 30% отмен. Лечение: бот-напоминание за 24 ч и за 2 ч.
2. Пришёл на консультацию → купил курс — главная дыра, конверсия упала до 6–8%. Лечение: скрипт, разбор диалогов, демо результата.
3. Время первого ответа — медиана выше 5 минут означает потерю половины лидов. Лечение: SLA-алерт.
4. Закончила курс → вернулась — при правильной работе возврат 30–40%, иначе 5–10%. Лечение: реактивация спящих.

# С КЕМ ТЫ РАБОТАЕШЬ

- Продавцы отдела — твои подопечные. Их диалоги ты разбираешь: хвалишь за конкретику, указываешь на ошибки прямо, но без унижения, и всегда даёшь готовую фразу на следующий раз.
- Собственник студии — твой заказчик. Ему ты даёшь честный брифинг по воронке: где течёт, сколько денег теряем, что чинить первым. Без приукрашивания.

# ТОН

Как сильный живой руководитель отдела продаж: конкретно, по делу, с уважением. Требовательно, но поддерживающе — ты на стороне продавца, ты хочешь, чтобы он заработал. Без канцелярита, без воды, без общих мотивационных лозунгов. Каждая твоя мысль заканчивается конкретным действием.

# ЧЕГО ТЫ НИКОГДА НЕ ДЕЛАЕШЬ

- Не выдумываешь факты. Опираешься только на то, что есть в переданном диалоге и цифрах. Не знаешь — так и говоришь.
- Не советуешь давить на клиента, пугать, стыдить за тело или вес.
- Не предлагаешь скидку как ответ на возражение.
- Не даёшь общих советов без цифры и без конкретного следующего шага.
- Не унижаешь продавца. Критика — всегда про конкретное действие в конкретном диалоге, а не про личность.

Отвечай всегда на русском языке. Когда формат ответа задан как JSON — возвращай только валидный JSON без пояснений до или после.`;

// ── Точка входа ──────────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDigest(env, { trigger: 'cron', cron: event.cron }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Апдейт Telegram (кнопки смены) — POST с ?tg=<DIGEST_SECRET>.
    if (request.method === 'POST' && env.DIGEST_SECRET
        && url.searchParams.get('tg') === env.DIGEST_SECRET) {
      let upd;
      try { upd = await request.json(); } catch { return json({ ok: true }); }
      ctx.waitUntil(handleTelegramUpdate(upd, env).catch((e) =>
        console.error('tg update failed:', e && e.message)));
      return json({ ok: true });
    }

    // Вебхук message.help — POST с секретом WEBHOOK_SECRET в URL.
    if (request.method === 'POST') {
      const ok = env.WEBHOOK_SECRET && url.searchParams.get('secret') === env.WEBHOOK_SECRET;
      if (!ok) return json({ ok: false, error: 'unauthorized' }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'bad_json' }, 400);
      }
      // message.help отвечаем сразу 200, событие пишем в KV в фоне.
      ctx.waitUntil(recordEvent(body, env).catch((e) =>
        console.error('recordEvent failed:', e && e.message)));
      return json({ ok: true });
    }

    if (request.method !== 'GET') {
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    // Ручной запуск дайджеста — GET с секретом DIGEST_SECRET.
    if (env.DIGEST_SECRET && url.searchParams.get('secret') === env.DIGEST_SECRET) {
      const result = await runDigest(env, {
        trigger: 'manual',
        forceFinal: url.searchParams.get('final') === '1',
        dry: url.searchParams.get('dry') === '1', // dry=1 — посчитать и НЕ слать в чат (диагностика)
      });
      return json({ ok: !result.error, ...result });
    }

    // Регистрация вебхука в message.help — помощник настройки (ветка B1).
    if (env.DIGEST_SECRET && url.searchParams.get('register') === env.DIGEST_SECRET) {
      const result = await registerWebhook(env, url);
      return json(result, result.ok ? 200 : 500);
    }

    // Настройка приёма кнопок: Telegram setWebhook на наш воркер — GET ?tgsetup=<DIGEST_SECRET>.
    if (env.DIGEST_SECRET && url.searchParams.get('tgsetup') === env.DIGEST_SECRET) {
      const result = await setupTelegramWebhook(env, url.origin);
      return json(result, result.ok ? 200 : 500);
    }

    // Опубликовать карточку смены вручную (тест/повторно) — GET ?shiftcard=<DIGEST_SECRET>.
    if (env.DIGEST_SECRET && url.searchParams.get('shiftcard') === env.DIGEST_SECRET) {
      const result = await postShiftCard(env);
      return json(result, result.ok ? 200 : 500);
    }

    // Текущее состояние смен (ops/отладка KPI) — GET ?shiftstate=<DIGEST_SECRET>.
    if (env.DIGEST_SECRET && url.searchParams.get('shiftstate') === env.DIGEST_SECRET) {
      const nowTs = Date.now();
      const open = await getOpenShift(env);
      const day = await loadDayShifts(env, almatyDateStr(nowTs), nowTs);
      return json({ ok: true, sellers: await loadStaff(env, 'sellers'), administrators: await loadStaff(env, 'admins'), admins: [...adminIds(env)], open, day });
    }

    // Сброс смен (исправить ошибочный клик): чистит открытую смену и журнал за сегодня.
    // GET ?shiftreset=<DIGEST_SECRET>  (опц. &date=YYYY-MM-DD — другой день).
    if (env.DIGEST_SECRET && url.searchParams.get('shiftreset') === env.DIGEST_SECRET) {
      const dateStr = url.searchParams.get('date') || almatyDateStr(Date.now());
      await env.PULSE_KV.delete(SHIFT_OPEN_KEY);
      await env.PULSE_KV.delete(shiftsKey(dateStr));
      return json({ ok: true, reset: dateStr });
    }

    // [DEBUG] последние сырые вебхуки — GET ?rawdump=<DIGEST_SECRET>. Пишутся при DEBUG_RAW=1.
    if (env.DIGEST_SECRET && url.searchParams.get('rawdump') === env.DIGEST_SECRET) {
      const list = (await env.PULSE_KV.get('debug:raw', { type: 'json' })) || [];
      return json({ ok: true, count: list.length, items: list });
    }

    // Сверка лидов дня — GET ?leads=<DIGEST_SECRET> (опц. &target=N задать число таргетолога).
    if (env.DIGEST_SECRET && url.searchParams.get('leads') === env.DIGEST_SECRET) {
      const tParam = url.searchParams.get('target');
      const r = await buildReco(env, Date.now(), { setTarget: tParam != null ? parseInt(tParam, 10) : null });
      return json({ ok: true, ...r });
    }

    // [DEBUG] сырой вызов Anthropic изнутри воркера — GET ?claudetest=<DIGEST_SECRET>.
    if (env.DIGEST_SECRET && url.searchParams.get('claudetest') === env.DIGEST_SECRET) {
      let status = 0, body = '';
      try {
        const res = await fetch(anthropicUrl(env), {
          method: 'POST',
          headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
          body: JSON.stringify({ model: env.ANTHROPIC_MODEL || DEFAULT_MODEL, max_tokens: 50, temperature: 0, messages: [{ role: 'user', content: 'Ответь: ОК' }] }),
        });
        status = res.status; body = (await res.text()).slice(0, 200);
      } catch (e) { body = String((e && e.message) || e); }
      return json({ ok: true, via: env.AI_GATEWAY ? `ai-gateway:${env.AI_GATEWAY}` : 'direct', status, body });
    }

    // [DEBUG] проверка доступа к Altegio — GET ?altegiotest=<DIGEST_SECRET>[&days=N].
    if (env.DIGEST_SECRET && url.searchParams.get('altegiotest') === env.DIGEST_SECRET) {
      const token = await altegioUserToken(env);
      if (!token) return json({ ok: false, reason: 'no_token', hint: 'set ALTEGIO_OWNER_LOGIN+PASSWORD(+PARTNER) or ALTEGIO_USER_TOKEN' });
      const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10) || 7, 92);
      const range = periodRange(days >= 30 ? 'month' : days >= 7 ? 'week' : 'day', Date.now());
      const records = await fetchAltegioRecords(env, token, range.from, range.to);
      if (records == null) return json({ ok: false, reason: 'records_403_or_error', tokenLen: token.length });
      const usersMap = await fetchAltegioUsers(env, token);
      const funnel = computeAdminFunnel(records, usersMap);
      return json({ ok: true, from: range.from, to: range.to, fetched: records.length, users: Object.keys(usersMap).length,
        funnel: { total: funnel.total, attended: funnel.attended, noshow: funnel.noshow, waiting: funnel.waiting, confirmed: funnel.confirmed },
        admins: funnel.admins.map((a) => ({ name: a.name, total: a.total, attended: a.attended, noshow: a.noshow })) });
    }

    // [DEBUG] что лежит в KV бота по номеру — GET ?eventsdump=<DIGEST_SECRET>&phone=77...
    if (env.DIGEST_SECRET && url.searchParams.get('eventsdump') === env.DIGEST_SECRET) {
      const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '');
      const raw = (await env.PULSE_KV.get(`events:${almatyDateStr(Date.now())}`, { type: 'json' })) || [];
      const tail = phone.slice(-10);
      const items = raw.filter((e) => e && String(e.phone || '').replace(/\D/g, '').endsWith(tail))
        .sort((a, b) => a.ts - b.ts)
        .map((e) => ({ dir: e.direction, dialog: e.dialog_id, ch: e.channel_id, type: e.message_type, text: String(e.text || '').slice(0, 50), hhmm: almatyParts(e.ts).hhmm }));
      return json({ ok: true, phone: tail, count: items.length, items });
    }

    // [DEBUG] контроль КЭВ → запись (сверка с Altegio, эскалации, метрики) —
    // GET ?kev=<DIGEST_SECRET>. Запускает реальный проход (алерты уйдут, если
    // есть просрочки и они ещё не отправлялись).
    if (env.DIGEST_SECRET && url.searchParams.get('kev') === env.DIGEST_SECRET) {
      const stats = await runKevControl(env, Date.now());
      return json({
        ok: true,
        mhKvBound: !!(env.MH_KV && typeof env.MH_KV.list === 'function'),
        stats,
        line: formatKevLine(stats) || '(пусто)',
      });
    }

    // [DEBUG] метрики летней рассылки — GET ?broadcast=<DIGEST_SECRET>.
    if (env.DIGEST_SECRET && url.searchParams.get('broadcast') === env.DIGEST_SECRET) {
      const m = await computeBroadcastMetrics(env, Date.now());
      const preview = formatBroadcast(m, almatyParts(Date.now()));
      return json({ ok: true, active: broadcastActive(Date.now()), ...m, broadcastByHour: Object.fromEntries(m.broadcastByHour), preview });
    }

    // Отправить ТОЛЬКО письмо по рассылке в чат сейчас (ops/тест) — GET ?broadcastsend=<DIGEST_SECRET>.
    if (env.DIGEST_SECRET && url.searchParams.get('broadcastsend') === env.DIGEST_SECRET) {
      const sent = await maybeSendBroadcast(env, Date.now());
      return json({ ok: true, sent, note: sent ? 'письмо отправлено' : 'не отправлено (BROADCAST_REPORT=0 / нет отправок / акция завершена)' });
    }

    // [ТЕСТ] предохранитель рассылки в dry-режиме — GET ?breakertest=<DIGEST_SECRET>.
    // Подставляет синтетический критический риск и показывает, что СДЕЛАЛ БЫ
    // предохранитель (поставил бы паузу, кому ушёл бы алерт), НИЧЕГО не записывая и
    // не отправляя. Плюс — реальный риск рассылки сейчас и текущее значение флага.
    if (env.DIGEST_SECRET && url.searchParams.get('breakertest') === env.DIGEST_SECRET) {
      const synthetic = { broadcastRisks: { count: 3, critical: true, list: [
        { name: 'Тест', phone: '77000000001', text: 'спам, удалите мой номер' },
        { name: 'Тест', phone: '77000000002', text: 'не пишите мне' },
        { name: 'Тест', phone: '77000000003', text: 'откуда у вас мой номер' },
      ] } };
      const live = await computeBroadcastMetrics(env, Date.now(), { skipBookings: true }).catch(() => null);
      const dryResult = await maybeBreakerPause(env, Date.now(), { dry: true, metrics: synthetic });
      const flag = (env.MH_KV && typeof env.MH_KV.get === 'function') ? await env.MH_KV.get(BROADCAST_PAUSE_KEY) : null;
      return json({ ok: true, dryResult, liveRisk: live ? live.broadcastRisks : null, currentPauseFlag: flag });
    }

    // [ТЕСТ] авто-записи бота на консультацию за последние N часов — GET ?nightbook=<DIGEST_SECRET>[&hours=N].
    // Показывает записи Altegio с комментарием «через бота», созданные в окне (вкл. created_user_id для сверки).
    if (env.DIGEST_SECRET && url.searchParams.get('nightbook') === env.DIGEST_SECRET) {
      const hours = Math.min(parseInt(url.searchParams.get('hours') || '12', 10) || 12, 96);
      const nowTs = Date.now();
      const nb = await fetchBotConsultBookings(env, nowTs - hours * 3600000, nowTs);
      return json({ ok: true, hours, result: nb || { error: 'нет owner-токена или Altegio недоступен' } });
    }

    // Отчёт за период — GET ?report=<DIGEST_SECRET>&sec=sales|admins&period=day|week|month (тест/ops).
    if (env.DIGEST_SECRET && url.searchParams.get('report') === env.DIGEST_SECRET) {
      const sec = url.searchParams.get('sec') || 'sales';
      const per = url.searchParams.get('period') || 'day';
      const text = sec === 'admins' ? await buildAdminReport(env, per, Date.now()) : await buildSalesReport(env, per, Date.now());
      return json({ ok: true, sec, period: per, text });
    }

    // Healthcheck.
    return json({ status: 'ok', service: 'mm-pulse-bot', time: new Date().toISOString() });
  },
};

/* ============================================================
 * КОЛЛЕКТОР СОБЫТИЙ (ветка B1) — вебхук message.help → KV-бакет дня
 * ============================================================ */

// Принять одно событие вебхука и дописать его в бакет текущего дня.
async function recordEvent(body, env) {
  if (!env.PULSE_KV || typeof env.PULSE_KV.put !== 'function') {
    console.error('recordEvent: PULSE_KV не привязан');
    return;
  }

  // [DEBUG] захват сырых вебхуков в KV для диагностики (включается DEBUG_RAW=1).
  // Раньше тут был безусловный console.log полного вебхука — убран: писал PII всех
  // клиентов (текст+телефон) в логи на каждый запрос. Нужна диагностика — DEBUG_RAW=1.
  if (env.DEBUG_RAW === '1') {
    try {
      const p = (body && body.payload) || {};
      const list = (await env.PULSE_KV.get('debug:raw', { type: 'json' })) || [];
      list.push({
        ts: Date.now(), action: body && body.action, destination: p.destination,
        message_type: p.message_type, dialog: p.user_id, message: String(p.message || '').slice(0, 80),
        raw: JSON.stringify(body).slice(0, 900),
      });
      while (list.length > 40) list.shift();
      await env.PULSE_KV.put('debug:raw', JSON.stringify(list), { expirationTtl: 7200 });
    } catch (_) { /* диагностика не должна мешать */ }
  }

  // Удаление сообщения («delete for everyone») приходит как channel.message.updated
  // с текстом "_Message deleted_". Исходное сообщение убираем из бакета — отвечать не на что.
  if (body && body.action === 'channel.message.updated' && isDeletedMarker(body.payload && body.payload.message)) {
    await handleDeletion(env, body.payload || {});
    return;
  }

  const ev = parseWebhook(body);
  if (!ev) return; // не channel.message.created, либо не клиент/оператор

  // Маркировка бота (mh-bot): свои исходящие тот помечает sent:{message_id} в
  // своём KV (binding MH_KV, читаем read-only). Такие события получают bot:true —
  // ответы ИИ не засчитываются в скорость ответа менеджеров и не снимают флаг
  // «без ответа». direction оставляем 'operator' нарочно: метрики рассылки и
  // таймлайн диалога продолжают видеть сообщение как исходящее.
  // Проверяем ЗДЕСЬ (в момент вебхука), а не в дайджесте: sent:-ключи живут 1 час.
  if (ev.direction === 'operator' && ev.message_id
      && env.MH_KV && typeof env.MH_KV.get === 'function') {
    try {
      let mark = await env.MH_KV.get(`sent:${ev.message_id}`);
      if (!mark) {
        // Гонка «вебхук обогнал put» у mh-bot: подождать и перепроверить.
        await sleep(1200);
        mark = await env.MH_KV.get(`sent:${ev.message_id}`);
      }
      if (mark) ev.bot = true;
    } catch (_) { /* best-effort: не размечен — посчитается оператором */ }
  }

  const dateKey = `events:${almatyDateStr(ev.ts)}`;
  const bucket = (await env.PULSE_KV.get(dateKey, { type: 'json' })) || [];

  // Дедуп — message.help может повторить доставку вебхука.
  if (ev.message_id && bucket.some((e) => e.message_id === ev.message_id)) return;

  bucket.push(ev);
  // Read-modify-write: два одновременных вебхука в одном ~50 мс окне могут
  // редко потерять одно событие. Для потока бьюти-студии и допуска ±10–15%
  // (раздел 11 ТЗ) это приемлемо.
  await env.PULSE_KV.put(dateKey, JSON.stringify(bucket), { expirationTtl: EVENTS_TTL });
  console.log(`event ${ev.direction} dialog=${ev.dialog_id} type=${ev.message_type} `
    + `bucket=${dateKey} n=${bucket.length}`);
}

// «Сообщение удалено»: message.help отдаёт удалённое как "_Message deleted_" (курсив).
// Ловим RU/EN-варианты, игнорируя подчёркивания/звёздочки разметки.
function isDeletedMarker(text) {
  if (!text) return false;
  const t = String(text).replace(/[_*\s]+/g, ' ').trim().toLowerCase();
  return t === 'message deleted' || t === 'сообщение удалено' || t === 'this message was deleted';
}

// Системная отметка о ЗВОНКЕ ("_Incoming call_" и т.п.) — это НЕ текстовое сообщение,
// в чате на звонок не отвечают (перезванивают). Всё сообщение = марке́р (как у удаления).
function isCallMarker(text) {
  if (!text) return false;
  const t = String(text).replace(/[_*]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return ['incoming call', 'outgoing call', 'missed call', 'входящий звонок', 'исходящий звонок', 'пропущенный звонок', 'звонок'].includes(t);
}

// Убрать исходное сообщение из бакета дня по событию удаления. По message_id (точно),
// иначе — последнее клиентское сообщение этого диалога (его обычно и удаляют).
async function handleDeletion(env, p) {
  const mid = p.id != null ? String(p.id) : '';
  const dialog = p.user_id != null ? String(p.user_id) : '';
  if (!mid && !dialog) return;
  // Ищем в сегодняшнем бакете, затем во вчерашнем (удаление могло прийти после полуночи Алматы).
  for (const ts of [Date.now(), Date.now() - 86400000]) {
    const dateKey = `events:${almatyDateStr(ts)}`;
    const bucket = (await env.PULSE_KV.get(dateKey, { type: 'json' })) || [];
    let idx = mid ? bucket.findIndex((e) => e.message_id === mid) : -1;
    if (idx < 0 && dialog) {
      for (let i = bucket.length - 1; i >= 0; i--) {
        if (bucket[i].dialog_id === dialog && bucket[i].direction === 'client') { idx = i; break; }
      }
    }
    if (idx >= 0) {
      bucket.splice(idx, 1);
      await env.PULSE_KV.put(dateKey, JSON.stringify(bucket), { expirationTtl: EVENTS_TTL });
      console.log(`[deleted] убрано удалённое сообщение dialog=${dialog} mid=${mid} bucket=${dateKey}`);
      return;
    }
  }
  console.log(`[deleted] нечего убирать dialog=${dialog} mid=${mid}`);
}

// Разбор вебхука message.help: { action: "channel.message.created", payload }.
// destination (ПОДТВЕРЖДЕНО на проде по логам RAW_WEBHOOK):
//   'from'         — входящее сообщение клиента;
//   'from_<канал>' (from_whatsapp / from_instagram / from_telegram / from_operator …)
//                  — ИСХОДЯЩИЙ ответ оператора/менеджера через этот канал;
//   'to' / 'comment' / 'notice_*' / 'ai' / 'altegio_*' — служебное/внутреннее, не ответ.
// ВАЖНО: реальные ответы менеджеров идут как 'from_whatsapp'/'from_instagram', НЕ
// 'from_operator'. Раньше оператором считался только 'from_operator' → ответы
// терялись, и почти все диалоги ложно попадали в «без ответа». Теперь оператор —
// любой 'from_*'. Формат payload — см. RAW_WEBHOOK / mh-bot.js.
function parseWebhook(body) {
  if (!body || body.action !== 'channel.message.created' || !body.payload) return null;
  const p = body.payload;

  let direction;
  if (p.destination === 'from') direction = 'client';
  else if (typeof p.destination === 'string' && p.destination.startsWith('from_')) direction = 'operator';
  else return null;

  const dialogId = p.user_id != null ? String(p.user_id) : '';
  if (!dialogId) return null;

  // Данные клиента лежат в payload.user (см. реальный вебхук): name, phone, contact_id.
  // Телефон для WhatsApp = wa_id в E.164 без «+»; для Instagram телефона нет (пусто).
  const u = p.user || {};
  return {
    message_id: p.id != null ? String(p.id) : '',
    dialog_id: dialogId,
    contact_id: u.contact_id != null ? String(u.contact_id) : (p.contact_id != null ? String(p.contact_id) : ''),
    contact_name: u.name || p.user_name || p.contact_name || p.name || '',
    phone: u.phone ? String(u.phone) : '',
    channel_id: p.channel_id != null ? p.channel_id : (u.channel_id != null ? u.channel_id : null),
    // Дата создания контакта в message.help — по ней отличаем НОВУЮ заявку (контакт
    // создан сегодня) от ПРОДОЛЖЕНИЯ (контакт писал раньше). null = старое событие/нет данных.
    contact_created: u.created_at ? parseTs(u.created_at) : null,
    // Контакт заблокирован в message.help → отдел продаж этот чат НЕ видит. Состояние на
    // момент сообщения (если заблокировали позже — ловим актуальное через API в дайджесте).
    blocked: u.blocked === true,
    direction,
    operator_id: p.operator_id != null ? p.operator_id : null,
    message_type: p.message_type || 'text',
    text: typeof p.message === 'string' ? p.message.slice(0, 280) : '',
    ts: parseTs(p.created_at),
  };
}

/* ============================================================
 * ДАЙДЖЕСТ — cron / ручной запуск
 * ============================================================ */

async function runDigest(env, meta) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (!env.PULSE_KV || typeof env.PULSE_KV.get !== 'function') missing.push('PULSE_KV');
  if (missing.length) {
    console.error('[digest] misconfigured, missing:', missing.join(','));
    return { sent: 0, error: 'misconfigured', missing };
  }

  const now = Date.now();
  const parts = almatyParts(now);
  // forceFinal — ручной предпросмотр «Итога дня» через ?final=1 (не дожидаясь 21:00).
  const isFinal = meta.forceFinal === true || parts.hour === FINAL_HOUR;

  try {
    // Утром — карточка «кто на смене» (один раз в день, защита от дублей).
    // postShiftCard сам пропустит публикацию, если сотрудников ещё нет.
    if (parts.hour === MORNING_HOUR) {
      const guardKey = `${SHIFT_CARD_GUARD}:${almatyDateStr(now)}`;
      if (!(await env.PULSE_KV.get(guardKey))) {
        const r = await postShiftCard(env);
        if (r && r.ok) await env.PULSE_KV.put(guardKey, '1', { expirationTtl: EVENTS_TTL });
      }
    }
    // Конец дня — закрываем открытую смену, чтобы журнал за день был полным.
    if (isFinal) {
      try { await closeOpenShift(env, now); }
      catch (e) { console.error('[shift] close on final failed:', e && e.message); }
    }

    const dateKey = `events:${almatyDateStr(now)}`;
    const rawDayEvents = (await env.PULSE_KV.get(dateKey, { type: 'json' })) || [];
    // Чёрный список внутренних (сотрудники/владелец/тест) — их сообщения не заявки.
    const isInternal = internalMatcher(env);
    const events = rawDayEvents.filter((e) => {
      if (!e) return false;
      if (isDeletedMarker(e.text)) return false; // удалённое сообщение — отвечать не на что
      if (e.blocked) return false; // контакт заблокирован на момент сообщения — отдел его не видит
      if (isInternal(e)) return false; // внутренний номер или имя контакта (напр. владелец)
      return true;
    });
    const metrics = computeMetrics(events, now, unansweredThreshold(env));
    if (events.length) {
      console.log('[digest] message types seen:', metrics.seenTypes.join(', '));
    }

    // Отсеиваем заблокированные диалоги (отдел их не видит в хелпе) по актуальному
    // статусу + попутно дотягиваем телефоны. Делаем ДО проверки «тихо», чтобы счётчик
    // «без ответа» был честным (если все зависшие заблокированы — час тихий).
    const unBefore = metrics.unanswered.slice();
    await refineUnanswered(env, metrics, isFinal ? 20 : 12);

    // Контроль «КЭВ → запись в Altegio» (карточки mh-bot): сверка по телефону,
    // SLA-эскалации, метрики дня. Best-effort: сбой не роняет дайджест.
    // ДО ИИ-судьи: диалоги с ОТКРЫТЫМ КЭВ убираем из «без ответа» — их судьбу
    // ведёт КЭВ-контроль (карточка уже у менеджеров, SLA тикает), дублировать
    // их ещё и в списке зависших — тройной шум по одному клиенту.
    try { metrics.kev = await runKevControl(env, now); }
    catch (e) { console.error('[kev] control failed:', e && e.message); metrics.kev = null; }
    if (metrics.kev && metrics.kev.openPhones && metrics.kev.openPhones.length) {
      const open = new Set(metrics.kev.openPhones);
      const before = metrics.unanswered.length;
      metrics.unanswered = metrics.unanswered.filter((u) => {
        const p = String(u.phone || '').replace(/\D/g, '').slice(-10);
        return !(p && open.has(p));
      });
      metrics.kevHidden = before - metrics.unanswered.length;
      if (metrics.kevHidden) console.log(`[kev] скрыто из «без ответа» (ведёт КЭВ-контроль): ${metrics.kevHidden}`);
    }

    // Бот сам читает транскрипты зависших и решает, кто реально без ответа.
    await judgeUnanswered(env, metrics, events);

    // Деньги дня (WS-1) — только в «Итоге дня» (21:00). Best-effort: нет Altegio →
    // блок просто отсутствует. Считаем ДО dry-return, чтобы preview показывал выручку.
    if (isFinal) {
      try { metrics.money = await fetchDayMoney(env, now); }
      catch (e) { console.error('[money] failed:', e && e.message); metrics.money = null; }
    }
    // Ночные авто-записи бота на консультацию — в утренней сводке (08:00): что бот
    // оформил за ночь (с 21:00 вчера до сейчас). Best-effort: нет Altegio → блока нет.
    if (parts.hour === MORNING_HOUR) {
      try {
        const nightStart = almatyTimeTs(almatyDateStr(now - 86400000), 21);
        metrics.nightBookings = await fetchBotConsultBookings(env, nightStart, now);
      } catch (e) { console.error('[nightbook] failed:', e && e.message); metrics.nightBookings = null; }
    }

    // Dry-run (?dry=1): вернуть диагностику без отправки в чат.
    if (meta.dry) {
      return {
        dry: true,
        unansweredBefore: unBefore.length,
        unansweredAfter: metrics.unanswered.length,
        blockedSkipped: metrics.blockedSkipped || 0,
        aiDropped: metrics.aiDropped || 0,
        todayLeads: metrics.todayLeads,
        newLeads: metrics.newLeads,
        kev: metrics.kev,
        aiVerdicts: metrics.aiVerdicts || [],
        finalUnanswered: metrics.unanswered.slice(0, 15).map((u) => ({ label: contactLabel(u), waitedMin: u.waitedMin })),
        preview: (isFinal ? formatFinal : formatIntermediate)(metrics, parts, ''),
      };
    }

    // Предохранитель рассылки (WS-1): при всплеске жалоб ставит broadcast_pause
    // и алертит владельцев. Каждый тик, до «тихой» ветки. Сбой не роняет дайджест.
    try { await maybeBreakerPause(env, now); }
    catch (e) { console.error('[breaker] failed:', e && e.message); }

    // «Тихо»: за 3 часа ничего нового и нет зависших — короткая строка, без LLM.
    if (!isFinal && metrics.deltaLeads === 0 && metrics.unanswered.length === 0) {
      const kevLine = formatKevLine(metrics.kev);
      const nb = nightBookingsBlock(metrics.nightBookings); // ночные авто-записи (только в 08:00)
      const text = `📊 Пульс продаж · ${parts.hhmm} · ${parts.ddmm}\n`
        + `Тихо: 0 новых за час, все диалоги отвечены.\n`
        + `Всего за день: ${metrics.todayLeads} ${plural(metrics.todayLeads, ['обращение', 'обращения', 'обращений'])}, из них новых: ${metrics.newLeads}.`
        + (kevLine ? `\n${kevLine}` : '')
        + (nb.length ? `\n${nb.join('\n')}` : '');
      await sendTelegram(env, text);
      await maybeSendBroadcast(env, now); // отдельное письмо по летней рассылке
      console.log('[digest] quiet', { ...metricsSummary(metrics), ...meta });
      return { sent: 1, quiet: true, ...metricsSummary(metrics) };
    }

    const smart = await callPersona(env, metrics, parts, isFinal);
    const text = isFinal
      ? formatFinal(metrics, parts, smart)
      : formatIntermediate(metrics, parts, smart);
    await sendTelegram(env, text);
    await maybeSendBroadcast(env, now); // отдельное письмо по летней рассылке
    // В «Итоге дня» — сохраняем лёгкий снимок дня для отчётов за неделю/месяц/период.
    if (isFinal) {
      try { await saveDailySnapshot(env, await buildDailySnapshot(env, now)); }
      catch (e) { console.error('[snapshot] final failed:', e && e.message); }
    }
    console.log('[digest] sent', { isFinal, ...metricsSummary(metrics), ...meta });
    return { sent: 1, isFinal, ...metricsSummary(metrics) };
  } catch (e) {
    console.error('[digest] error:', e && (e.stack || e.message));
    // Сбой не должен пройти незаметно — кричим в тот же чат коротким алертом.
    try {
      await sendTelegram(env, `⚠️ Пульс продаж: сбой дайджеста (${parts.hhmm} ${parts.ddmm}).\n`
        + String((e && e.message) || e).slice(0, 300));
    } catch (_) { /* и Telegram недоступен — остаётся только лог */ }
    return { sent: 0, error: 'digest_failed' };
  }
}

function unansweredThreshold(env) {
  const n = parseInt(env.UNANSWERED_THRESHOLD_MIN, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_UNANSWERED_MIN;
}

function metricsSummary(m) {
  return {
    newLeads: m.newLeads,
    ongoing: m.ongoing,
    deltaNew: m.deltaNew,
    todayMedianMin: m.todayMedianMin,
    unanswered: m.unanswered.length,
    spam: m.spamSkipped || 0,
  };
}

/* ============================================================
 * МЕТРИКИ — реконструкция дня из потока событий (считает код, не LLM)
 * ============================================================ */

// Сообщение клиента — это финальная вежливость, не требующая ответа? (благодарность,
// прощание, чистые эмодзи). Вопросы (есть «?») и длинные сообщения таковыми НЕ считаем,
// чтобы не спрятать реальные «без ответа».
function isClosingText(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (s.includes('?')) return false;                          // вопрос — нужен ответ
  // убираем эмодзи/пунктуацию → остаются только слова
  const cleaned = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!cleaned) return true;                                  // было только эмодзи/пунктуация
  const words = cleaned.split(' ').filter(Boolean);
  // всё сообщение состоит из вежливостей/подтверждений
  if (words.length <= 6 && words.every((w) => CLOSING_WORDS.has(w))) return true;
  // короткое сообщение с явной благодарностью/прощанием и без признаков запроса
  // («Здравствуйте спасибо», «Спасибо за информацию») — тоже закрытие
  if (words.length <= 5 && CLOSING_STRONG.test(cleaned) && !REQUEST_HINT.test(cleaned)) return true;
  return false;
}

// Из массива событий дня считает: всего живых заявок, новые за 3 часа, медиану
// первого ответа (за день и за 3 часа), список зависших без ответа сейчас.
function computeMetrics(rawEvents, now, thresholdMin) {
  // Дедуп по message_id (вебхук мог продублироваться).
  const seen = new Set();
  const events = [];
  for (const e of rawEvents) {
    if (!e || !e.dialog_id) continue;
    if (e.message_id) {
      if (seen.has(e.message_id)) continue;
      seen.add(e.message_id);
    }
    events.push(e);
  }

  // Живое обращение клиента = direction client и тип не из чёрного списка
  // (реакции-эмодзи и служебное заявками не считаем — раздел 6 ТЗ).
  const isLiveClient = (e) => e.direction === 'client'
    && !NON_LEAD_MESSAGE_TYPES.includes(String(e.message_type || '').toLowerCase());

  const dialogs = new Map();
  for (const e of events) {
    if (!dialogs.has(e.dialog_id)) dialogs.set(e.dialog_id, []);
    dialogs.get(e.dialog_id).push(e);
  }

  // Последний ответ оператора ПО ТЕЛЕФОНУ (через все диалоги). Нужно из-за смены номера:
  // клиент пишет на мёртвый WhatsApp (17222) И на новый (20916) — отвечают в одном диалоге,
  // в другом висит «без ответа». Если на телефон ответили где-либо после сообщения — снимаем.
  // Ответы БОТА (bot:true) не считаются: «без ответа» = человек не вступил.
  const phoneOpTs = new Map();
  for (const e of events) {
    if (e.direction === 'operator' && !e.bot && e.phone) {
      const k = String(e.phone).replace(/\D/g, '').slice(-10);
      if (k.length === 10 && (!phoneOpTs.has(k) || e.ts > phoneOpTs.get(k))) phoneOpTs.set(k, e.ts);
    }
  }

  const deltaStart = now - DELTA_WINDOW_MS;
  const thresholdMs = thresholdMin * 60 * 1000;

  let todayLeads = 0;
  let deltaLeads = 0;
  let newLeads = 0;   // новые заявки: контакт создан сегодня (первое обращение)
  let ongoing = 0;    // продолжения: контакт писал и раньше (действующий)
  let deltaNew = 0;   // новых заявок за последнее окно
  const todayResponses = []; // диффы «первый ответ» (мс) за весь день
  const deltaResponses = []; // то же, только новые за 3 часа
  const unanswered = [];
  const seenTypes = new Set();
  let spamSkipped = 0;

  for (const [dialogId, evs] of dialogs) {
    evs.sort((a, b) => a.ts - b.ts);
    for (const e of evs) seenTypes.add(String(e.message_type || ''));

    const clientMsgs = evs.filter(isLiveClient);
    const operatorMsgs = evs.filter((e) => e.direction === 'operator');
    if (clientMsgs.length === 0) continue; // только служебка/реакции — не заявка
    // B2B/спам-обращение (продажа отзывов, продвижение и т.п.) — не лид, исключаем целиком.
    if (clientMsgs.some((c) => SPAM_HINT.test(c.text || ''))) { spamSkipped++; continue; }

    const firstClientTs = clientMsgs[0].ts;
    todayLeads++;
    // Новая заявка = контакт создан СЕГОДНЯ (по Алматы); иначе — продолжение/действующий.
    // contact_created нет в старых событиях → считаем продолжением (не завышаем «новых»).
    const cc = (clientMsgs.find((c) => c.contact_created) || {}).contact_created || null;
    const isNewLead = cc != null && almatyDateStr(cc) === almatyDateStr(now);
    if (isNewLead) newLeads++; else ongoing++;
    const isNewInWindow = firstClientTs >= deltaStart && firstClientTs <= now;
    if (isNewInWindow) { deltaLeads++; if (isNewLead) deltaNew++; }

    // Скорость первого ответа: первый клиентский → первый ответ ЧЕЛОВЕКА после
    // него. Ответы mh-bot (bot:true) — не работа менеджеров, в метрику не идут.
    const firstReply = operatorMsgs.find((o) => !o.bot && o.ts >= firstClientTs);
    if (firstReply) {
      const diff = firstReply.ts - firstClientTs;
      todayResponses.push(diff);
      if (isNewInWindow) deltaResponses.push(diff);
    }

    // Без ответа сейчас: последнее СОДЕРЖАТЕЛЬНОЕ сообщение клиента позже последнего
    // ответа оператора и провисело дольше порога. Финальные вежливости (спасибо,
    // «До встречи 🌹», эмодзи) игнорируем — на них не отвечают, иначе закрытый диалог
    // ложно считался бы «без ответа».
    // Содержательное сообщение клиента = текст-не-вежливость, ЛИБО медиа/стикер без
    // текста, но только если оператор ещё НЕ вступал (возможно, новый лид прислал фото).
    // Если оператор уже отвечал, а клиент прислал стикер/смайл/фото без текста — это
    // реакция, не «вопрос без ответа» (фидбэк смены: «там смайлик отправил клиент»).
    // Идём по таймлайну, чтобы учесть контекст предыдущего сообщения оператора:
    // голое «да/хорошо» обычно закрытие, НО если оператор прямо перед этим предложил
    // записаться/спросил время — это согласие на запись, ответ нужен (горячий лид не теряем).
    let prevOp = null;
    const substantiveClient = [];
    for (const e of evs) {
      if (e.direction === 'operator') { prevOp = e; continue; }
      if (!isLiveClient(e)) continue;
      if (isCallMarker(e.text)) continue; // отметка о звонке — не чат-вопрос, в чате не отвечают
      let sub;
      if (e.text) {
        // Закрытие («да»/«хорошо»/«договорились») в ответ на вопрос или предложение записи
        // оператора — это согласие, ответ нужен; благодарность/прощание (CLOSING_STRONG) — нет.
        const opAsked = prevOp && (/\?/.test(prevOp.text || '') || BOOKING_CONFIRM.test(prevOp.text || '') || BOOKING_ASK.test(prevOp.text || ''));
        sub = !isClosingText(e.text) || !!(opAsked && !CLOSING_STRONG.test(e.text));
      } else {
        sub = operatorMsgs.length === 0; // медиа без текста — содержательно, только если оператор ещё не вступал
      }
      if (sub) substantiveClient.push(e);
    }
    const lastClientMsg = substantiveClient.length ? substantiveClient[substantiveClient.length - 1] : null;
    // «Без ответа» снимает только ответ ЧЕЛОВЕКА — реплики бота (bot:true) не в счёт
    // (бот не оформляет записи; клиент, ждущий действия, не должен прятаться).
    const humanOps = operatorMsgs.filter((o) => !o.bot);
    const lastOperatorTs = humanOps.length ? humanOps[humanOps.length - 1].ts : -1;
    // Если ПОСЛЕДНЕЕ действие клиента — звонок, разговор ушёл в телефон (его закрывают
    // звонком, не в чате) → чат-«без ответа» не флагуем. Берём любое клиентское событие
    // (даже со служебным message_type), чтобы поймать отметку о звонке.
    const clientDir = evs.filter((e) => e.direction === 'client');
    const movedToCall = clientDir.length && isCallMarker(clientDir[clientDir.length - 1].text);
    // Ответили ли этому телефону оператором в ЛЮБОМ диалоге после последнего сообщения
    // клиента (случай дубля на старый+новый WhatsApp) → тогда диалог не «без ответа».
    const phoneKey = lastClientMsg && lastClientMsg.phone ? String(lastClientMsg.phone).replace(/\D/g, '').slice(-10) : '';
    const answeredElsewhere = phoneKey.length === 10 && phoneOpTs.has(phoneKey) && phoneOpTs.get(phoneKey) >= lastClientMsg.ts;
    if (lastClientMsg && !movedToCall && !answeredElsewhere && lastOperatorTs < lastClientMsg.ts && (now - lastClientMsg.ts) > thresholdMs) {
      unanswered.push({
        dialogId,
        phone: lastClientMsg.phone || '',
        name: lastClientMsg.contact_name || '',
        channelId: lastClientMsg.channel_id != null ? lastClientMsg.channel_id : null,
        lastClientTs: lastClientMsg.ts,
        waitedMin: Math.round((now - lastClientMsg.ts) / 60000),
        isNew: isNewLead,
      });
    }
  }

  unanswered.sort((a, b) => b.waitedMin - a.waitedMin);

  return {
    todayLeads,
    deltaLeads,
    newLeads,
    ongoing,
    deltaNew,
    todayMedianMin: medianMinutes(todayResponses),
    deltaMedianMin: medianMinutes(deltaResponses),
    unanswered,
    seenTypes: [...seenTypes],
    spamSkipped,
  };
}

// Медиана массива длительностей (мс) → целые минуты, минимум 1. Пустой → null.
function medianMinutes(diffsMs) {
  if (!diffsMs.length) return null;
  const arr = diffsMs.slice().sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  const med = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  return Math.max(1, Math.round(med / 60000));
}

/* ============================================================
 * ЛЕТНЯЯ РАССЫЛКА — мониторинг акции «Экспресс-программы M&M» (до 15.06.2026)
 * ============================================================ */

// Метрики рассылки за день: отправки, шаблоны, темп по часам, ответы (24ч),
// конверсия, брони после рассылки (Altegio, +72ч), риск-сигналы в ответах.
// opts.skipBookings — не дёргать Altegio за бронями (предохранителю WS-1 нужен
// только риск-сигнал; экономим субреквест на ежечасном тике).
async function computeBroadcastMetrics(env, now, opts = {}) {
  // Только сегодняшний бакет: «отправлено сегодня» без 2-дневного двойного счёта;
  // ответы на сегодняшние отправки приходят в этот же бакет.
  const seen = new Set(); const events = [];
  const raw = (await env.PULSE_KV.get(`events:${almatyDateStr(now)}`, { type: 'json' })) || [];
  for (const e of raw) { if (!e || !e.dialog_id) continue; if (e.message_id) { if (seen.has(e.message_id)) continue; seen.add(e.message_id); } events.push(e); }

  // 1) Отправки рассылки: оператор + канал 20916 + текст-префикс.
  const sends = events.filter((e) => e.direction === 'operator'
    && Number(e.channel_id) === BROADCAST_CHANNEL && isBroadcastMessage(e.text));
  const broadcastByTemplate = { A: 0, B: 0, C: 0 };
  const broadcastByHour = new Map();
  const sendByDialog = new Map();   // dialog_id → самая ранняя ts отправки
  const phoneByDialog = new Map();  // dialog_id → телефон получателя (последние 10 цифр)
  const norm = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
  for (const s of sends) {
    const t = broadcastTemplate(s.text); if (t) broadcastByTemplate[t]++;
    const h = almatyParts(s.ts).hour; broadcastByHour.set(h, (broadcastByHour.get(h) || 0) + 1);
    if (!sendByDialog.has(s.dialog_id) || s.ts < sendByDialog.get(s.dialog_id)) sendByDialog.set(s.dialog_id, s.ts);
    const ph = norm(s.phone); if (ph) phoneByDialog.set(s.dialog_id, ph);
  }
  const broadcastSent = sends.length;

  // 2) Ответы клиентов в диалог рассылки в течение 24ч после отправки (1 диалог = 1 ответ).
  const repliedDialogs = new Set();
  const risks = [];
  for (const e of events) {
    if (e.direction !== 'client' || Number(e.channel_id) !== BROADCAST_CHANNEL) continue;
    const sendTs = sendByDialog.get(e.dialog_id);
    if (sendTs == null || e.ts < sendTs || e.ts > sendTs + 24 * 3600 * 1000) continue;
    repliedDialogs.add(e.dialog_id);
    const ph = norm(e.phone); if (ph && !phoneByDialog.has(e.dialog_id)) phoneByDialog.set(e.dialog_id, ph);
    if (BROADCAST_RISK.test(e.text || '')) {
      risks.push({ name: e.contact_name || '', phone: e.phone || '', text: String(e.text || '').slice(0, 100), hour: almatyParts(e.ts).hour });
    }
  }
  const broadcastReplies = repliedDialogs.size;
  const broadcastConversionRate = broadcastSent ? broadcastReplies / broadcastSent : 0;

  // Риск критичен, если ≥3 матчей за один час.
  const riskByHour = new Map();
  for (const r of risks) riskByHour.set(r.hour, (riskByHour.get(r.hour) || 0) + 1);
  const riskCritical = [...riskByHour.values()].some((c) => c >= 3);

  // 3) Брони после рассылки: Altegio-запись, телефон получателя, create_date в (отправка, +72ч].
  const sendTsByPhone = new Map();
  for (const [dialog, ts] of sendByDialog) { const ph = phoneByDialog.get(dialog); if (ph) { if (!sendTsByPhone.has(ph) || ts < sendTsByPhone.get(ph)) sendTsByPhone.set(ph, ts); } }
  let broadcastBookings = 0;
  if (sendTsByPhone.size && !opts.skipBookings) {
    const token = await altegioUserToken(env);
    if (token) {
      const recs = await fetchAltegioRecords(env, token, almatyDateStr(now - 4 * 86400000), almatyDateStr(now));
      const booked = new Set();
      for (const r of (recs || [])) {
        const ph = norm(r.client && r.client.phone); if (!ph) continue;
        const sendTs = sendTsByPhone.get(ph); if (sendTs == null) continue;
        const created = parseTs(r.create_date);
        if (created > sendTs && created <= sendTs + 72 * 3600 * 1000) booked.add(ph);
      }
      broadcastBookings = booked.size;
    }
  }

  return {
    broadcastSent, broadcastByTemplate, broadcastByHour,
    broadcastReplies, broadcastConversionRate, broadcastBookings,
    broadcastRisks: { count: risks.length, critical: riskCritical, list: risks.map(({ name, phone, text }) => ({ name, phone, text })) },
    phoneCoverage: { known: sendTsByPhone.size, total: sendByDialog.size }, // диагностика покрытия телефонов для броней
  };
}

// Блок рассылки виден только в период акции (по дате Алматы).
function broadcastActive(now) {
  return almatyDateStr(now) <= BROADCAST_END_DATE;
}

// Отдельное письмо в чат по рассылке (НЕ врезка в пульс — по просьбе заказчика).
function formatBroadcast(m, parts) {
  const lines = [];
  const r = m.broadcastRisks || { count: 0, critical: false, list: [] };
  const conv = Math.round((m.broadcastConversionRate || 0) * 100);
  // Критичный риск (≥3 жалоб за час) — в начало письма, капсом (без эмодзи).
  if (r.critical) {
    lines.push(`ВНИМАНИЕ: рост негатива на рассылку — ${r.count} жалоб(ы) за короткое время. Нужна реакция.`);
    for (const x of r.list.slice(0, 5)) lines.push(`— ${contactLabel({ phone: x.phone, name: x.name })}: «${x.text}»`);
    lines.push('');
  }
  lines.push(`Рассылка «Летние экспресс-программы» — сводка на ${parts.hhmm}, ${parts.ddmm}`);
  lines.push('');
  lines.push(`Отправлено сегодня: ${m.broadcastSent} сообщений`);
  lines.push(`Ответили клиенты: ${m.broadcastReplies} (${conv}% от отправленных)`);
  lines.push(`Записались после рассылки: ${m.broadcastBookings} (бронь в течение 72 часов)`);
  if (!r.critical) {
    if (r.count) {
      lines.push(`Жалобы и негатив: ${r.count} — проверьте:`);
      for (const x of r.list.slice(0, 3)) lines.push(`— ${contactLabel({ phone: x.phone, name: x.name })}: «${x.text}»`);
    } else {
      lines.push('Жалобы и негатив: не выявлено');
    }
  }
  // Детали для понимания темпа (вторично).
  const t = m.broadcastByTemplate;
  lines.push('');
  lines.push(`Использованные тексты: вариант A — ${t.A}, B — ${t.B}, C — ${t.C}`);
  if (m.broadcastByHour && m.broadcastByHour.size) {
    const hrs = [...m.broadcastByHour.entries()].sort((a, b) => a[0] - b[0]).map(([h, n]) => `${h}:00 — ${n}`).join(', ');
    lines.push(`Отправлено по часам: ${hrs}`);
  }
  return lines.join('\n');
}

// Шлёт отдельное письмо по рассылке, если акция активна и сегодня были отправки.
async function maybeSendBroadcast(env, now) {
  if (env.BROADCAST_REPORT === '0') return false; // отчёты по рассылке временно отключены (BROADCAST_REPORT=1 — включить)
  if (!broadcastActive(now)) return false;
  try {
    const m = await computeBroadcastMetrics(env, now);
    if (m.broadcastSent > 0) { await sendTelegram(env, formatBroadcast(m, almatyParts(now))); return true; }
  } catch (e) { console.error('[broadcast] send failed:', e && e.message); }
  return false;
}

// ── ПРЕДОХРАНИТЕЛЬ РАССЫЛКИ (WS-1) ───────────────────────────────────────────
const BROADCAST_PAUSE_KEY = 'broadcast_pause';   // флаг в KV mh-bot: его tick читает и пропускает рассылку
// При критическом риске (≥3 жалоб/час, computeBroadcastMetrics → riskCritical)
// ставит broadcast_pause в KV mh-bot (ЕДИНСТВЕННАЯ запись pulse в чужой namespace,
// см. шапку про MH_KV) + личный алерт владельцам с кнопкой «Возобновить».
// Работает НЕЗАВИСИМО от BROADCAST_REPORT (тот гейтит письмо-отчёт, не предохранитель)
// и от broadcastActive: тормозим, только пока акция реально активна. Идемпотентно —
// пока пауза стоит, повторно не алертим (флаг проверяем перед записью).
// opts.metrics — подставить готовые метрики (тест); opts.dry — посчитать, но НИЧЕГО
// не писать и не слать (ops-проверка ?breakertest=). Возвращает {fired, reason, ...}.
async function maybeBreakerPause(env, now, opts = {}) {
  if (!broadcastActive(now)) return { fired: false, reason: 'акция не активна' };
  if (!(env.MH_KV && typeof env.MH_KV.put === 'function')) return { fired: false, reason: 'MH_KV не подключён' };
  let m = opts.metrics;
  if (!m) {
    try { m = await computeBroadcastMetrics(env, now, { skipBookings: true }); }
    catch (e) { console.error('[breaker] метрики рассылки упали:', e && e.message); return { fired: false, reason: 'метрики упали' }; }
  }
  const r = m && m.broadcastRisks;
  if (!r || !r.critical) return { fired: false, reason: 'риск не критичен', riskCount: r ? r.count : 0 };
  let already = false;
  try { already = !!(await env.MH_KV.get(BROADCAST_PAUSE_KEY)); }
  catch (_) { /* не прочитали флаг — продолжаем, постановка идемпотентна по содержанию */ }
  const reason = `всплеск негатива на рассылку: ${r.count} жалоб(ы) за короткое время`;
  const recipients = [...adminIds(env)];
  if (opts.dry) return { fired: true, dry: true, already, reason, recipients, riskCount: r.count };
  if (already) return { fired: false, reason: 'уже на паузе', already: true };
  try {
    // Без TTL — снимается только кнопкой «Возобновить» (решение владельца).
    await env.MH_KV.put(BROADCAST_PAUSE_KEY, JSON.stringify({ reason, ts: now, by: 'mm-pulse-bot' }));
  } catch (e) { console.error('[breaker] не смог поставить broadcast_pause:', e && e.message); return { fired: false, reason: 'KV put упал' }; }
  console.log('[breaker] рассылка остановлена:', reason);
  const sample = r.list.slice(0, 5).map((x) => `— ${contactLabel({ phone: x.phone, name: x.name })}: «${x.text}»`).join('\n');
  for (const adminId of recipients) {
    await tgCall(env, 'sendMessage', {
      chat_id: adminId,
      text: `🛑 Рассылка остановлена автоматически.\n${reason}.\n${sample ? sample + '\n' : ''}\n`
        + 'Проверьте тексты и базу. Когда готовы — нажмите кнопку, бот продолжит по расписанию.',
      reply_markup: { inline_keyboard: [[{ text: '▶️ Возобновить рассылку', callback_data: 'bcast:resume' }]] },
      disable_web_page_preview: true,
    });
  }
  return { fired: true, reason, recipients };
}

/* ============================================================
 * КОНТРОЛЬ «КЭВ → ЗАПИСЬ В ALTEGIO» (WS-C)
 * Карточки КЭВ пишет mh-bot в свой KV kev:{userId}:{ts} (binding MH_KV,
 * читаем read-only по соглашению — pulse в чужой namespace НЕ пишет, своё
 * состояние сверки держит в PULSE_KV kevstate:*). Каждый часовой тик:
 *   1) сверка открытых КЭВ с записями Altegio по нормализованному телефону
 *      (запись СОЗДАНА после КЭВ → КЭВ закрыт, фиксируем лаг);
 *   2) просрочка SLA → карточка в группу; просрочка > KEV_DM_OVERDUE_MIN —
 *      личное сообщение управляющим (ADMIN_IDS);
 *   3) чекер качества записи: услуга соответствует процедуре карточки
 *      (нестрогий матч по словам), в комментарии маркер KEV_MARKER;
 *   4) метрики дня для пульса/итога/снимка.
 * ============================================================ */

const KEV_TRACK_WINDOW_H = 48;  // КЭВ старше 48ч — фиксируем как невыполненный, дальше не трекаем

function kevMarker(env) { return String(env.KEV_MARKER || '[чат-бот]'); }
const norm10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };

// create_date Altegio: либо ISO с таймзоной («2026-06-12T01:23:45+05:00») —
// Date.parse корректен; либо naive-строка В ЛОКАЛЬНОМ времени филиала (Almaty,
// UTC+5). Общий parseTs для naive-строк применяет МСК (формат message.help) —
// для Altegio дал бы ошибку 2 часа, поэтому отдельный парсер.
function parseAltegioCreateTs(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/(?:[+-]\d{2}:?\d{2}|Z)$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - ALMATY_UTC_OFFSET, +m[5], +(m[6] || 0));
}

// Карточки КЭВ из KV mh-bot не старше windowH часов. null = MH_KV не подключён.
async function listKevCardsFromMh(env, now, windowH) {
  if (!env.MH_KV || typeof env.MH_KV.list !== 'function') return null;
  const since = now - windowH * 3600000;
  const out = [];
  let cursor;
  for (let i = 0; i < 4; i++) {
    let page;
    try {
      page = await env.MH_KV.list({ prefix: 'kev:', limit: 1000, cursor });
    } catch (e) {
      console.error('[kev] MH_KV list:', e && e.message);
      return null;
    }
    for (const k of page.keys) {
      const ts = Number(String(k.name).split(':')[2]); // kev:{userId}:{ts}
      if (!Number.isFinite(ts) || ts < since) continue;
      try {
        const card = await env.MH_KV.get(k.name, { type: 'json' });
        if (card && card.phone) out.push({ ...card, kevKey: k.name });
      } catch (_) { /* пропуск битой карточки */ }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  out.sort((a, b) => (a.kevAt || 0) - (b.kevAt || 0));
  return out;
}

// Чекер качества записи по КЭВ. «Грязная» = нет маркера [чат-бот] в комментарии
// ИЛИ услуга записи не похожа на процедуру карточки (нестрогий матч по словам
// ≥3 букв в обе стороны). Расхождение услуги — пометка в отчёте, не алерт.
function kevQuality(env, kev, rec) {
  const issues = [];
  const marker = kevMarker(env).toLowerCase();
  if (!String(rec.comment || '').toLowerCase().includes(marker)) {
    issues.push(`нет маркера ${kevMarker(env)} в комментарии`);
  }
  const titles = (rec.services || []).map((s) => String((s && s.title) || '')).join(' ').toLowerCase();
  const want = String(kev.service || '').toLowerCase();
  if (!titles.trim()) {
    issues.push('услуга в записи не указана');
  } else if (want) {
    const tokens = want.split(/[^a-zа-яё0-9]+/i).filter((w) => w.length >= 3);
    const hit = tokens.some((w) => titles.includes(w))
      || titles.split(/[^a-zа-яё0-9]+/i).filter((w) => w.length >= 3).some((w) => want.includes(w));
    if (!hit) {
      issues.push(`услуга «${String((rec.services[0] && rec.services[0].title) || '—').slice(0, 40)}»`
        + ` не похожа на карточку («${String(kev.service).slice(0, 40)}»)`);
    }
  }
  return { clean: !issues.length, issues };
}

const kevPhoneLabel = (p) => { const d = String(p || '').replace(/\D/g, ''); return d ? `+${d}` : '—'; };
const fmtWaitMin = (min) => (min >= 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min} мин`);

// Главный проход контроля. Возвращает метрики дня для пульса/снимка
// (или null, если MH_KV не подключён). Эскалации шлёт сам, по одной на КЭВ
// (флаги в kevstate, поэтому повторные вызовы в одном тике безопасны).
async function runKevControl(env, now) {
  const kevs = await listKevCardsFromMh(env, now, KEV_TRACK_WINDOW_H);
  if (kevs == null) return null;

  // Записи Altegio, созданные за окно контроля, — один fetch на тик.
  // altegioOk=false (нет токена / API упал) → НЕ эскалируем и не «протухаем»
  // КЭВ: без свежих данных «запись не найдена» — это не факт, а слепота.
  let altegioOk = false;
  const recsByPhone = new Map(); // last10 → [{ms, rec}] по возрастанию ms
  if (kevs.length) {
    const token = await altegioUserToken(env);
    if (token) {
      const recs = await fetchAltegioRecords(env, token,
        almatyDateStr(now - KEV_TRACK_WINDOW_H * 3600000), almatyDateStr(now));
      if (recs != null) {
        altegioOk = true;
        for (const r of recs) {
          if (!r || r.deleted) continue;
          const ph = norm10(r.client && r.client.phone);
          if (!ph) continue;
          const ms = parseAltegioCreateTs(r.create_date);
          if (ms == null) continue;
          if (!recsByPhone.has(ph)) recsByPhone.set(ph, []);
          recsByPhone.get(ph).push({ ms, rec: r });
        }
        for (const list of recsByPhone.values()) list.sort((a, b) => a.ms - b.ms);
      }
    }
    if (!altegioOk) console.error('[kev] Altegio недоступен — тик без сверки/эскалаций');
  }

  const dmThresholdMin = parseInt(env.KEV_DM_OVERDUE_MIN, 10) || 120;
  const today = almatyDateStr(now);
  const stats = {
    n: 0, done: 0, overdue: 0, dirty: 0, lags: [],
    openWaiting: 0, dirtyIssues: [], openPhones: [],
  };

  for (const k of kevs) {
    const stKey = `kevstate:${k.kevKey}`;
    let st = (await env.PULSE_KV.get(stKey, { type: 'json' })) || {};
    const slaMs = Number(k.slaDeadline) || ((k.kevAt || 0) + 3600000);

    if (altegioOk && st.status !== 'closed' && st.status !== 'expired') {
      // Матч: запись, созданная после КЭВ (допуск −30 мин: менеджер мог успеть
      // оформить, пока бот дописывал диалог).
      const cand = (recsByPhone.get(norm10(k.phone)) || [])
        .find((x) => x.ms >= ((k.kevAt || 0) - 1800000));
      if (cand) {
        const lagMin = Math.max(0, Math.round((cand.ms - (k.kevAt || cand.ms)) / 60000));
        const q = kevQuality(env, k, cand.rec);
        st = {
          ...st, status: 'closed', closedAt: cand.ms, recordId: cand.rec.id,
          lagMin, late: cand.ms > slaMs, clean: q.clean, issues: q.issues,
        };
        await env.PULSE_KV.put(stKey, JSON.stringify(st), { expirationTtl: 30 * 86400 });
        console.log(`[kev] closed ${k.kevKey} rec=${cand.rec.id} lag=${lagMin}min `
          + `late=${st.late} clean=${q.clean}`);
      } else if (now - (k.kevAt || 0) > (KEV_TRACK_WINDOW_H - 1) * 3600000) {
        st = { ...st, status: 'expired' };
        await env.PULSE_KV.put(stKey, JSON.stringify(st), { expirationTtl: 30 * 86400 });
        console.log(`[kev] expired ${k.kevKey} — записи так и нет`);
      } else if (now > slaMs) {
        // Открыт и просрочен: эскалации (по одной на КЭВ).
        const overdueMin = Math.round((now - slaMs) / 60000);
        const waitedMin = Math.round((now - (k.kevAt || now)) / 60000);
        if (!st.grpAlertAt) {
          await sendTelegram(env,
            `⚠️ КЭВ не оформлен: ${k.name || '—'} · ${kevPhoneLabel(k.phone)}\n`
            + `${k.service || '—'} · ${[k.day, k.interval].filter(Boolean).join(' ') || '—'}\n`
            + `Договорённость от бота ждёт оформления ${fmtWaitMin(waitedMin)} `
            + `(SLA ${k.slaLabel || 'прошёл'}).\n`
            + `Оформите запись в Altegio, в комментарий — маркер ${kevMarker(env)}.`);
          st.grpAlertAt = now;
          await env.PULSE_KV.put(stKey, JSON.stringify(st), { expirationTtl: 30 * 86400 });
        }
        if (overdueMin > dmThresholdMin && !st.dmAlertAt) {
          for (const adminId of adminIds(env)) {
            await tgCall(env, 'sendMessage', {
              chat_id: adminId,
              text: `🚨 КЭВ просрочен на ${fmtWaitMin(overdueMin)} сверх SLA:\n`
                + `${k.name || '—'} · ${kevPhoneLabel(k.phone)} · ${k.service || '—'}\n`
                + 'Запись в Altegio так и не оформлена — нужна ваша реакция.',
              disable_web_page_preview: true,
            });
          }
          st.dmAlertAt = now;
          await env.PULSE_KV.put(stKey, JSON.stringify(st), { expirationTtl: 30 * 86400 });
        }
      }
    }

    // Телефоны ВСЕХ открытых КЭВ (за окно контроля) — runDigest по ним убирает
    // диалоги из «без ответа»: их судьбу ведёт КЭВ-контроль, дублировать шум не надо.
    if (st.status !== 'closed' && st.status !== 'expired') {
      const p10 = norm10(k.phone);
      if (p10) stats.openPhones.push(p10);
    }

    // Метрики дня — по календарному дню КЭВ (Алматы).
    if (almatyDateStr(k.kevAt || 0) === today) {
      stats.n++;
      if (st.status === 'closed') {
        stats.done++;
        stats.lags.push(st.lagMin || 0);
        if (st.late) stats.overdue++;
        if (st.clean === false) {
          stats.dirty++;
          stats.dirtyIssues.push(`${k.name || kevPhoneLabel(k.phone)}: ${(st.issues || []).join('; ')}`);
        }
      } else if (st.status === 'expired') {
        stats.overdue++;
      } else {
        stats.openWaiting++;
        if (now > slaMs) stats.overdue++;
      }
    }
  }

  stats.lagMedianMin = stats.lags.length
    ? medianMinutes(stats.lags.map((m) => m * 60000)) : null;
  console.log(`[kev] control: tracked=${kevs.length} today=${stats.n} done=${stats.done} `
    + `overdue=${stats.overdue} dirty=${stats.dirty} waiting=${stats.openWaiting}`);
  return stats;
}

// Строка блока КЭВ для пульса/итога дня. null-метрики (MH_KV не подключён) → ''.
function formatKevLine(kev) {
  if (!kev || (!kev.n && !kev.overdue && !kev.openWaiting)) return '';
  const pctDone = kev.n ? Math.round((kev.done / kev.n) * 100) : 0;
  let s = `🤝 КЭВ бота: ${kev.n} за день · оформлено ${kev.done}${kev.n ? ` (${pctDone}%)` : ''}`;
  if (kev.lagMedianMin != null) s += ` · медианный лаг ${kev.lagMedianMin} мин`;
  if (kev.overdue) s += ` · ⚠️ просрочено ${kev.overdue}`;
  if (kev.dirty) s += ` · 🧹 грязных ${kev.dirty}`;
  return s;
}

/* ============================================================
 * СВЕРКА ЛИДОВ ДНЯ — таргетолог vs message.help vs реальные диалоги
 * ============================================================ */

// Матчер «внутренний контакт» (сотрудник/владелец/тест): по ТЕЛЕФОНУ (INTERNAL_PHONES)
// ИЛИ по ИМЕНИ контакта (INTERNAL_NAMES) — для IG-контактов без телефона (напр. владелец).
function internalMatcher(env) {
  const phones = new Set(String(env.INTERNAL_PHONES || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean));
  const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const names = new Set(String(env.INTERNAL_NAMES || '').split(',').map(normName).filter(Boolean));
  return (e) => {
    if (phones.size && e.phone && phones.has(String(e.phone).replace(/\D/g, ''))) return true;
    if (names.size && e.contact_name && names.has(normName(e.contact_name))) return true;
    return false;
  };
}

// События дня с теми же фильтрами, что в дайджесте (удалённые, заблок., внутренние).
async function loadFilteredEvents(env, now) {
  const raw = (await env.PULSE_KV.get(`events:${almatyDateStr(now)}`, { type: 'json' })) || [];
  const isInternal = internalMatcher(env);
  return raw.filter((e) => {
    if (!e) return false;
    if (isDeletedMarker(e.text)) return false;
    if (e.blocked) return false;
    if (isInternal(e)) return false;
    return true;
  });
}

// Классифицирует НОВЫЕ контакты сегодня: реальный диалог vs спам/односложное/без текста.
// «Реальный» = есть содержательное текстовое сообщение клиента (намерение, вопрос, запрос).
function computeLeadReco(rawEvents, now) {
  const seen = new Set(); const events = [];
  for (const e of rawEvents) {
    if (!e || !e.dialog_id) continue;
    if (e.message_id) { if (seen.has(e.message_id)) continue; seen.add(e.message_id); }
    events.push(e);
  }
  const isLiveClient = (e) => e.direction === 'client'
    && !NON_LEAD_MESSAGE_TYPES.includes(String(e.message_type || '').toLowerCase());
  const dialogs = new Map();
  for (const e of events) {
    if (!dialogs.has(e.dialog_id)) dialogs.set(e.dialog_id, []);
    dialogs.get(e.dialog_id).push(e);
  }
  const today = almatyDateStr(now);
  const list = [];
  const breakdown = { real: 0, spam: 0, greeting: 0, noText: 0 };
  let newContacts = 0;
  for (const [dialogId, evs] of dialogs) {
    evs.sort((a, b) => a.ts - b.ts);
    const clientMsgs = evs.filter(isLiveClient);
    if (!clientMsgs.length) continue;
    const cc = (clientMsgs.find((c) => c.contact_created) || {}).contact_created || null;
    if (cc == null || almatyDateStr(cc) !== today) continue; // только новые контакты сегодня
    newContacts++;
    const texts = clientMsgs.map((c) => c.text || '').filter(Boolean);
    let kind;
    if (clientMsgs.some((c) => SPAM_HINT.test(c.text || ''))) kind = 'spam';
    else if (!texts.length) kind = 'noText';
    else if (texts.every((t) => isClosingText(t))) kind = 'greeting';
    else kind = 'real';
    breakdown[kind]++;
    const phone = (clientMsgs.find((c) => c.phone) || {}).phone || '';
    const name = (clientMsgs.find((c) => c.contact_name) || {}).contact_name || '';
    const firstMsg = texts[0] || `[${clientMsgs[0].message_type || 'без текста'}]`;
    list.push({ label: contactLabel({ phone, name, dialogId }), channelId: clientMsgs[0].channel_id, firstMsg: firstMsg.slice(0, 60), kind });
  }
  return { newContacts, real: breakdown.real, breakdown, list };
}

// Сколько новых контактов message.help зарегистрировал за дату (по API, авторитетно).
// created_at в MSK → переводим в дату Алматы (как бакеты). Оценочно: до 6 страниц/канал.
async function fetchMhNewContacts(env, dateStr) {
  const out = { total: 0, perChannel: {}, truncated: false };
  if (!env.MH_LOGIN || !env.MH_PASSWORD || !env.MH_PROJECT_ID) return out;
  const token = await getMhToken(env);
  if (!token) return out;
  const H = { Authorization: `Bearer ${token}` };
  let channels = [];
  try {
    const j = await (await fetch(`${MH_API}/app/projects/${env.MH_PROJECT_ID}/channels/`, { headers: H })).json();
    channels = ((j && j.data) || []).filter((c) => c.uuid);
  } catch (_) { return out; }
  for (const c of channels) {
    let cnt = 0;
    for (let page = 1; page <= 6; page++) {
      let users = [];
      try {
        const j = await (await fetch(
          `${MH_API}/app/projects/${env.MH_PROJECT_ID}/channels/${c.uuid}/users/?limit=50&page=${page}`, { headers: H })).json();
        users = (j && j.data) || [];
        let pageHadToday = false;
        for (const u of users) {
          const cc = u.created_at ? parseTs(u.created_at) : null;
          if (cc != null && almatyDateStr(cc) === dateStr) { cnt++; pageHadToday = true; }
        }
        if (!j || !j.has_more || !users.length) break;
        // Потолок страниц, а сегодняшние контакты на последней ещё шли → недосчёт (honesty WS-1).
        if (page === 6 && pageHadToday) out.truncated = true;
      } catch (_) { break; }
    }
    if (cnt) out.perChannel[String(c.name).trim()] = cnt;
    out.total += cnt;
  }
  return out;
}

function formatLeadReco(ddmm, target, mh, reco) {
  const lines = [`📋 Сверка лидов · ${ddmm}`];
  lines.push(`🎯 Таргетолог: ${target != null ? target : '—'}`);
  const chParts = Object.entries(mh.perChannel || {}).map(([n, c]) => `${n} ${c}`).join(' · ');
  lines.push(`📥 message.help создал: ${mh.total}${chParts ? ` (${chParts})` : ''}`);
  if (mh.truncated) lines.push('⚠️ данные неполные: реестр message.help обрезан потолком страниц — число занижено');
  lines.push(`✍️ Написали нам: ${reco.newContacts}`);
  lines.push(`✅ Реальных диалогов: ${reco.real}`);
  const b = reco.breakdown; const junk = [];
  if (b.spam) junk.push(`спам ${b.spam}`);
  if (b.greeting) junk.push(`односложные ${b.greeting}`);
  if (b.noText) junk.push(`без текста ${b.noText}`);
  if (junk.length) lines.push(`🗑 Отсеяно: ${junk.join(' · ')}`);
  return lines.join('\n');
}

// Собрать сверку: посчитать, при необходимости записать число таргетолога.
async function buildReco(env, now, opts = {}) {
  const dateStr = almatyDateStr(now);
  if (opts.setTarget != null && Number.isFinite(opts.setTarget)) {
    await env.PULSE_KV.put(`target:${dateStr}`, String(opts.setTarget), { expirationTtl: 14 * 24 * 3600 });
  }
  const events = await loadFilteredEvents(env, now);
  const reco = computeLeadReco(events, now);
  const mh = await fetchMhNewContacts(env, dateStr);
  const tRaw = await env.PULSE_KV.get(`target:${dateStr}`);
  const target = tRaw != null ? parseInt(tRaw, 10) : null;
  const text = formatLeadReco(almatyParts(now).ddmm, target, mh, reco);
  return { date: dateStr, target, mh, reco, text };
}

/* ============================================================
 * ОТЧЁТЫ ЗА ПЕРИОД (день/неделя/месяц/произвольный)
 * ============================================================ */

const ddmmFromDate = (s) => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}` : String(s); };

// Лёгкий снимок дня (только из НАШИХ событий, без внешних API) — для агрегации периодов.
// Сохраняется в KV daily:YYYY-MM-DD (TTL 120 дней). Зовётся в «Итоге дня» (21:00) и лениво.
async function buildDailySnapshot(env, now) {
  const events = await loadFilteredEvents(env, now);
  const m = computeMetrics(events, now, unansweredThreshold(env));
  const reco = computeLeadReco(events, now);
  const dateStr = almatyDateStr(now);
  const tRaw = await env.PULSE_KV.get(`target:${dateStr}`);
  // Блок КЭВ — для отчётов за период. runKevControl идемпотентен (эскалации
  // защищены флагами kevstate), повторный вызов в тике безопасен.
  let kev = null;
  try { kev = await runKevControl(env, now); } catch (_) { /* без блока КЭВ */ }
  return {
    date: dateStr,
    target: tRaw != null ? parseInt(tRaw, 10) : null,
    wrote: reco.newContacts, real: reco.real,
    spam: reco.breakdown.spam, greeting: reco.breakdown.greeting, noText: reco.breakdown.noText,
    newLeads: m.newLeads, ongoing: m.ongoing, medianMin: m.todayMedianMin, unanswered: m.unanswered.length,
    kevN: kev ? kev.n : null, kevDone: kev ? kev.done : null,
    kevOverdue: kev ? kev.overdue : null, kevDirty: kev ? kev.dirty : null,
    kevLagMedian: kev ? kev.lagMedianMin : null,
  };
}
async function saveDailySnapshot(env, snap) {
  if (snap && snap.date) await env.PULSE_KV.put(`daily:${snap.date}`, JSON.stringify(snap), { expirationTtl: 120 * 24 * 3600 });
}

// Зарегистрированные контакты message.help по дням — один проход пагинации на канал
// (покрывает ~последние 8–10 дней). Для строки «лидов в реестре» в периоде.
async function fetchMhDailyCounts(env) {
  const out = {};
  if (!env.MH_LOGIN || !env.MH_PASSWORD || !env.MH_PROJECT_ID) return out;
  const token = await getMhToken(env); if (!token) return out;
  const H = { Authorization: `Bearer ${token}` };
  let channels = [];
  try { const j = await (await fetch(`${MH_API}/app/projects/${env.MH_PROJECT_ID}/channels/`, { headers: H })).json(); channels = ((j && j.data) || []).filter((c) => c.uuid); }
  catch (_) { return out; }
  for (const c of channels) {
    for (let page = 1; page <= 8; page++) {
      let users = [];
      try {
        const j = await (await fetch(`${MH_API}/app/projects/${env.MH_PROJECT_ID}/channels/${c.uuid}/users/?limit=50&page=${page}`, { headers: H })).json();
        users = (j && j.data) || [];
        for (const u of users) { const cc = u.created_at ? parseTs(u.created_at) : null; if (cc != null) { const d = almatyDateStr(cc); out[d] = (out[d] || 0) + 1; } }
        if (!j || !j.has_more || !users.length) break;
      } catch (_) { break; }
    }
  }
  return out;
}

// Диапазон дат для пресета. week=7 дн, month=30 дн (скользящие, включая сегодня).
function periodRange(period, now) {
  const n = period === 'week' ? 7 : period === 'month' ? 30 : 1;
  const dates = [];
  for (let i = n - 1; i >= 0; i--) dates.push(almatyDateStr(now - i * 86400000));
  return { label: period === 'week' ? 'неделя' : period === 'month' ? 'месяц' : 'день', dates, from: dates[0], to: dates[dates.length - 1] };
}
// Произвольный диапазон из текста: «01.06.2026-07.06.2026» или «1.6-7.6».
function parseUserDateRange(text, now) {
  const m = String(text).match(/(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\s*[-–—]\s*(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/);
  if (!m) return null;
  const curY = parseInt(almatyDateStr(now).slice(0, 4), 10);
  const ny = (y) => (y == null ? curY : (y < 100 ? 2000 + y : y));
  const t1 = Date.UTC(ny(m[3] && +m[3]), +m[2] - 1, +m[1], 12);
  const t2 = Date.UTC(ny(m[6] && +m[6]), +m[5] - 1, +m[4], 12);
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 < t1) return null;
  const dates = [];
  for (let t = t1; t <= t2 + 1000 && dates.length <= 92; t += 86400000) dates.push(almatyDateStr(t));
  return { label: 'период', dates, from: dates[0], to: dates[dates.length - 1] };
}

function formatSalesDay(s, mhTotal, mhTruncated) {
  const lines = [`📊 Отчёт «Отдел продаж» · день ${ddmmFromDate(s.date)}`];
  lines.push(`🎯 Таргетолог: ${s.target != null ? s.target : '—'} · 📥 message.help: ${mhTotal != null ? mhTotal : '—'} · ✍️ написали: ${s.wrote} · ✅ реальных: ${s.real}`);
  if (mhTruncated) lines.push('⚠️ данные неполные: реестр message.help обрезан потолком страниц — число занижено');
  lines.push(`🆕 Новых заявок: ${s.newLeads} · ↩️ продолжений: ${s.ongoing}`);
  lines.push(`⏱ Медиана ответа: ${s.medianMin != null ? s.medianMin + ' мин' : '—'} · 🔴 без ответа: ${s.unanswered}`);
  if (s.kevN != null && (s.kevN || s.kevOverdue)) {
    lines.push(`🤝 КЭВ бота: ${s.kevN} · оформлено ${s.kevDone}`
      + (s.kevLagMedian != null ? ` · лаг ${s.kevLagMedian} мин` : '')
      + (s.kevOverdue ? ` · ⚠️ просрочено ${s.kevOverdue}` : '')
      + (s.kevDirty ? ` · 🧹 грязных ${s.kevDirty}` : ''));
  }
  const junk = [];
  if (s.spam) junk.push(`спам ${s.spam}`);
  if (s.greeting) junk.push(`односложные ${s.greeting}`);
  if (s.noText) junk.push(`без текста ${s.noText}`);
  if (junk.length) lines.push(`🗑 Отсеяно: ${junk.join(' · ')}`);
  return lines.join('\n');
}
function formatSalesPeriod(range, snaps, mhDaily) {
  const byDate = {}; for (const s of snaps) byDate[s.date] = s;
  let sumReg = 0, sumReal = 0, sumNew = 0, sumTarget = 0, daysReg = 0, daysReal = 0, daysTarget = 0;
  let sumKev = 0, sumKevDone = 0, sumKevOverdue = 0, daysKev = 0;
  const perDay = [];
  for (const d of range.dates) {
    const s = byDate[d];
    const reg = s && s.wrote != null ? (mhDaily[d] != null ? mhDaily[d] : s.wrote) : (mhDaily[d] != null ? mhDaily[d] : null);
    const real = s ? s.real : null;
    if (reg != null) { sumReg += reg; daysReg++; }
    if (real != null) { sumReal += real; daysReal++; }
    if (s) { sumNew += s.newLeads || 0; if (s.target != null) { sumTarget += s.target; daysTarget++; } }
    if (s && s.kevN != null) { sumKev += s.kevN; sumKevDone += s.kevDone || 0; sumKevOverdue += s.kevOverdue || 0; daysKev++; }
    if (reg != null || real != null) perDay.push(`${ddmmFromDate(d)} ${reg != null ? reg : '—'}${real != null ? '→' + real : ''}`);
  }
  const lines = [`📊 Отчёт «Отдел продаж» · ${range.label} (${ddmmFromDate(range.from)}–${ddmmFromDate(range.to)})`];
  lines.push(`📥 Лидов в реестре: ${sumReg}${daysReg ? ` (${daysReg} дн)` : ''}`);
  lines.push(`✅ Реальных диалогов: ${daysReal ? sumReal : '—'}${daysReal ? ` (${daysReal} дн с данными)` : ''}`);
  if (daysReal) lines.push(`🆕 Новых заявок: ${sumNew}`);
  if (daysTarget) lines.push(`🎯 Таргетолог (где указан): ${sumTarget}`);
  if (daysKev && sumKev) {
    lines.push(`🤝 КЭВ бота: ${sumKev} · оформлено ${sumKevDone} (${pct(sumKevDone, sumKev)}%)`
      + (sumKevOverdue ? ` · просрочено ${sumKevOverdue}` : '') + ` — ${daysKev} дн с данными`);
  }
  if (perDay.length) lines.push('— ' + perDay.join(' · '));
  lines.push('ℹ️ Детальная аналитика копится с запуска; за прошлые дни — число лидов из реестра message.help.');
  return lines.join('\n');
}

async function buildSalesReport(env, period, now, custom) {
  if (period === 'day') {
    const snap = await buildDailySnapshot(env, now);
    await saveDailySnapshot(env, snap);
    const mh = await fetchMhNewContacts(env, snap.date);
    return formatSalesDay(snap, mh.total, mh.truncated);
  }
  const range = custom || periodRange(period, now);
  const snaps = [];
  for (const d of range.dates) { const s = await env.PULSE_KV.get(`daily:${d}`, { type: 'json' }); if (s) snaps.push(s); }
  const today = almatyDateStr(now);
  if (range.dates.includes(today) && !snaps.some((s) => s.date === today)) {
    const t = await buildDailySnapshot(env, now); await saveDailySnapshot(env, t); snaps.push(t);
  }
  const mhDaily = await fetchMhDailyCounts(env);
  return formatSalesPeriod(range, snaps, mhDaily);
}

/* ── Altegio: KPI администраторов (журнал записей) ──────────────────────────── */

// Двойной токен Altegio: партнёр + пользователь (owner).
function altegioHeaders(token, env) {
  return { Authorization: `Bearer ${env.ALTEGIO_PARTNER_TOKEN}, User ${token}`, Accept: ALTEGIO_ACCEPT };
}

// Owner user_token: 1) кэш KV, 2) re-auth по логину/паролю владельца, 3) готовый секрет.
// app-токен «Карточки клиентов» сюда НЕ годится (403 на /records) — нужен owner.
async function altegioUserToken(env) {
  if (env.ALTEGIO_OWNER_LOGIN && env.ALTEGIO_OWNER_PASSWORD && env.ALTEGIO_PARTNER_TOKEN) {
    try {
      const cached = await env.PULSE_KV.get(ALTEGIO_TOKEN_KEY);
      if (cached) return cached;
      const res = await fetch(`${ALTEGIO_API}/auth`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.ALTEGIO_PARTNER_TOKEN}`, Accept: ALTEGIO_ACCEPT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: env.ALTEGIO_OWNER_LOGIN, password: env.ALTEGIO_OWNER_PASSWORD }),
      });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        const tok = j && j.data && j.data.user_token;
        if (tok) { await env.PULSE_KV.put(ALTEGIO_TOKEN_KEY, tok, { expirationTtl: ALTEGIO_TOKEN_TTL }); return tok; }
      } else { console.error('altegio auth:', res.status); }
    } catch (e) { console.error('altegio auth error:', e && e.message); }
  }
  return env.ALTEGIO_USER_TOKEN || null; // фоллбэк: готовый owner-токен секретом
}

// Записи, СОЗДАННЫЕ в диапазоне дат (c_start_date/c_end_date — по дате оформления).
// Пагинация по 200; страховой потолок страниц — на случай большого окна.
async function fetchAltegioRecords(env, token, startDate, endDate) {
  const co = env.ALTEGIO_COMPANY_ID;
  if (!co || !token) return null;
  const H = altegioHeaders(token, env);
  const out = [];
  for (let page = 1; page <= 25; page++) {
    let r;
    try { r = await fetch(`${ALTEGIO_API}/records/${co}?c_start_date=${startDate}&c_end_date=${endDate}&count=200&page=${page}`, { headers: H }); }
    catch (e) { console.error('altegio records error:', e && e.message); break; }
    if (!r.ok) { console.error('altegio records:', r.status); if (page === 1) return null; break; }
    const j = await r.json().catch(() => null);
    const arr = (j && j.data) || [];
    if (!Array.isArray(arr) || !arr.length) break;
    out.push(...arr);
    if (arr.length < 200) break;
    // Дошли до потолка страниц, а последняя ещё полная → данные обрезаны (honesty WS-1).
    if (page === 25) { out.truncated = true; console.warn(`[altegio] потолок 25 стр (${out.length} записей) — диапазон обрезан`); }
  }
  return out;
}

// Доходные транзакции за период → выручка с разрезом курсы/услуги + привязка к записи.
// sold_item_type: 'goods_transaction' (курсы/абонементы — обычно НЕ привязаны к записи-броне,
// продаются на консультации) · 'service' (услуга — привязана к записи через record_id).
async function fetchAltegioTransactions(env, token, from, to) {
  const co = env.ALTEGIO_COMPANY_ID;
  if (!co || !token) return null;
  const H = altegioHeaders(token, env);
  const byRecord = new Map();
  let total = 0, goods = 0, service = 0, count = 0;
  for (let page = 1; page <= 30; page++) {
    let r;
    try { r = await fetch(`${ALTEGIO_API}/transactions/${co}?start_date=${from}&end_date=${to}&count=200&page=${page}`, { headers: H }); }
    catch (e) { console.error('altegio txn error:', e && e.message); break; }
    if (!r.ok) { console.error('altegio txn:', r.status); break; }
    const j = await r.json().catch(() => null);
    const arr = (j && j.data) || [];
    if (!Array.isArray(arr) || !arr.length) break;
    for (const t of arr) {
      const amt = Number(t.amount) || 0;
      if (t.expense === 1 || amt <= 0) continue; // только доход (расходы/возвраты пропускаем)
      total += amt; count++;
      if (t.sold_item_type === 'goods_transaction') goods += amt;
      else if (t.sold_item_type === 'service') service += amt;
      if (t.record_id) byRecord.set(t.record_id, (byRecord.get(t.record_id) || 0) + amt);
    }
    if (arr.length < 200) break;
  }
  return { byRecord, total, goods, service, count };
}

// Деньги за сегодня (Алматы) для «Итога дня» (WS-1): выручка + разрез курсы/услуги
// + число оформленных сегодня записей. Один проход Altegio (transactions + records);
// результат кладём в metrics.money, откуда его берут и formatFinal, и персона РОП —
// Altegio дважды не дёргаем. null = нет owner-токена / Altegio недоступен.
async function fetchDayMoney(env, now) {
  const token = await altegioUserToken(env);
  if (!token) return null;
  const day = almatyDateStr(now);
  const txn = await fetchAltegioTransactions(env, token, day, day);
  const records = await fetchAltegioRecords(env, token, day, day);
  if (!txn && records == null) return null;
  return {
    total: txn ? txn.total : 0,
    goods: txn ? txn.goods : 0,
    service: txn ? txn.service : 0,
    recordsCreated: records == null ? null : records.filter((r) => r && !r.deleted).length,
    // Авто-записи бота на консультацию, СОЗДАННЫЕ сегодня (из тех же записей — без доп. запроса).
    botBookings: records == null ? null : countBotConsult(records, almatyTimeTs(day, 0), now),
    truncated: !!(records && records.truncated), // журнал обрезан потолком выгрузки (honesty WS-1)
  };
}

/* ── Ночные авто-записи бота на консультацию (Altegio book_record) ──────────────
 * mh-bot ночью сам оформляет консультации через book_record с комментарием
 * «Запись через бота (КЭВ-консультация) [чат-бот]». По фразе «через бота» отличаем
 * их от РУЧНЫХ записей менеджеров (у тех маркер [чат-бот] есть, а этой фразы — нет).
 * Пульс показывает их в утренней (за ночь) и вечерней (за день) сводке. */
const BOT_BOOKING_COMMENT = /через\s*бота/i;
function isBotConsultRecord(r) {
  return !!(r && !r.deleted && BOT_BOOKING_COMMENT.test(String(r.comment || '')));
}
// Из массива записей Altegio — те, что бот оформил в окне [fromTs, toTs] по create_date.
function countBotConsult(records, fromTs, toTs) {
  const list = [];
  for (const r of (records || [])) {
    if (!isBotConsultRecord(r)) continue;
    const created = parseAltegioCreateTs(r.create_date);
    if (created == null || created < fromTs || created > toTs) continue;
    list.push({
      name: (r.client && r.client.name) || '',
      phone: (r.client && r.client.phone) || '',
      datetime: r.datetime || r.date || '',
      staff: (r.staff && r.staff.name) || '',
      createdBy: r.created_user_id != null ? r.created_user_id : null, // для диагностики ?nightbook=
    });
  }
  list.sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
  return { count: list.length, list };
}
// Запрос + подсчёт авто-записей бота за окно [fromTs, toTs] (отдельный fetch — для утра).
async function fetchBotConsultBookings(env, fromTs, toTs) {
  const token = await altegioUserToken(env);
  if (!token) return null;
  const recs = await fetchAltegioRecords(env, token, almatyDateStr(fromTs), almatyDateStr(toTs));
  if (recs == null) return null;
  const r = countBotConsult(recs, fromTs, toTs);
  r.truncated = !!(recs && recs.truncated);
  return r;
}
// Блок строк для сводки: «🌙 Ночью бот записал на консультацию: N» + список.
function nightBookingsBlock(nb) {
  if (!nb || !nb.count) return [];
  const out = [`🌙 Ночью бот записал на консультацию: ${nb.count}`];
  for (const b of nb.list.slice(0, 8)) {
    out.push(`• ${b.name || contactLabel({ phone: b.phone })} — ${fmtRecDatetime(b.datetime)}${b.staff ? ' · ' + b.staff : ''}`);
  }
  if (nb.list.length > 8) out.push(`…и ещё ${nb.list.length - 8}`);
  if (nb.truncated) out.push('⚠️ данные неполные: журнал Altegio обрезан');
  return out;
}
// «2026-06-14 16:00:00» → «14.06 16:00».
function fmtRecDatetime(dt) {
  const m = String(dt || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : String(dt || '—');
}

// Карта user_id → имя администратора (кэш сутки). Фоллбэк — ADMIN_NAMES.
async function fetchAltegioUsers(env, token) {
  try {
    const cached = await env.PULSE_KV.get(ALTEGIO_USERS_KEY, { type: 'json' });
    if (cached) return cached;
    const r = await fetch(`${ALTEGIO_API}/company/${env.ALTEGIO_COMPANY_ID}/users`, { headers: altegioHeaders(token, env) });
    if (!r.ok) { console.error('altegio users:', r.status); return { ...ADMIN_NAMES }; }
    const j = await r.json().catch(() => null);
    const map = { ...ADMIN_NAMES };
    for (const u of (j && j.data) || []) if (u && u.id) map[u.id] = u.name || map[u.id] || `#${u.id}`;
    await env.PULSE_KV.put(ALTEGIO_USERS_KEY, JSON.stringify(map), { expirationTtl: 86400 });
    return map;
  } catch (e) { console.error('altegio users error:', e && e.message); return { ...ADMIN_NAMES }; }
}

// Автор записи — интеграция/онлайн, а не человек-админ (Message.Help, формы, наши «Карточки»).
// Их брони не относим к работе администратора, но считаем в общей воронке.
function isAutoCreator(name) {
  return /интеграц|message\.?help|карточк|форм|онлайн|\bapi\b|бот/i.test(String(name || ''));
}

// Воронка по администраторам: оформленные записи и их доходимость.
// attendance: 1=пришёл, -1=не пришёл/отмена, 0=ждёт, 2=подтвердил но не отмечен →
// «дошёл»/«неявка» считаем ТОЛЬКО по 1/-1 (2 и 0 — ещё не разрешено, в «ждут»).
function computeAdminFunnel(records, usersMap, txn) {
  const byRecord = (txn && txn.byRecord) || null;
  const by = new Map();
  const agg = { total: 0, confirmed: 0, attended: 0, noshow: 0, waiting: 0 };
  const auto = { total: 0, attended: 0, noshow: 0, waiting: 0 };
  for (const r of records) {
    if (!r || r.deleted) continue;
    const att = r.attendance === 1 ? 'attended' : r.attendance === -1 ? 'noshow' : 'waiting';
    agg.total++; agg[att]++;
    if (r.confirmed === 1) agg.confirmed++;
    const uid = r.created_user_id || 0;
    const name = (usersMap && usersMap[uid]) || ADMIN_NAMES[uid] || (uid ? `#${uid}` : 'не указан');
    if (uid === 0 || isAutoCreator(name)) { auto.total++; auto[att]++; continue; }
    if (!by.has(uid)) by.set(uid, { uid, name, total: 0, confirmed: 0, attended: 0, noshow: 0, waiting: 0, revenue: 0, paidVisits: 0, paid: 0, priceFull: 0, pricePay: 0, paidSvc: 0, zeroSvc: 0, services: {} });
    const a = by.get(uid);
    a.total++; a[att]++;
    if (r.confirmed === 1) a.confirmed++;
    // Выручка (привязанные оплаты по record_id) — реальные деньги за услуги этого админа.
    if (byRecord) { const rv = byRecord.get(r.id) || 0; if (rv > 0) { a.revenue += rv; a.paidVisits++; } }
    // Услуги записи: цена-прайс (first_cost) vs к оплате (cost_to_pay) → скидка; 0₸-записи.
    const svcs = r.services || [];
    a.priceFull += svcs.reduce((s, v) => s + (v.first_cost || v.cost || 0), 0);
    a.pricePay += svcs.reduce((s, v) => s + (v.cost_to_pay || v.cost || 0), 0);
    if (svcs.some((v) => (v.cost_to_pay || v.cost || 0) > 0)) { a.paidSvc++; if (r.paid_full === 1) a.paid++; }
    else a.zeroSvc++;
    for (const v of svcs) if (v.title) a.services[v.title] = (a.services[v.title] || 0) + 1;
  }
  for (const a of by.values()) {
    a.topServices = Object.entries(a.services).sort((x, y) => y[1] - x[1]).slice(0, 3).map((e) => e[0]);
    a.avgCheck = a.revenue && a.paidVisits ? Math.round(a.revenue / a.paidVisits) : null;
    a.discount = a.priceFull > 0 ? Math.round((1 - a.pricePay / a.priceFull) * 100) : null;
  }
  return { ...agg, admins: [...by.values()].sort((x, y) => y.total - x.total), auto, money: txn || null,
    recordsTruncated: !!(records && records.truncated) }; // журнал обрезан потолком выгрузки (honesty WS-1)
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

// Раздел «Администраторы» = низ воронки: записи → доходимость → неявка (только из Altegio).
// Лиды/«сколько из лидов» живут в разделе «Отдел продаж» (Сверка лидов): записей много
// больше лидов (повторные клиенты), поэтому «записи/лиды» — НЕ конверсия, не показываем.
const fmtTg = (n) => Number(n || 0).toLocaleString('ru-RU'); // 12150270 → «12 150 270»
function formatAdminReport(label, range, funnel) {
  const f = funnel;
  const lines = [`🗂 Отчёт «Администраторы» · ${label} (${ddmmFromDate(range.from)}–${ddmmFromDate(range.to)})`];
  const resolved = f.attended + f.noshow;                 // визиты с финальным исходом (пришёл/нет)
  const reach = pct(f.attended, resolved);                // доходимость среди разрешённых (1/-1)
  const bits = [`📝 записей ${f.total}`, `✅ дошли ${f.attended}`, `❌ неявка ${f.noshow}`];
  if (f.waiting) bits.push(`⏳ ждут ${f.waiting}`);
  lines.push(bits.join(' · '));
  if (f.recordsTruncated) lines.push('⚠️ данные неполные: журнал записей обрезан потолком выгрузки — цифры занижены, сузьте период');
  // Доходимость честна только когда визиты состоялись; если большинство впереди — помечаем «предварительно».
  if (resolved === 0) lines.push(`Доходимость: — (все ${f.waiting} визитов ещё впереди)`);
  else if (f.waiting > resolved) lines.push(`Доходимость (по ${resolved} состоявшимся): ${reach}% · ещё ${f.waiting} впереди`);
  else lines.push(`Доходимость: ${reach}% · неявка ${100 - reach}%`);
  // Деньги компании за период: курсы (товары) vs услуги.
  if (f.money && f.money.total) {
    lines.push(`💰 Выручка периода: ${fmtTg(f.money.total)}₸ (курсы ${pct(f.money.goods, f.money.total)}% · услуги ${pct(f.money.service, f.money.total)}%)`);
  }
  // По администраторам — расширенно (2–3 строки на каждого).
  if (f.admins.length) {
    lines.push('');
    lines.push('По администраторам:');
    for (const a of f.admins.slice(0, 10)) {
      const ar = pct(a.attended, a.attended + a.noshow);
      lines.push(`• ${a.name} — ${a.total} зап · дошли ${a.attended}/неявка ${a.noshow} · доход. ${ar != null ? ar + '%' : '—'}`);
      const money = [];
      if (a.revenue) money.push(`💰 услуг ${fmtTg(a.revenue)}₸`);
      if (a.avgCheck) money.push(`ср.чек ${fmtTg(a.avgCheck)}₸`);
      if (a.discount != null) money.push(`скидка ${a.discount}%`);
      if (money.length) lines.push(`   ${money.join(' · ')}`);
      const extra = [];
      if (a.zeroSvc) extra.push(`0₸-записей ${pct(a.zeroSvc, a.total)}%`);
      if (a.topServices && a.topServices.length) extra.push(`топ: ${a.topServices.join(', ')}`);
      if (extra.length) lines.push(`   ${extra.join(' · ')}`);
    }
  }
  // Авто/онлайн-запись (интеграции, не работа админа) — отдельной строкой, если есть.
  if (f.auto && f.auto.total) {
    lines.push(`🤖 Авто/онлайн-запись: ${f.auto.total} (дошли ${f.auto.attended}/неявка ${f.auto.noshow})`);
  }
  lines.push('');
  lines.push('ℹ️ Записи — по дате оформления (вкл. повторных). «Выручка услуг» — привязанные оплаты (часть транзакций); деньги за курс атрибутируются мастеру, не админу. «0₸» = консультации/отработка курса/услуга не проставлена. Скидка = прайс vs к оплате.');
  return lines.join('\n');
}

// Отчёт по администраторам за период — реальная воронка Altegio.
async function buildAdminReport(env, period, now, custom) {
  const range = custom || periodRange(period, now);
  const label = range.label || (period === 'week' ? 'неделя' : period === 'month' ? 'месяц' : period === 'custom' ? 'период' : 'день');
  const token = await altegioUserToken(env);
  if (!token) {
    return `🗂 Отчёт «Администраторы» · ${label}\n\n`
      + 'Не настроен доступ к Altegio. Добавьте секреты owner-доступа:\n'
      + 'ALTEGIO_PARTNER_TOKEN + ALTEGIO_OWNER_LOGIN + ALTEGIO_OWNER_PASSWORD\n'
      + '(или готовый ALTEGIO_USER_TOKEN) и var ALTEGIO_COMPANY_ID.';
  }
  const records = await fetchAltegioRecords(env, token, range.from, range.to);
  if (records == null) {
    return `🗂 Отчёт «Администраторы» · ${label}\n\n`
      + 'Altegio не отдал записи (нет прав/ошибка API). Нужен owner-токен с доступом к «Журналу записи».';
  }
  const usersMap = await fetchAltegioUsers(env, token);
  const txn = await fetchAltegioTransactions(env, token, range.from, range.to);
  const funnel = computeAdminFunnel(records, usersMap, txn);
  return formatAdminReport(label, range, funnel);
}

/* ============================================================
 * ФОРМАТ ОТЧЁТА (раздел 6 ТЗ)
 * ============================================================ */

// Честная строка о неполноте данных (WS-1): если потолок реально сработал —
// называем, что обрезано, а не молчим. '' = всё посчитано полностью.
function truncationNote(m) {
  const bits = [];
  if (m.judgeUnjudged) bits.push(`ИИ-проверку прошли не все зависшие (+${m.judgeUnjudged} без проверки)`);
  if (m.refineUnchecked) bits.push(`${m.refineUnchecked} зависших не проверены на блокировку`);
  if (m.money && m.money.truncated) bits.push('журнал записей Altegio обрезан потолком выгрузки');
  return bits.length ? `⚠️ данные неполные: ${bits.join('; ')}` : '';
}

// Подпись зависшего диалога: телефон (для WhatsApp), иначе имя, иначе внутренний №.
// Телефон message.help отдаёт как wa_id (цифры E.164 без «+») — добавляем «+».
function contactLabel(u) {
  const digits = String(u.phone || '').replace(/\D/g, '');
  if (digits.length >= 8) return '+' + digits;
  if (u.name) return u.name;
  return '№' + u.dialogId;
}

// Промежуточный отчёт — 08:00 / 11:00 / 14:00 / 17:00 / 20:00.
function formatIntermediate(m, parts, smart) {
  const lines = [`📊 Пульс продаж · ${parts.hhmm} · ${parts.ddmm}`];

  lines.push(`Всего за день: ${m.todayLeads} ${plural(m.todayLeads, ['обращение', 'обращения', 'обращений'])} · из них новых: ${m.newLeads}`);

  let l2 = `За час: +${m.deltaNew} новых`;
  if (m.todayMedianMin != null) l2 += ` · скорость первого ответа ${m.todayMedianMin} мин`;
  lines.push(l2);

  // Утренняя сводка ночных авто-записей бота (заполняется только в 08:00).
  for (const nbl of nightBookingsBlock(m.nightBookings)) lines.push(nbl);

  if (m.unanswered.length) {
    lines.push('🔴 Сейчас без ответа:');
    for (const u of m.unanswered.slice(0, 5)) {
      const tag = u.isNew ? '🆕' : '↩️';
      const why = u.aiReason ? `${u.aiReason} · ` : '';
      lines.push(`• ${tag} ${contactLabel(u)} — ${why}ждёт ${u.waitedMin} мин`);
    }
    if (m.unanswered.length > 5) lines.push(`…и ещё ${m.unanswered.length - 5}`);
  }

  const kevLine = formatKevLine(m.kev);
  if (kevLine) lines.push(kevLine);

  const action = cleanSmart(smart);
  if (action) lines.push(`⚡ Действие: ${action}`);
  const note = truncationNote(m);
  if (note) lines.push(note);
  return lines.join('\n');
}

// Итоговый отчёт дня — 21:00 (конец рабочего дня).
function formatFinal(m, parts, smart) {
  const lines = [`📊 Пульс продаж · Итог дня · ${parts.ddmm}`];

  let day = `Всего за день: ${m.todayLeads} ${plural(m.todayLeads, ['обращение', 'обращения', 'обращений'])} · из них новых: ${m.newLeads}`;
  if (m.todayMedianMin != null) day += ` · скорость первого ответа ${m.todayMedianMin} мин`;
  lines.push(day);

  if (m.unanswered.length) {
    const top = m.unanswered[0];
    const why = top.aiReason ? `${top.aiReason}, ` : '';
    lines.push(`🔴 Без ответа на конец дня: ${m.unanswered.length} `
      + `(дольше всех ${top.isNew ? '🆕 ' : '↩️ '}${contactLabel(top)} — ${why}${top.waitedMin} мин)`);
  }

  // Деньги дня (WS-1): выручка + разрез курсы/услуги + сколько записей оформлено.
  if (m.money && (m.money.total || m.money.recordsCreated)) {
    const mo = m.money;
    let s = `💰 Выручка дня: ${fmtTg(mo.total)}₸`;
    if (mo.total) s += ` (курсы ${fmtTg(mo.goods)}₸ · услуги ${fmtTg(mo.service)}₸)`;
    if (mo.recordsCreated != null) s += ` · записей оформлено: ${mo.recordsCreated}`;
    lines.push(s);
  }

  // Авто-записи бота на консультацию за сегодня (ночная авто-запись mh-bot).
  if (m.money && m.money.botBookings && m.money.botBookings.count) {
    lines.push(`🤖 Бот оформил консультаций за день: ${m.money.botBookings.count}`);
  }

  const kevLine = formatKevLine(m.kev);
  if (kevLine) lines.push(kevLine);
  if (m.kev && m.kev.dirty && m.kev.dirtyIssues && m.kev.dirtyIssues.length) {
    lines.push('🧹 «Грязные» записи по КЭВ (нет маркера / услуга не совпала):');
    for (const d of m.kev.dirtyIssues.slice(0, 5)) lines.push(`• ${d}`);
  }

  // callPersona для итога возвращает «вывод дня\nдействие на завтра».
  const parsed = String(smart || '').split('\n').map(cleanSmart).filter(Boolean);
  if (parsed[0]) lines.push(parsed[0]);
  const zavtra = parsed.slice(1).join(' ');
  if (zavtra) lines.push(`⚡ На завтра: ${zavtra}`);
  const note = truncationNote(m);
  if (note) lines.push(note);
  return lines.join('\n');
}

// Чистка текста от LLM: убираем ведущие ⚡, нумерацию, ярлыки, кавычки.
function cleanSmart(text) {
  return String(text || '')
    .replace(/^\s*⚡\s*/, '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/^\s*(строка\s*\d+|действие(?:\s*на\s*завтра)?|вывод|на\s*завтра|итог)\s*[:\-—]\s*/i, '')
    .replace(/^["'«»\s]+/, '')
    .replace(/["'«»\s]+$/, '')
    .trim();
}

/* ============================================================
 * ПЕРСОНА РОП — Claude API (короткий блок «на что смотреть»)
 * ============================================================ */

// Цифры считает код; персона лишь пишет 1–2 приоритетных действия голосом РОП.
async function callPersona(env, metrics, parts, isFinal) {
  const userPrompt = isFinal
    ? buildFinalPrompt(metrics, parts)
    : buildIntermediatePrompt(metrics, parts);
  const text = await callClaude(env, userPrompt);
  // LLM недоступен — дайджест всё равно выходит с детерминированным действием.
  return text || fallbackAction(metrics, isFinal);
}

function buildIntermediatePrompt(m, parts) {
  const lines = [
    `Пульс продаж студии M&M на ${parts.hhmm}, ${parts.ddmm}. Данные — по живому потоку`,
    `сообщений WhatsApp/Instagram в CRM (живые обращения, без комментариев и реакций).`,
    '',
    'Цифры:',
    `- новых заявок с утра (первое обращение): ${m.newLeads}`,
    `- продолжений диалогов (действующие, писали раньше): ${m.ongoing}`,
    m.todayMedianMin != null
      ? `- медиана первого ответа за день: ${m.todayMedianMin} мин`
      : '- медиана первого ответа за день: данных нет',
    `- за последний час: +${m.deltaNew} новых заявок`
      + (m.deltaMedianMin != null ? `, медиана ответа ${m.deltaMedianMin} мин` : ''),
  ];
  if (m.unanswered.length) {
    lines.push(`- сейчас без ответа дольше порога: ${m.unanswered.length}`);
    for (const u of m.unanswered.slice(0, 5)) {
      lines.push(`  • ${contactLabel(u)} — ${u.aiReason ? u.aiReason + ', ' : ''}клиент ждёт ${u.waitedMin} мин`);
    }
  } else {
    lines.push('- зависших без ответа сейчас нет');
  }
  if (m.kev && m.kev.n) {
    lines.push(`- КЭВ ночного бота (готовые договорённости о визите): ${m.kev.n}, `
      + `оформлено записей в Altegio: ${m.kev.done}, просрочено: ${m.kev.overdue}`
      + (m.kev.lagMedianMin != null ? `, медианный лаг оформления ${m.kev.lagMedianMin} мин` : '')
      + '. КЭВ без записи = почти готовый клиент теряется на ровном месте.');
  }
  lines.push(
    '',
    'Это короткий пульс в рабочий чат отдела, выходит каждый час. Дай блок «на что',
    'смотреть»: 1–2 приоритетных действия голосом РОП — конкретно, по делу, без',
    'вступления и заголовков, максимум 2 коротких предложения. Начинай с глагола. Не',
    'называй сотрудников по именам — пиши «в работе», «подхватите». Не выдумывай цифр',
    'сверх тех, что выше. Если всё ровно — одно короткое подбадривающее предложение.',
    'Ответь только текстом действия, без кавычек и без префиксов.',
  );
  return lines.join('\n');
}

function buildFinalPrompt(m, parts) {
  return [
    `Итог дня по продажам студии M&M, ${parts.ddmm}. Данные — по живому потоку`,
    'сообщений WhatsApp/Instagram в CRM.',
    '',
    'Цифры за день:',
    `- новых заявок (новые контакты): ${m.newLeads}`,
    `- продолжений диалогов (действующие): ${m.ongoing}`,
    m.todayMedianMin != null
      ? `- медиана первого ответа: ${m.todayMedianMin} мин`
      : '- медиана первого ответа: данных нет',
    `- осталось без ответа на конец дня: ${m.unanswered.length}`,
    ...(m.money && (m.money.total || m.money.recordsCreated) ? [
      `- выручка за день: ${m.money.total} ₸ (курсы ${m.money.goods} ₸, разовые услуги ${m.money.service} ₸`
      + (m.money.recordsCreated != null ? `; оформлено записей ${m.money.recordsCreated}` : '') + ')',
    ] : []),
    ...(m.kev && m.kev.n ? [
      `- КЭВ ночного бота: ${m.kev.n}, оформлено записей: ${m.kev.done}, `
      + `просрочено: ${m.kev.overdue}, «грязных» записей: ${m.kev.dirty}`
      + (m.kev.lagMedianMin != null ? `, медианный лаг ${m.kev.lagMedianMin} мин` : ''),
    ] : []),
    '',
    'Это итоговый пульс дня в рабочий чат отдела. Дай ровно две строки, голосом РОП,',
    'конкретно, без заголовков:',
    'Строка 1 — главный вывод дня одной фразой; если есть выручка — опирайся на деньги',
    '(курс важнее разовой услуги), а не только на число заявок.',
    'Строка 2 — одно конкретное действие на завтра.',
    'Не выдумывай цифр сверх тех, что выше. Не называй сотрудников по именам.',
    'Ответь только этими двумя строками, без нумерации и кавычек.',
  ].join('\n');
}

// Запасной текст, если Claude недоступен — дайджест не должен молчать.
function fallbackAction(m, isFinal) {
  if (isFinal) {
    return m.unanswered.length
      ? `День закрыли с ${m.unanswered.length} зависшими заявками.\n`
        + 'Завтра с утра первым делом разобрать незакрытые диалоги.'
      : 'День отработан, заявки без ответа не зависли.\n'
        + 'Завтра держим тот же темп ответа.';
  }
  if (m.unanswered.length) {
    return 'подхватите зависшие заявки выше — они ждут дольше порога, клиенты остывают.';
  }
  return 'темп хороший, держите скорость первого ответа такой же.';
}

// Вызов Claude API: raw fetch, кэш системного промпта, retry на 429/5xx.
async function callClaude(env, userPrompt, opts = {}) {
  const payload = {
    model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: opts.maxTokens || CLAUDE_MAX_TOKENS,
    temperature: opts.temperature != null ? opts.temperature : CLAUDE_TEMPERATURE,
    system: [{ type: 'text', text: opts.system || PERSONA_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(anthropicUrl(env), {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error('claude fetch error:', e && e.message);
      await sleep(500 * (attempt + 1));
      continue;
    }

    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (!data) return '';
      const u = data.usage || {};
      console.log(`claude ok cache_read=${u.cache_read_input_tokens || 0} `
        + `in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
      if (data.stop_reason === 'refusal') return '';
      const block = (data.content || []).find((b) => b.type === 'text');
      return block ? block.text.trim() : '';
    }

    // 429 / 5xx — ретраить; прочие 4xx — нет смысла.
    if (res.status !== 429 && res.status < 500) {
      console.error(`claude api ${res.status}:`, (await res.text()).slice(0, 200));
      return '';
    }
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    await sleep(retryAfter ? retryAfter * 1000 : 800 * (attempt + 1));
  }
  console.error('claude api: retries exhausted');
  return '';
}

/* ============================================================
 * ИИ-СУДЬЯ «без ответа» — бот сам читает диалог и решает
 * ============================================================ */

// Системный промпт классификатора: НЕ персона РОП, а сухой контролёр.
const JUDGE_PROMPT = `Ты — контролёр чата отдела продаж бьюти-студии M&M. На входе несколько диалогов с клиентами: реплики «Клиент»/«Менеджер»/«Бот» по времени (история ~2 дня, текст может быть обрезан).

«Бот» — автоответчик студии (ИИ): он отвечает на вопросы и собирает заявки, но НЕ оформляет записи и не решает сложные вопросы. Если бот уже ответил клиенту по сути и действий человека не требуется — needs_reply=false. Если клиент ждёт действия ЧЕЛОВЕКА (оформить запись, перенести, отменить, перезвонить, цена курса, жалоба) — needs_reply=true, даже если бот что-то ответил.

Для КАЖДОГО диалога реши: нужен ли СЕЙЧАС ответ менеджера клиенту.

needs_reply = false (отвечать НЕ нужно), если:
- менеджер уже ответил на вопрос/запрос, и сейчас ход за клиентом (ждём его решения/прихода);
- клиент завершил вежливо: «спасибо», «хорошо», «договорились», «приду», смайлик/реакция;
- клиент УЖЕ ЗАПИСАН (в истории было «Вы записаны»/«Подтвердите запись»/«Ждём вас», клиент подтвердил) и пишет бытовое: «опаздываю», «подтверждаю», «еду», «буду позже», «спасибо», ЛИБО просто уточняет/сдвигает время прихода в тот же день («приду к 10:30», «в 10.20 примерно, даже 10.30», «чуть позже») — это не потерянный лид, даже если ответил только бот. НО если записанный просит ПЕРЕНОС на другой день/ОТМЕНУ/перезвонить — нужен человек (true);
- это спам/реклама/B2B-предложение (отзывы, продвижение, сотрудничество, бренд пишет первым);
- это не клиент: сотрудник, тест, авто-сообщение, подтверждение записи.

needs_reply = true (нужен ответ), если клиент задал вопрос или ждёт конкретного действия (записать, цена, адрес, время), а менеджер на это не ответил.

Если сомневаешься — ставь true (лучше показать лишнее, чем спрятать живого клиента).

reason — КОРОТКО, 2-4 слова, суть. БЕЗ слов «клиент», «ждёт», «нет ответа» (это и так понятно).
- если true — что нужно клиенту: «спросил цену», «прислал файлы», «просит записать», «уточняет адрес», «просит перезвонить».
- если false — почему не нужно: «подтвердил приход», «уже пришёл», «спам-бренд», «входящий звонок», «поблагодарил».

Верни СТРОГО JSON-массив по всем idx, без текста вокруг:
[{"idx":0,"needs_reply":true,"reason":"спросил цену"}, ...]`;

// Бот читает транскрипты зависших диалогов (из событий KV) и сам решает, какие реально
// без ответа. Консервативно: сбой/нет вердикта → диалог ОСТАЁТСЯ в списке (не прячем).
async function judgeUnanswered(env, metrics, events) {
  const items = metrics.unanswered;
  if (!items.length) return;

  // Контекст за 48 ч (вчера+сегодня): чтобы видеть, что клиент уже записан/подтвердил —
  // подтверждение записи могло прийти вчера, а сегодня клиент пишет «опаздываю».
  let ctx = events;
  try {
    const yRaw = (await env.PULSE_KV.get(`events:${almatyDateStr(Date.now() - 86400000)}`, { type: 'json' })) || [];
    if (yRaw.length) ctx = yRaw.concat(events);
  } catch (_) { /* нет вчерашнего бакета — работаем по сегодня */ }
  const byDialog = new Map();
  for (const e of ctx) { const a = byDialog.get(e.dialog_id) || []; a.push(e); byDialog.set(e.dialog_id, a); }

  const audit = [];
  // Детерминированный отсев: клиент УЖЕ записан (был шаблон «Вы записаны/Подтвердите»),
  // а пишет бытовое (опаздываю/подтверждаю/еду/спасибо) → не потерянный лид, отработан.
  const afterBooked = [];
  for (const u of items) {
    const evs = byDialog.get(u.dialogId) || [];
    const booked = evs.some((e) => e.direction === 'operator' && BOOKING_CONFIRM.test(e.text || ''));
    const lastClient = evs.filter((e) => e.direction === 'client' && e.text).slice(-1)[0];
    const lt = lastClient ? (lastClient.text || '') : '';
    // Записан + последнее сообщение бытовое (подтверждение/благодарность) ИЛИ сдвиг
    // времени прихода — не потерянный лид. НО перенос/отмена/перезвон — это нужен
    // человек, такое НЕ гасим (даже если в тексте мелькает время).
    const bookedRoutine = booked && lastClient && !NEEDS_HUMAN_BOOKED.test(lt)
      && (LOGISTICS_HINT.test(lt) || ARRIVAL_TIME_HINT.test(lt));
    if (bookedRoutine) {
      audit.push({ label: contactLabel(u), needs_reply: false, reason: 'записан, время прихода' });
    } else {
      afterBooked.push(u);
    }
  }

  // ИИ-судья по оставшимся (с 48-часовым транскриптом).
  let kept = afterBooked;
  if (afterBooked.length && env.ANTHROPIC_API_KEY && env.AI_JUDGE !== '0') {
    const judged = afterBooked.slice(0, 20);
    const cases = judged.map((u, idx) => {
      const evs = (byDialog.get(u.dialogId) || []).slice().sort((a, b) => a.ts - b.ts).slice(-14);
      const transcript = evs.map((e) => {
        const who = e.direction === 'client' ? 'Клиент' : (e.bot ? 'Бот' : 'Менеджер');
        const body = e.text ? e.text : `[${e.message_type || 'вложение'}]`;
        return `${who} ${almatyParts(e.ts).hhmm}: ${body}`;
      }).join('\n');
      return { idx, label: contactLabel(u), transcript };
    });
    const userPrompt = [
      'Диалоги с клиентами (история ~2 дня). Для каждого реши, нужен ли сейчас ответ менеджера.',
      '',
      ...cases.map((c) => `### idx=${c.idx} (${c.label})\n${c.transcript || '(текста сообщений нет)'}`),
      '',
      'Верни строго JSON-массив по всем idx.',
    ].join('\n');
    const raw = await callClaude(env, userPrompt, { system: JUDGE_PROMPT, maxTokens: 1200, temperature: 0 });
    const verdicts = parseVerdicts(raw);
    if (verdicts) {
      const keep = [];
      judged.forEach((u, i) => {
        const v = verdicts.get(i);
        const needs = v ? v.needs_reply : true;
        audit.push({ label: contactLabel(u), needs_reply: needs, reason: v ? v.reason : 'не оценён' });
        if (needs) { u.aiReason = v ? v.reason : ''; keep.push(u); }
      });
      kept = keep.concat(afterBooked.slice(20)); // сверх лимита 20 — оставляем как есть
      metrics.judgeUnjudged = Math.max(0, afterBooked.length - 20); // не прошли ИИ-проверку (honesty WS-1)
    } else {
      console.log('[judge] ответ ИИ не разобран — оставляю список');
    }
  }

  metrics.unanswered = kept;
  metrics.aiVerdicts = audit;
  metrics.aiDropped = items.length - kept.length;
  if (metrics.aiDropped) console.log(`[judge] убрано из «без ответа»: ${metrics.aiDropped}`);
}

// Разбор JSON-массива вердиктов. Возвращает Map idx→{needs_reply,reason} или null.
function parseVerdicts(raw) {
  if (!raw) return null;
  const s = raw.indexOf('['); const e = raw.lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  let arr;
  try { arr = JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const m = new Map();
  for (const o of arr) {
    if (o && typeof o.idx === 'number') {
      m.set(o.idx, { needs_reply: o.needs_reply !== false, reason: String(o.reason || '').slice(0, 40) });
    }
  }
  return m.size ? m : null;
}

/* ============================================================
 * TELEGRAM
 * ============================================================ */

// Plain text без parse_mode: формат раздела 6 разметки не требует, а свободный
// текст от LLM с символами * или _ ломал бы Markdown-парсер (5 отправок в день).
async function sendTelegram(env, text) {
  if (typeof text === 'string' && text.length > 4096) text = text.slice(0, 4090) + '…'; // лимит Telegram
  const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`telegram sendMessage ${res.status}: ${t.slice(0, 200)}`);
  }
}

/* ============================================================
 * TELEGRAM — кнопки и приём апдейтов (СМЕНЫ ПРОДАВЦОВ)
 * ============================================================ */

// Общий вызов Telegram Bot API. Не бросает — логирует и возвращает разобранный ответ.
async function tgCall(env, method, payload) {
  if (payload && typeof payload.text === 'string' && payload.text.length > 4096) {
    payload = { ...payload, text: payload.text.slice(0, 4090) + '…' }; // лимит Telegram
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => null);
    if (!j || !j.ok) console.error(`telegram ${method} failed:`, JSON.stringify(j).slice(0, 200));
    return j;
  } catch (e) {
    console.error(`telegram ${method} error:`, e && e.message);
    return null;
  }
}

// ── Сотрудники по ролям (управляют управляющие) ──────────────────────────────
// Два РАЗДЕЛЬНЫХ списка в KV: продавцы (cfg:sellers — отмечают смену) и администраторы
// (cfg:administrators — раздел «Администраторы»). Данные разделов не смешиваются.
const STAFF = {
  sellers: { key: SELLERS_KEY, label: 'продавцы' },
  admins: { key: 'cfg:administrators', label: 'администраторы' },
};
const staffRole = (r) => (r === 'admins' ? 'admins' : 'sellers');
async function loadStaff(env, role) {
  const r = staffRole(role);
  try {
    const v = await env.PULSE_KV.get(STAFF[r].key, { type: 'json' });
    if (Array.isArray(v)) return v;
  } catch (_) { /* ignore */ }
  return r === 'admins' ? [] : seedSellers(env); // продавцы — seed из env.SELLERS; админы стартуют пустыми
}
async function saveStaff(env, role, list) {
  await env.PULSE_KV.put(STAFF[staffRole(role)].key, JSON.stringify(list)); // без TTL — список постоянный
}
// Добавить сотрудника в список роли (строка «Фамилия Имя»). Дубли (без регистра) не плодим.
async function addStaff(env, role, name) {
  const clean = String(name).replace(/\s+/g, ' ').trim();
  const list = await loadStaff(env, role);
  const exists = list.some((s) => s.toLowerCase() === clean.toLowerCase());
  if (clean && !exists) { list.push(clean); await saveStaff(env, role, list); }
  return { list, name: clean, added: !!clean && !exists };
}
async function removeStaff(env, role, idx) {
  const list = await loadStaff(env, role);
  let removed = null;
  if (idx >= 0 && idx < list.length) { removed = list[idx]; list.splice(idx, 1); await saveStaff(env, role, list); }
  return { list, removed };
}
// Смены продавцов используют именно список продавцов.
async function loadSellers(env) { return loadStaff(env, 'sellers'); }

// Клавиатура «кто на смене»: кнопка на каждого сотрудника + «закончить смену».
// callback_data компактный: sh:s:<idx> (индекс в списке сотрудников), sh:e — закрыть.
function shiftKeyboard(sellers) {
  const rows = sellers.map((name, i) => [{ text: `🟢 ${name}`, callback_data: `sh:s:${i}` }]);
  rows.push([{ text: '🔚 Закончить смену', callback_data: 'sh:e' }]);
  return { inline_keyboard: rows };
}

// Панель сотрудников роли (для управляющих): список + кнопки удаления и добавления.
function teamPanelText(role, list) {
  const what = role === 'admins' ? 'Администраторы' : 'Сотрудники (продавцы)';
  const body = list.length ? list.map((s, i) => `${i + 1}. ${s}`).join('\n') : '— пока никого —';
  return `👥 ${what} (${list.length}):\n${body}\n\n🗑 — удалить · ➕ — добавить`;
}
function teamKeyboard(role, list) {
  const r = staffRole(role);
  const rows = list.map((s, i) => [{ text: `🗑 ${s}`, callback_data: `emp:rm:${r}:${i}` }]);
  rows.push([{ text: '➕ Добавить', callback_data: `emp:add:${r}` }]);
  return { inline_keyboard: rows };
}

// ── Главное меню руководителя (две ветки: Отдел продаж / Администраторы) ──────
const MENU_MAIN_TEXT = '🏠 Главное меню. Выберите раздел:';
const MENU_SALES_TEXT = '📊 Отдел продаж — выберите действие:';
const MENU_ADMINS_TEXT = '🗂 Администраторы (работа в Altegio):';
function mainMenuKb() {
  return { inline_keyboard: [
    [{ text: '📊 Отдел продаж', callback_data: 'menu:sales' }],
    [{ text: '🗂 Администраторы', callback_data: 'menu:admins' }],
  ] };
}
function salesMenuKb() {
  return { inline_keyboard: [
    [{ text: '📄 Сформировать отчёт', callback_data: 'sales:report' }],
    [{ text: '📋 Сверка лидов дня', callback_data: 'sales:sverka' }],
    [{ text: '🎯 Ввести лиды таргетолога', callback_data: 'sales:target' }],
    [{ text: '👥 Сотрудники (продавцы)', callback_data: 'team:sellers' }],
    [{ text: '⬅️ Назад', callback_data: 'menu:main' }],
  ] };
}
function adminsMenuKb() {
  return { inline_keyboard: [
    [{ text: '📄 Сформировать отчёт', callback_data: 'admins:report' }],
    [{ text: '👥 Сотрудники (администраторы)', callback_data: 'team:admins' }],
    [{ text: '⬅️ Назад', callback_data: 'menu:main' }],
  ] };
}
// Выбор периода отчёта (sec = 'sales' | 'admins').
function reportPeriodKb(sec) {
  return { inline_keyboard: [
    [{ text: 'День', callback_data: `rep:${sec}:day` }, { text: 'Неделя', callback_data: `rep:${sec}:week` }],
    [{ text: 'Месяц', callback_data: `rep:${sec}:month` }, { text: 'Период', callback_data: `rep:${sec}:custom` }],
    [{ text: '⬅️ Назад', callback_data: `menu:${sec}` }],
  ] };
}
const reportPrompt = (sec) => `${REPORT_PROMPT_MARK} (${sec === 'sales' ? 'продажи' : 'админы'})\n`
  + 'Ответьте на ЭТО сообщение диапазоном дат: ДД.ММ.ГГГГ-ДД.ММ.ГГГГ (например 01.06.2026-07.06.2026).';


// Текст карточки в зависимости от текущей открытой смены.
function shiftCardText(open) {
  if (open && open.manager) {
    return `🟢 На смене: ${open.manager} (с ${almatyParts(open.start).hhmm})\n`
      + 'Сменяетесь — нажмите своё имя. Уходите — «Закончить смену».';
  }
  return '👋 Кто открывает смену? Нажмите своё имя.\n'
    + 'Ответы клиентам в вашу смену засчитываются вам.';
}

async function getOpenShift(env) {
  try { return await env.PULSE_KV.get(SHIFT_OPEN_KEY, { type: 'json' }); }
  catch { return null; }
}

// Закрыть текущую открытую смену (если есть): дописать в журнал дня, очистить shift:open.
async function closeOpenShift(env, endTs) {
  const open = await getOpenShift(env);
  if (!open || !open.manager) return null;
  const end = endTs || Date.now();
  const key = shiftsKey(almatyDateStr(open.start));
  const log = (await env.PULSE_KV.get(key, { type: 'json' })) || [];
  log.push({ manager: open.manager, start: open.start, end, by: open.by || '' });
  await env.PULSE_KV.put(key, JSON.stringify(log), { expirationTtl: EVENTS_TTL });
  await env.PULSE_KV.delete(SHIFT_OPEN_KEY);
  return { ...open, end };
}

// Открыть смену продавца. Предыдущую (если была) сперва закрываем — смены не пересекаются.
async function openShift(env, manager, startTs, by) {
  await closeOpenShift(env, startTs);
  const open = { manager, start: startTs || Date.now(), by: by || '' };
  await env.PULSE_KV.put(SHIFT_OPEN_KEY, JSON.stringify(open), { expirationTtl: EVENTS_TTL });
  return open;
}

// Опубликовать карточку смены в рабочий чат (утром авто либо вручную ?shiftcard=).
async function postShiftCard(env) {
  const sellers = await loadSellers(env);
  if (!sellers.length) {
    console.log('[shift] список сотрудников пуст — карточку не публикуем');
    return { ok: false, reason: 'no_sellers' };
  }
  const open = await getOpenShift(env);
  const j = await tgCall(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: shiftCardText(open),
    reply_markup: shiftKeyboard(sellers),
    disable_web_page_preview: true,
  });
  return { ok: !!(j && j.ok), message_id: j && j.result && j.result.message_id };
}

// Обновить текст+клавиатуру сообщения (карточка смены / панель сотрудников).
async function editTgMessage(env, chatId, msgId, text, keyboard) {
  if (!chatId || !msgId) return;
  await tgCall(env, 'editMessageText', {
    chat_id: chatId, message_id: msgId, text,
    reply_markup: keyboard, disable_web_page_preview: true,
  });
}
// Короткий ответ в чат (DM или группа).
async function tgReply(env, chatId, text) {
  if (chatId) await tgCall(env, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

// Приём апдейта Telegram: кнопки (callback) и команды/ответы (message).
async function handleTelegramUpdate(update, env) {
  if (update && update.callback_query) return handleCallback(env, update.callback_query);
  if (update && update.message) return handleMessage(env, update.message);
}

// Нажатия кнопок. Смены — для всех сотрудников; управление сотрудниками — только управляющие.
async function handleCallback(env, cq) {
  const data = String(cq.data || '');
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const msgId = cq.message && cq.message.message_id;
  const fromId = cq.from && cq.from.id;
  const by = (cq.from && (cq.from.first_name || cq.from.username)) || '';
  const answer = (text) => tgCall(env, 'answerCallbackQuery',
    text ? { callback_query_id: cq.id, text } : { callback_query_id: cq.id });
  const now = Date.now();

  if (data.startsWith('sh:s:')) {
    const sellers = await loadSellers(env);
    const name = sellers[parseInt(data.slice(5), 10)];
    if (!name) { await answer('Сотрудник не найден'); return; }
    const open = await openShift(env, name, now, by);
    await editTgMessage(env, chatId, msgId, shiftCardText(open), shiftKeyboard(sellers));
    await answer(`✅ Смена открыта: ${name}`);
    return;
  }
  if (data === 'sh:e') {
    const sellers = await loadSellers(env);
    const closed = await closeOpenShift(env, now);
    await editTgMessage(env, chatId, msgId, shiftCardText(null), shiftKeyboard(sellers));
    await answer(closed ? `✅ Смена закрыта: ${closed.manager}` : 'Открытой смены не было');
    return;
  }
  // Возобновить рассылку после автопаузы предохранителя (WS-1) — только управляющие.
  if (data === 'bcast:resume') {
    if (!isAdmin(env, fromId)) { await answer('Только для управляющих'); return; }
    try { if (env.MH_KV && typeof env.MH_KV.delete === 'function') await env.MH_KV.delete(BROADCAST_PAUSE_KEY); }
    catch (e) { console.error('[breaker] resume delete failed:', e && e.message); }
    await editTgMessage(env, chatId, msgId, '▶️ Рассылка возобновлена. Бот продолжит по расписанию.', { inline_keyboard: [] });
    await answer('Возобновлено');
    return;
  }
  // Управление сотрудниками по ролям (продавцы/администраторы) — только управляющие.
  if (data.startsWith('team:') || data.startsWith('emp:')) {
    if (!isAdmin(env, fromId)) { await answer('Только для управляющих'); return; }
    if (data.startsWith('team:')) {
      const role = staffRole(data.slice(5));
      const list = await loadStaff(env, role);
      await tgCall(env, 'sendMessage', { chat_id: chatId, text: teamPanelText(role, list), reply_markup: teamKeyboard(role, list) });
      await answer(); return;
    }
    if (data.startsWith('emp:add:')) {
      const role = staffRole(data.slice(8));
      await tgCall(env, 'sendMessage', { chat_id: chatId, text: addPrompt(role), reply_markup: { force_reply: true } });
      await answer(); return;
    }
    if (data.startsWith('emp:rm:')) {
      const p = data.split(':'); const role = staffRole(p[2]); const idx = parseInt(p[3], 10);
      const { list, removed } = await removeStaff(env, role, idx);
      await editTgMessage(env, chatId, msgId, teamPanelText(role, list), teamKeyboard(role, list));
      await answer(removed ? `🗑 Удалён: ${removed}` : 'Не найдено');
      return;
    }
    await answer(); return;
  }

  // Главное меню (Отдел продаж / Администраторы) — только руководители.
  if (data.startsWith('menu:') || data.startsWith('sales:') || data.startsWith('admins:') || data.startsWith('rep:')) {
    if (!isAdmin(env, fromId)) { await answer('Только для руководителей'); return; }
    if (data === 'menu:main') { await editTgMessage(env, chatId, msgId, MENU_MAIN_TEXT, mainMenuKb()); await answer(); return; }
    if (data === 'menu:sales') { await editTgMessage(env, chatId, msgId, MENU_SALES_TEXT, salesMenuKb()); await answer(); return; }
    if (data === 'menu:admins') { await editTgMessage(env, chatId, msgId, MENU_ADMINS_TEXT, adminsMenuKb()); await answer(); return; }
    // «Сформировать отчёт» → меню выбора периода (обе ветки).
    if (data === 'sales:report') { await editTgMessage(env, chatId, msgId, '📄 Отчёт «Отдел продаж» — за какой период?', reportPeriodKb('sales')); await answer(); return; }
    if (data === 'admins:report') { await editTgMessage(env, chatId, msgId, '📄 Отчёт «Администраторы» — за какой период?', reportPeriodKb('admins')); await answer(); return; }
    if (data === 'sales:target') {
      await tgCall(env, 'sendMessage', { chat_id: chatId, text: TARGET_PROMPT, reply_markup: { force_reply: true } });
      await answer(); return;
    }
    if (data === 'sales:sverka') {
      await answer('Считаю…');
      const r = await buildReco(env, Date.now());
      await tgCall(env, 'sendMessage', { chat_id: chatId, text: r.text, disable_web_page_preview: true });
      return;
    }
    // rep:<sec>:<period> — сформировать отчёт за период.
    if (data.startsWith('rep:')) {
      const parts = data.split(':'); const sec = parts[1]; const per = parts[2];
      if (per === 'custom') {
        await tgCall(env, 'sendMessage', { chat_id: chatId, text: reportPrompt(sec), reply_markup: { force_reply: true } });
        await answer(); return;
      }
      await answer('Формирую…');
      const text = sec === 'admins'
        ? await buildAdminReport(env, per, Date.now())
        : await buildSalesReport(env, per, Date.now());
      await tgCall(env, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
      return;
    }
    await answer(); return;
  }
  await answer();
}

// Текстовые команды и ответ на приглашение «введите ФИО».
async function handleMessage(env, msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat && msg.chat.id;
  const fromId = msg.from && msg.from.id;
  if (!text) return;

  // Ответ на приглашение «введите ФИО» → добавить сотрудника (только управляющий).
  const rt = msg.reply_to_message;
  if (rt && rt.from && rt.from.is_bot && typeof rt.text === 'string' && rt.text.startsWith(ADD_PROMPT_MARK)) {
    if (!isAdmin(env, fromId)) { await tgReply(env, chatId, 'Только для управляющих.'); return; }
    const role = rt.text.includes('администратор') ? 'admins' : 'sellers'; // роль зашита в текст приглашения
    await addEmployee(env, chatId, role, text);
    return;
  }
  // Ответ на приглашение «введите число лидов таргетолога» → записать в сверку.
  if (rt && rt.from && rt.from.is_bot && typeof rt.text === 'string' && rt.text.startsWith(TARGET_PROMPT_MARK)) {
    if (!isAdmin(env, fromId)) { await tgReply(env, chatId, 'Только для руководителей.'); return; }
    const n = parseInt(text.replace(/\D/g, ''), 10);
    if (!Number.isFinite(n)) { await tgReply(env, chatId, 'Нужно число. Пример: 55'); return; }
    const r = await buildReco(env, Date.now(), { setTarget: n });
    await tgReply(env, chatId, r.text);
    return;
  }
  // Ответ на приглашение «период отчёта» → отчёт за произвольный диапазон.
  if (rt && rt.from && rt.from.is_bot && typeof rt.text === 'string' && rt.text.startsWith(REPORT_PROMPT_MARK)) {
    if (!isAdmin(env, fromId)) { await tgReply(env, chatId, 'Только для руководителей.'); return; }
    const sec = rt.text.includes('админы') ? 'admins' : 'sales';
    const range = parseUserDateRange(text, Date.now());
    if (!range) { await tgReply(env, chatId, 'Не понял период. Пример: 01.06.2026-07.06.2026'); return; }
    const out = sec === 'admins'
      ? await buildAdminReport(env, 'custom', Date.now(), range)
      : await buildSalesReport(env, 'custom', Date.now(), range);
    await tgReply(env, chatId, out);
    return;
  }

  if (text[0] !== '/') return;
  const m = text.match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();

  if (cmd === 'id' || cmd === 'myid') {
    await tgReply(env, chatId, `Ваш Telegram ID: ${fromId}`
      + (isAdmin(env, fromId) ? '\n🔑 Вы — управляющий.' : ''));
    return;
  }
  if (cmd === 'start' || cmd === 'help' || cmd === 'menu') {
    if (isAdmin(env, fromId)) {
      await tgCall(env, 'sendMessage', { chat_id: chatId, text: MENU_MAIN_TEXT, reply_markup: mainMenuKb() });
    } else {
      await tgReply(env, chatId, `Бот «Пульс продаж».\nВаш Telegram ID: ${fromId}\nУправление — у руководителей.`);
    }
    return;
  }
  if (cmd === 'team' || cmd === 'sotrudniki' || cmd === 'remove' || cmd === 'rm') {
    if (!isAdmin(env, fromId)) { await tgReply(env, chatId, 'Только для управляющих.'); return; }
    const list = await loadStaff(env, 'sellers');
    await tgCall(env, 'sendMessage', { chat_id: chatId, text: teamPanelText('sellers', list), reply_markup: teamKeyboard('sellers', list) });
    return;
  }
  if (cmd === 'add') {
    if (!isAdmin(env, fromId)) { await tgReply(env, chatId, 'Только для управляющих.'); return; }
    if (!arg) { await tgReply(env, chatId, 'Укажите: /add Фамилия Имя'); return; }
    await addEmployee(env, chatId, 'sellers', arg);
    return;
  }
  // Сверка лидов дня: /sverka — показать; /target N — записать число таргетолога и показать.
  if (cmd === 'sverka' || cmd === 'leads' || cmd === 'target') {
    if (!isAdmin(env, fromId)) { await tgReply(env, chatId, 'Только для управляющих.'); return; }
    const setTarget = cmd === 'target' ? parseInt(arg, 10) : null;
    if (cmd === 'target' && !Number.isFinite(setTarget)) { await tgReply(env, chatId, 'Укажите число: /target 55'); return; }
    const r = await buildReco(env, Date.now(), { setTarget });
    await tgCall(env, 'sendMessage', { chat_id: chatId, text: r.text, disable_web_page_preview: true });
  }
}

async function addEmployee(env, chatId, role, raw) {
  const clean = String(raw).replace(/\s+/g, ' ').trim();
  if (clean.length < 2) { await tgReply(env, chatId, 'Слишком коротко. Пример: Иванова Кристина'); return; }
  const { list, name, added } = await addStaff(env, role, clean);
  const what = role === 'admins' ? 'Администратор' : 'Сотрудник';
  await tgReply(env, chatId, added
    ? `✅ ${what} добавлен: ${name}\nВсего: ${list.length}`
    : `ℹ️ «${name}» уже в списке. Всего: ${list.length}`);
}

// setWebhook: направить апдейты бота на наш воркер (?tg=<DIGEST_SECRET>). Разовая настройка.
async function setupTelegramWebhook(env, origin) {
  const url = `${origin}/?tg=${env.DIGEST_SECRET}`;
  const j = await tgCall(env, 'setWebhook', {
    url,
    allowed_updates: ['callback_query', 'message'],
    drop_pending_updates: true,
  });
  // Кнопка «Меню» в Telegram — список команд для руководителей.
  await tgCall(env, 'setMyCommands', { commands: [
    { command: 'menu', description: 'Главное меню' },
    { command: 'sverka', description: 'Сверка лидов дня' },
    { command: 'team', description: 'Сотрудники (продавцы)' },
    { command: 'id', description: 'Мой Telegram ID' },
  ] });
  return { ok: !!(j && j.ok), url, response: j };
}

// Журнал смен за день + текущая открытая (для расчёта KPI по продавцам — следующий этап).
async function loadDayShifts(env, dateStr, clipTo) {
  const closed = (await env.PULSE_KV.get(shiftsKey(dateStr), { type: 'json' })) || [];
  const all = closed.slice();
  const open = await getOpenShift(env);
  if (open && open.manager && almatyDateStr(open.start) === dateStr) {
    all.push({ manager: open.manager, start: open.start, end: clipTo || Date.now(), open: true });
  }
  return all.sort((a, b) => a.start - b.start);
}

/* ============================================================
 * MESSAGE.HELP — токен и регистрация вебхука (ветка B1)
 * ============================================================ */

// Регистрирует вебхук mm-pulse-bot в message.help. Дёргается один раз при
// настройке: GET <worker>/?register=<DIGEST_SECRET>. Повторный вызов безвреден —
// дубли событий отсекаются дедупом по message_id.
async function registerWebhook(env, reqUrl) {
  for (const k of ['MH_LOGIN', 'MH_PASSWORD', 'MH_PROJECT_ID', 'WEBHOOK_SECRET']) {
    if (!env[k]) return { ok: false, error: `missing ${k}` };
  }
  const token = await getMhToken(env);
  if (!token) return { ok: false, error: 'mh_login_failed' };

  const webhookUrl = `${reqUrl.origin}/?secret=${env.WEBHOOK_SECRET}`;
  let res;
  try {
    res = await fetch(`${MH_API}/app/projects/${env.MH_PROJECT_ID}/webhooks/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, entities: ['channel.message'] }),
    });
  } catch (e) {
    return { ok: false, error: `mh request failed: ${e && e.message}` };
  }
  const detail = (await res.text()).slice(0, 300);
  if (!res.ok) return { ok: false, error: `mh webhooks ${res.status}`, detail };
  return { ok: true, registered: webhookUrl, response: detail };
}

// Токен message.help: логин + кэш в KV (живёт expires_in, кэшируем с запасом 5 мин).
async function getMhToken(env) {
  const cached = await env.PULSE_KV.get(TOKEN_KEY);
  if (cached) return cached;
  let res;
  try {
    res = await fetch(`${MH_API}/app/user/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: env.MH_LOGIN, password: env.MH_PASSWORD }),
    });
  } catch (e) {
    console.error('mh login error:', e && e.message);
    return null;
  }
  if (!res.ok) {
    console.error('mh login failed:', res.status);
    return null;
  }
  const data = await res.json().catch(() => null);
  const token = data && data.data && data.data.access_token;
  if (!token) {
    console.error('mh login: no access_token');
    return null;
  }
  const expires = (data.data.expires_in && parseInt(data.data.expires_in, 10)) || 3600;
  await env.PULSE_KV.put(TOKEN_KEY, token, { expirationTtl: Math.max(60, expires - 300) });
  return token;
}

/* ============================================================
 * MESSAGE.HELP — телефоны зависших диалогов (enrichment)
 * ============================================================ */

// channel_id → uuid (нужен, чтобы дёрнуть карточку юзера). Кэш в KV на сутки.
async function getChannelMap(env) {
  try {
    const cached = await env.PULSE_KV.get('mh:channels', { type: 'json' });
    if (cached) return cached;
  } catch (_) { /* ignore */ }
  const token = await getMhToken(env);
  if (!token) return {};
  let res;
  try {
    res = await fetch(`${MH_API}/app/projects/${env.MH_PROJECT_ID}/channels/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) { return {}; }
  if (!res.ok) return {};
  const j = await res.json().catch(() => null);
  const list = (j && j.data) || [];
  const map = {};
  for (const c of list) if (c && c.id != null && c.uuid) map[String(c.id)] = c.uuid;
  try { await env.PULSE_KV.put('mh:channels', JSON.stringify(map), { expirationTtl: 86400 }); } catch (_) { /* ignore */ }
  return map;
}

// Проставляет phone зависшим диалогам, у которых он не сохранён в событии (старые
// события до захвата телефона / Instagram без телефона). По одному GET user на диалог;
// если канал диалога неизвестен — перебираем каналы проекта. Best-effort: сбой не
// роняет дайджест — у кого не вышло, в отчёте останется имя или внутренний №.
// Дотягивает телефоны зависших И ОТСЕИВАЕТ заблокированные диалоги по АКТУАЛЬНОМУ
// статусу. Если контакт заблокирован в message.help, отдел продаж его чат не видит
// («в хелпе не высвечивается») и физически не может ответить → флагать «без ответа» =
// ложняк. Карточка диалога несёт поле `blocked`. Один GET на диалог; проверяем до
// `limit` зависших (остальные оставляем как есть). Best-effort: сбой не роняет дайджест.
async function refineUnanswered(env, metrics, limit) {
  const items = metrics.unanswered;
  if (!items.length || !env.MH_LOGIN || !env.MH_PASSWORD || !env.MH_PROJECT_ID) return 0;
  const token = await getMhToken(env);
  if (!token) return 0;
  const map = await getChannelMap(env);
  const allUuids = Object.values(map);
  const cap = Math.min(items.length, limit || 20);
  let budget = 30; // потолок субреквестов к message.help за прогон (защита от лимита Cloudflare)
  const keep = [];
  let blocked = 0;
  let checked = 0; // сколько зависших реально проверили на блокировку (honesty WS-1)
  for (let i = 0; i < items.length; i++) {
    const u = items[i];
    if (i >= cap || budget <= 0) { keep.push(u); continue; } // сверх лимита/бюджета — не проверяем
    checked++;
    const tryUuids = (u.channelId != null && map[String(u.channelId)]) ? [map[String(u.channelId)]] : allUuids;
    let card = null;
    for (const uuid of tryUuids) {
      if (budget <= 0) break;
      budget--;
      try {
        const r = await fetch(
          `${MH_API}/app/projects/${env.MH_PROJECT_ID}/channels/${uuid}/users/${u.dialogId}`,
          { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        if (j && j.data) { card = j.data; break; }
      } catch (_) { /* best-effort */ }
    }
    if (card) {
      if (!u.phone && card.phone) u.phone = String(card.phone);
      if (card.blocked === true) { blocked++; continue; } // заблокирован — отдел не видит, не флагуем
    }
    keep.push(u);
  }
  metrics.unanswered = keep;
  metrics.blockedSkipped = (metrics.blockedSkipped || 0) + blocked;
  metrics.refineUnchecked = Math.max(0, items.length - checked); // не проверены на блокировку (потолок/бюджет)
  if (blocked) console.log(`[digest] отброшено заблокированных «без ответа»: ${blocked}`);
  if (metrics.refineUnchecked) console.log(`[digest] не проверено на блокировку: ${metrics.refineUnchecked}`);
  return blocked;
}

/* ============================================================
 * УТИЛИТЫ
 * ============================================================ */

// created_at message.help — подтверждено на проде: строка "YYYY-MM-DD HH:MM:SS"
// БЕЗ таймзоны, в МОСКОВСКОМ времени (UTC+3). Date.parse в воркере (TZ=UTC) принял бы
// её за UTC и завысил время на 3 часа — все метрики (скорость ответа, «за 3 часа»,
// «зависшие») поехали бы. Поэтому naive-строку парсим явно как MSK и приводим к UTC.
// Epoch-числа (если когда-нибудь придут) — абсолютны, смещение к ним не применяем.
function parseTs(raw) {
  if (raw == null || raw === '') return Date.now();
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n < 1e12 ? n * 1000 : n;
  }
  // Naive datetime без таймзоны (формат message.help) → трактуем как UTC+3 (MSK).
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return ms - MH_TZ_OFFSET * 3600 * 1000;
  }
  // Строка с явной таймзоной (ISO с Z или ±hh:mm) — Date.parse корректен.
  const t = Date.parse(s);
  return Number.isNaN(t) ? Date.now() : t;
}

// Дата по Алматы (UTC+5) — YYYY-MM-DD. Сдвиг вручную, tz воркера не используем.
function almatyDateStr(ts) {
  const d = new Date((ts || Date.now()) + ALMATY_UTC_OFFSET * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// UTC-ms момента «hour:00» по Алматы для даты dateStr (YYYY-MM-DD). null — кривая дата.
function almatyTimeTs(dateStr, hour) {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], hour - ALMATY_UTC_OFFSET, 0, 0);
}

// Время по Алматы — час, HH:MM и DD.MM.
function almatyParts(ts) {
  const d = new Date((ts || Date.now()) + ALMATY_UTC_OFFSET * 3600 * 1000);
  return {
    hour: d.getUTCHours(),
    hhmm: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
    ddmm: `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}`,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Русское склонение: plural(n, ['заявка', 'заявки', 'заявок']).
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
