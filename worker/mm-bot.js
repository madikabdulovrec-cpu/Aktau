/**
 * mm-bot.js — Бот первичной обработки заявок M&M Fabrica
 * Cloudflare Worker: Wazzup24 webhook (WhatsApp/Instagram) -> Claude API -> ответ клиенту.
 *
 * Закрывает вход воронки (по audit.html: 93% заявок теряются между обращением
 * и консультацией из-за медленного ответа). Бот отвечает мгновенно, ведёт к
 * записи на бесплатную консультацию, передаёт менеджеру.
 *
 * ── ENV (Cloudflare → Worker → Settings → Variables) ───────────────────────
 *  Secrets:
 *   ANTHROPIC_API_KEY   — ключ Claude API (console.anthropic.com)
 *   WAZZUP_API_KEY      — ключ Wazzup24 API (личный кабинет Wazzup)
 *   WEBHOOK_SECRET      — произвольная строка 32+ симв.; webhook-URL в Wazzup
 *                         настроить как https://<worker>/?secret=<значение>
 *  Plaintext:
 *   ANTHROPIC_MODEL     — модель. По умолчанию claude-sonnet-4-6 (быстро+дёшево,
 *                         решение docs/sales/05). Для макс. качества: claude-opus-4-7.
 *   MANAGER_CHAT_ID     — номер менеджера для handoff-уведомлений, формат 7701XXXXXXX
 *   MANAGER_CHAT_TYPE   — канал уведомлений менеджеру (whatsapp / telegram), по умолч. whatsapp
 *  KV namespace:
 *   BOT_KV              — история диалогов, дедуп, карточки лидов
 *
 * Деплой: wrangler deploy (см. wrangler-mm-bot.toml) либо вставка в Dashboard.
 * Большой файл в Dashboard вставлять через clipboard целиком (урок altegio-webhook).
 *
 * ВАЖНО: SYSTEM_PROMPT ниже — рабочая копия docs/sales/05_bot_system_prompt.md
 * (Часть A). При правках синхронизировать оба места.
 */

// ── Системный промпт (источник правды по фактам: docs/sales/Для бота.md) ────
const SYSTEM_PROMPT = `# КТО ТЫ

Ты — виртуальный ассистент студии коррекции фигуры и косметологии «Фабрика красивых тел M&M», город Алматы. Ты отвечаешь на входящие сообщения новых клиентов в WhatsApp и Instagram-директе.

Твоя ЕДИНСТВЕННАЯ задача: за минимум сообщений довести нового клиента из рекламы до записи на бесплатную консультацию в студии и передать менеджеру.

Ты НЕ продаёшь курс. Курс подбирает и продаёт мастер вживую на консультации. Твоя работа — привести человека на эту консультацию.

# ЗОЛОТЫЕ ПРАВИЛА (приоритет над всем остальным)

1. СНАЧАЛА ОТВЕТЬ НА ТО, ЧТО СПРОСИЛИ. Спросили цену — назови цену в первом же сообщении. Сказали «хочу записаться на X» — не допрашивай, веди к слотам.
2. КОРОТКО. 1-2 коротких сообщения за ответ. Никаких простыней и шаблонных описаний.
3. ТЕПЛО И ПО ИМЕНИ. Бьюти — деликатная тема. Без давления, без оценок тела и веса.
4. КАЖДЫЙ ОТВЕТ ПРИБЛИЖАЕТ К ЗАПИСИ. Предлагай 2-3 КОНКРЕТНЫХ слота. Никогда не спрашивай размыто «когда вам удобно?».
5. СОМНЕНИЕ — СНИМАЙ, НЕ ИГНОРИРУЙ. Ответь именно на сомнение. ЗАПРЕЩЕНО отвечать на возражение вопросом про дату записи.
6. НЕ ВЫДУМЫВАЙ. Цены, акции, факты, описания процедур — только из блоков ниже. Не знаешь — «уточнит мастер на консультации» или передай менеджеру.
7. ПРОТИВОПОКАЗАНИЯ — спрашивай до фиксации записи, всегда.
8. ИМЯ + ТЕЛЕФОН — собери перед передачей менеджеру.

# АЛГОРИТМ ДИАЛОГА

Гибкий, не жёсткий. Пропускай шаги, которые клиент уже закрыл сам.
1. Приветствие + ответ по сути на вопрос клиента.
2. Лёгкая квалификация: максимум 1-2 вопроса (зона / желаемый результат). Не анкета.
3. Предложение записи: цена пробного посещения + 2-3 конкретных слота.
4. Противопоказания — до фиксации слота.
5. Фиксация: собрать имя и номер WhatsApp.
6. Тёплая передача менеджеру.

# ФАКТЫ О СТУДИИ (единственный источник правды)

- Фабрика красивых тел M&M — студия коррекции фигуры и косметологии.
- Адрес: г. Алматы, ул. Ауэзова 175Б, угол ул. Габдуллина.
- Часы: 8:00-21:00 без выходных. Консультации — с 10:00 до 19:00.
- Бесплатная консультация: аппаратная диагностика + индивидуальный план, без навязывания.
- Первое посещение процедуры — пробное, со скидкой 50%, ~1 час, два этапа: консультация + процедура.
- Отмена записи — минимум за 24 часа, иначе предоплата/посещение сгорает.
- Студия зарабатывает на курсах. Курс подбирает мастер на консультации. Твоя задача — довести до консультации.

# КАТАЛОГ ПРОЦЕДУР (цена = пробное посещение со скидкой 50%)

- Торнадо — 12 000 тг. Глубокий роликовый массаж с инфракрасным теплом: стачивает объёмы, подтягивает кожу, борется с целлюлитом.
- Индиба — 25 000 тг. Аппаратная коррекция фигуры: убирает лишний объём, улучшает контуры, повышает тонус кожи. Эффект заметен после первой процедуры.
- Лимфокоррекция — 11 000 тг. Ручной лимфодренажный массаж всего тела, комфортный и безболезненный: выводит лишнюю жидкость, снимает отёчность.
- Золотое сечение — 15 000 тг. Моделирующий массаж силиконовыми вакуумными банками: работает с локальными жировыми отложениями, корректирует фигуру.
- Торнадо по лицу — 4 500 тг. Роликовый массаж лица: эффективен при отёчности и для уменьшения второго подбородка.
- Импульс — 9 000 тг. Аппаратная процедура для тела. Подробности расскажет мастер на консультации.
- Аргоновая плазма — 21 000 тг. Аппаратная процедура: омоложение и оздоровление кожи, работа с подкожно-жировой клетчаткой.
- ХП на голову — 9 000 тг. Холодная плазма для кожи головы: помогает при выпадении волос, стимулирует их рост.
- Медовый массаж — 11 000 тг. Детокс-массаж с мёдом (медовая выкатка): выводит лишнюю жидкость, улучшает тонус кожи.
- Чистка лица — 13 500 тг. Комбинированная чистка: многоэтапное очищение и уход за кожей лица — пилинг, очищение пор, тонизация, маска.

Правила по ценам: минимум от 9 000 тг. Точный набор и количество процедур в курсе определяет мастер. КРИО ОТКЛЮЧЕНО — не предлагать. Не знаешь цену/деталь — не выдумывай.

# ПРОТИВОПОКАЗАНИЯ (спросить перед фиксацией записи)

Онкология; почечная, сердечная или печёночная недостаточность; критические дни сейчас; жировые и сосудистые опухоли; эпилепсия; грыжи; раны и порезы на коже; кардиостимулятор; миома.
Если клиент называет что-то из списка — НЕ отказывай резко, не пугай. Скажи: окончательно определит мастер на консультации, диагностика для этого и нужна. Продолжай мягко вести на консультацию.

# КТО ПЕРЕД ТОБОЙ

- НОВЫЙ ЛИД (ведёшь ты): вопрос про процедуру, цену, «хочу записаться», реакция на рекламу.
- ДЕЙСТВУЮЩИЙ КЛИЕНТ (НЕ веди как лида): перенос записи, «не смогу прийти», вопрос про текущий курс/визит. Вежливо передай администратору и поставь тег [[HANDOFF | existing_client]].
- НЕЯСНО: один уточняющий вопрос.

# ВОЗРАЖЕНИЯ

- «Дорого» → ценность результата + скидка 50% на первое посещение + бесплатная консультация, где мастер подберёт вариант по бюджету. Без давления, без торга.
- «Подумаю» → мягко спроси, что именно останавливает, ответь на это.
- «Сначала цену курса» → курс индивидуален, рассчитает мастер после диагностики; назови цену пробного, веди на консультацию.
- Сложный медицинский вопрос / жёсткий торг / клиент злится → передай менеджеру тегом [[HANDOFF | reason]].

# ТОН

Тёплый, заботливый, лёгкий. Короткие фразы. Эмодзи умеренно, 1-2 на сообщение. По имени. Без канцелярита и давления.
Ты ассистент, не человек. На прямой вопрос «вы бот?» отвечай честно: «Я виртуальный ассистент студии, помогаю с записью, в любой момент подключу менеджера-человека».
Если клиент пишет на казахском — отвечай на казахском, по тем же правилам.

# СЛОТЫ

Актуальные свободные окна приходят тебе в начале сообщения клиента в блоке «ДОСТУПНЫЕ СЛОТЫ». Предлагай ТОЛЬКО слоты из этого блока, никогда не выдумывай время. Если блок пуст — скажи «уточню ближайшие окна у менеджера» и поставь [[HANDOFF | need_slots]].

# УПРАВЛЯЮЩИЕ ТЕГИ

Когда наступило событие — добавь в КОНЦЕ ответа отдельной последней строкой служебный тег. Клиент его не видит (система вырезает).
- Запись зафиксирована (выбран слот, собраны имя и телефон):
  [[BOOKING | имя | телефон | процедура | слот | противопоказания или "нет"]]
- Нужен живой человек (сложный вопрос, жёсткое возражение, клиент просит человека):
  [[HANDOFF | причина]]
- Действующий клиент:
  [[HANDOFF | existing_client]]
Если события нет — тег не ставь.

# ЧЕГО НЕ ДЕЛАТЬ НИКОГДА

- Не игнорировать сказанное клиентом, не допрашивать того, кто уже назвал намерение.
- Не вываливать шаблонное описание вместо ответа на вопрос.
- Не отвечать на сомнение вопросом «когда вас записать?».
- Не делать пустой дожим «вы ещё актуальны?» — каждое касание с новой ценностью.
- Не выдумывать цены, акции, описания, врачебные заключения.
- Не продавать и не считать курс — это работа мастера.
- Не предлагать Крио.`;

// ── Константы ──────────────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const WAZZUP_SEND_URL = 'https://api.wazzup24.com/v3/message';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const HISTORY_LIMIT = 20;          // последних сообщений в контексте
const HISTORY_TTL = 2592000;       // 30 дней
const DEDUP_TTL = 3600;            // 1 час
const LEAD_TTL = 7776000;          // 90 дней
const ALMATY_UTC_OFFSET = 5;       // Алматы = UTC+5

// ── Точка входа ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      return json({ status: 'ok', service: 'mm-bot', ts: new Date().toISOString() });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    // Проверка конфигурации (секреты + KV-биндинг)
    const missing = ['ANTHROPIC_API_KEY', 'WAZZUP_API_KEY', 'WEBHOOK_SECRET']
      .filter((k) => !env[k]);
    if (!env.BOT_KV || typeof env.BOT_KV.get !== 'function') missing.push('BOT_KV');
    if (missing.length) {
      console.error('misconfigured: missing', missing.join(','));
      return json({ ok: false, error: 'misconfigured' }, 500);
    }

    // Авторизация webhook: secret из query ИЛИ заголовка X-Webhook-Secret.
    // Fallback на заголовок — на случай если Wazzup срежет query-параметры
    // (так делал Altegio). Настроить в Wazzup тот способ, что доходит.
    const providedSecret = url.searchParams.get('secret')
      || request.headers.get('x-webhook-secret') || '';
    if (providedSecret !== env.WEBHOOK_SECRET) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'bad_json' }, 400);
    }

    // [DEBUG] временный лог сырого webhook — убрать после диагностики формата
    console.log('RAW_WEBHOOK ' + JSON.stringify(body).slice(0, 2000));

    // Wazzup при настройке webhook шлёт проверочный ping
    if (body && body.test === true) {
      return json({ ok: true });
    }

    const messages = parseWazzupWebhook(body);
    // Отвечаем Wazzup сразу (200), обработку — в фоне, иначе webhook словит таймаут
    if (messages.length) {
      ctx.waitUntil(
        Promise.all(messages.map((m) => processMessage(m, env).catch((e) =>
          console.error('processMessage failed:', e && e.message)))),
      );
    }
    return json({ ok: true });
  },
};

// ── Парсинг webhook Wazzup24 ────────────────────────────────────────────────
// СВЕРИТЬ С docs.wazzup24.com — формат полей webhook может отличаться.
// Изолировано в одной функции, чтобы правка не задевала остальной код.
function parseWazzupWebhook(body) {
  if (!body || !Array.isArray(body.messages)) return [];
  const out = [];
  for (const m of body.messages) {
    // Только входящие текстовые сообщения от клиента
    if (m.isEcho === true || m.isEcho === 'true') continue; // исходящее (в т.ч. наш ответ)
    if (m.status && m.status !== 'inbound') continue;                                 // апдейт статуса доставки
    if (m.type && m.type !== 'text') continue;              // не текст (фото/аудио и т.п.)
    if (!m.chatId) continue;                                // без идентификатора чата не обработать
    const text = (m.text || '').trim();
    if (!text) continue;
    out.push({
      messageId: m.messageId || `${m.chatId}-${m.dateTime || Date.now()}`,
      channelId: m.channelId,
      chatType: m.chatType || 'whatsapp',
      chatId: m.chatId,
      text,
      contactName: (m.contact && m.contact.name) || '',
    });
  }
  return out;
}

// ── Обработка одного входящего сообщения ───────────────────────────────────
async function processMessage(msg, env) {
  const { messageId, chatId } = msg;
  const tag = maskPhone(chatId);

  // Дедуп: Wazzup может повторить доставку webhook
  const seenKey = `seen:${messageId}`;
  if (await env.BOT_KV.get(seenKey)) {
    console.log(`skip dup ${tag}`);
    return;
  }

  // История диалога — читаем; baseLen запомним для защиты от гонки при записи
  const histKey = `hist:${chatId}`;
  const histBefore = (await env.BOT_KV.get(histKey, { type: 'json' })) || [];
  const baseLen = histBefore.length;

  // Контекст для Claude = история + текущее сообщение клиента
  const contextHistory = appendTurn(histBefore, 'user', msg.text);
  const reply = await callClaude(env, contextHistory, buildSlotsBlock());

  // Формируем ответ. Если Claude недоступен — НЕ молчим: мягкий ответ клиенту
  // + handoff менеджеру, чтобы живой человек подхватил диалог.
  let clientText;
  let booking = null;
  let handoff = null;
  let claudeFailed = false;
  if (reply) {
    const parsed = parseControlTags(reply);
    clientText = parsed.cleanText || 'Спасибо за сообщение! 🌸 Передаю вас менеджеру.';
    booking = parsed.booking;
    handoff = parsed.handoff;
  } else {
    claudeFailed = true;
    clientText = 'Спасибо за сообщение! 🌸 Сейчас передам вас менеджеру — '
      + 'он(а) свяжется с вами в ближайшее время.';
    handoff = 'bot_unavailable';
  }

  // Ответ клиенту (с ретраем). Если не доставлено — не помечаем seen и не
  // сохраняем историю: остаётся шанс на повторную обработку.
  const sent = await sendWazzupMessage(env, msg.channelId, msg.chatType, chatId, clientText);
  if (!sent) {
    console.error(`reply not delivered ${tag}`);
    return;
  }

  // Дедуп помечаем ПОСЛЕ успешной доставки ответа
  await env.BOT_KV.put(seenKey, '1', { expirationTtl: DEDUP_TTL });

  // История: перечитываем свежую копию — другой webhook этого же клиента мог
  // записать параллельно. Если она длиннее, чем была при нашем чтении, берём
  // её за базу, чтобы не затереть чужие ходы. Полную гарантию дали бы Durable
  // Objects; здесь — прагматичная защита для типичных быстрых сообщений подряд.
  const histFresh = (await env.BOT_KV.get(histKey, { type: 'json' })) || [];
  const base = histFresh.length > baseLen ? histFresh : histBefore;
  let merged = appendTurn(base, 'user', msg.text);
  merged = appendTurn(merged, 'assistant', clientText);
  await env.BOT_KV.put(histKey, JSON.stringify(merged.slice(-HISTORY_LIMIT)),
    { expirationTtl: HISTORY_TTL });

  // Действия по тегам
  if (handoff) await handleHandoff(env, msg, handoff);
  if (booking) await handleBooking(env, msg, booking);

  console.log(`done ${tag} booking=${!!booking} handoff=${handoff || '-'}`
    + `${claudeFailed ? ' claude-fail' : ''}`);
}

// ── История: чередование ролей, склейка подряд идущих сообщений одной роли ──
// Возвращает новый массив, не мутирует переданный (и его объекты).
function appendTurn(history, role, content) {
  const h = history.slice();
  const last = h[h.length - 1];
  if (last && last.role === role) {
    h[h.length - 1] = { role, content: `${last.content}\n${content}` };
  } else {
    h.push({ role, content });
  }
  return h;
}

// ── Вызов Claude API (raw fetch, prompt caching, retry) ─────────────────────
async function callClaude(env, history, slotsBlock) {
  // Слоты — волатильная часть: подмешиваем ТОЛЬКО в последнее user-сообщение
  // API-копии. В истории (KV) текст клиента хранится без слотов, поэтому
  // системный промпт + предыдущие ходы остаются стабильным префиксом для кэша.
  const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    if (apiMessages[i].role === 'user') {
      apiMessages[i] = {
        role: 'user',
        content: `${slotsBlock}\n\n${apiMessages[i].content}`,
      };
      break;
    }
  }

  const payload = {
    model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: 1024,
    // cache_control на статичном системном промпте → ~0.1x цена на повторных
    // вызовах. Промпт frozen (без дат/переменных), поэтому префикс стабилен.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: apiMessages,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error('Claude fetch error:', e && e.message);
      await sleep(500 * (attempt + 1));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const u = data.usage || {};
      console.log(`claude ok cache_read=${u.cache_read_input_tokens || 0} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
      if (data.stop_reason === 'refusal') {
        console.error('Claude refusal — отдаём на менеджера');
        return '';
      }
      const textBlock = (data.content || []).find((b) => b.type === 'text');
      return textBlock ? textBlock.text.trim() : '';
    }

    // 429 / 5xx — ретраить; 4xx (кроме 429) — нет смысла
    if (res.status !== 429 && res.status < 500) {
      console.error(`Claude API ${res.status}:`, (await res.text()).slice(0, 200));
      return '';
    }
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    await sleep(retryAfter ? retryAfter * 1000 : 800 * (attempt + 1));
  }
  console.error('Claude API: retries exhausted');
  return '';
}

// ── Управляющие теги [[BOOKING|...]] / [[HANDOFF|...]] ──────────────────────
function parseControlTags(text) {
  let booking = null;
  let handoff = null;
  const re = /\[\[\s*(BOOKING|HANDOFF)\s*\|([^\]]*)\]\]/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const kind = match[1].toUpperCase();
    const payload = match[2].trim();
    if (kind === 'BOOKING') {
      const p = payload.split('|').map((s) => s.trim());
      booking = { name: p[0] || '', phone: p[1] || '', service: p[2] || '',
        slot: p[3] || '', contraindications: p[4] || '' };
    } else {
      handoff = payload || 'general';
    }
  }
  const cleanText = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, booking, handoff };
}

// ── Слоты по графику консультаций (MVP) ────────────────────────────────────
// TODO: заменить на реальную занятость из Altegio book_times. Сейчас —
// ориентировочные окна; менеджер сверяет с расписанием при подтверждении.
function buildSlotsBlock() {
  const now = new Date(Date.now() + ALMATY_UTC_OFFSET * 3600 * 1000);
  const dayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const baseTimes = [11, 14, 17];
  const lines = [];
  for (let d = 0; d < 3 && lines.length < 3; d++) {
    const day = new Date(now.getTime() + d * 86400000);
    const label = d === 0 ? 'сегодня' : d === 1 ? 'завтра' : dayNames[day.getUTCDay()];
    const times = baseTimes.filter((h) => !(d === 0 && h <= now.getUTCHours() + 1));
    if (times.length) {
      lines.push(`${label}: ${times.map((h) => `${h}:00`).join(', ')}`);
    }
  }
  if (!lines.length) return 'ДОСТУПНЫЕ СЛОТЫ: (нет окон — уточни у менеджера)';
  return `ДОСТУПНЫЕ СЛОТЫ (консультации 10:00-19:00): ${lines.join(' · ')}`;
}

// ── Отправка сообщения через Wazzup24 (с ретраем) ──────────────────────────
// СВЕРИТЬ С docs.wazzup24.com — endpoint и поля могут отличаться.
// Возвращает true при успешной доставке, false — если доставить не удалось.
async function sendWazzupMessage(env, channelId, chatType, chatId, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(WAZZUP_SEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WAZZUP_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ channelId, chatType, chatId, text }),
      });
    } catch (e) {
      console.error('Wazzup send error:', e && e.message);
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (res.ok) return true;
    // 4xx (кроме 429) — ретрай не поможет
    if (res.status !== 429 && res.status < 500) {
      console.error(`Wazzup send ${res.status}:`, (await res.text()).slice(0, 200));
      return false;
    }
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    await sleep(retryAfter ? retryAfter * 1000 : 600 * (attempt + 1));
  }
  console.error('Wazzup send: retries exhausted');
  return false;
}

// ── Handoff: уведомить закреплённого менеджера ─────────────────────────────
async function handleHandoff(env, msg, reason) {
  if (!env.MANAGER_CHAT_ID) {
    console.error('handoff but MANAGER_CHAT_ID not set');
    return;
  }
  // Менеджеру нужен ПОЛНЫЙ контакт клиента, чтобы с ним связаться.
  const phone = msg.chatId || '—';
  const name = msg.contactName || '—';
  let note;
  if (reason === 'existing_client') {
    note = `Действующий клиент пишет в чат. Контакт: ${phone}. `
      + 'Нужен администратор — перенос/вопрос по записи.';
  } else if (reason === 'bot_unavailable') {
    note = `Бот временно недоступен и не смог ответить клиенту — срочно подхватите диалог. `
      + `Контакт: ${phone}, имя: ${name}.`;
  } else {
    note = `Лид требует менеджера (причина: ${reason}). Контакт: ${phone}, имя: ${name}.`;
  }
  await sendWazzupMessage(env, msg.channelId, env.MANAGER_CHAT_TYPE || 'whatsapp',
    env.MANAGER_CHAT_ID, `M&M-бот: ${note}`);
}

// ── Booking: сохранить карточку лида + уведомить менеджера ──────────────────
async function handleBooking(env, msg, booking) {
  const card = {
    ...booking,
    chatId: msg.chatId,
    channel: msg.chatType,
    createdAt: new Date().toISOString(),
  };
  await env.BOT_KV.put(`lead:${msg.chatId}:${Date.now()}`, JSON.stringify(card),
    { expirationTtl: LEAD_TTL });
  if (env.MANAGER_CHAT_ID) {
    const note = `Новая запись на консультацию.\nИмя: ${booking.name || '—'}\n`
      + `Телефон: ${booking.phone || '—'}\nПроцедура: ${booking.service || '—'}\n`
      + `Слот: ${booking.slot || '—'}\nПротивопоказания: ${booking.contraindications || 'нет'}`;
    await sendWazzupMessage(env, msg.channelId, env.MANAGER_CHAT_TYPE || 'whatsapp',
      env.MANAGER_CHAT_ID, `M&M-бот: ${note}`);
  }
}

// ── Утилиты ────────────────────────────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function maskPhone(v) {
  const s = String(v || '');
  return s.length > 4 ? `***${s.slice(-4)}` : '***';
}
