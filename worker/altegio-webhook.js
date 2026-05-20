/**
 * M&M Altegio Webhook Receiver — Cloudflare Worker
 *
 * Принимает webhook от Altegio о событиях клиента и:
 *   1. Создаёт/обновляет/удаляет (soft) карточку в Firestore (mmClients/data).
 *   2. Записывает ссылку на карточку в кастомное поле `mm_card_url` клиента в Altegio.
 *
 * SOURCE OF TRUTH: этот файл. Деплой через `wrangler deploy` или копированием
 * в Cloudflare Dashboard → Workers & Pages → mm-altegio → Edit code.
 *
 * Env vars (Cloudflare Dashboard → Settings → Variables and Secrets):
 *   ALTEGIO_PARTNER_TOKEN — bearer токен партнёра                  (Secret)
 *   ALTEGIO_USER_TOKEN    — user-токен системного пользователя      (Secret)
 *   ALTEGIO_COMPANY_ID    — ID филиала, напр. "1330174"            (Plaintext)
 *   PLATFORM_BASE_URL     — напр. "https://clients.mmfabrica.com"  (Plaintext)
 *   FIREBASE_PROJECT_ID   — напр. "mmclients-eea40"                (Plaintext)
 *   FIREBASE_API_KEY      — Web API key из Firebase Console        (Secret)
 *   WEBHOOK_SECRET        — общий секрет для верификации webhook   (Secret)
 *
 * URL для Altegio: https://mm-altegio.<account>.workers.dev/?secret=<WEBHOOK_SECRET>
 */

const ALTEGIO_API = 'https://api.alteg.io/api/v1';
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';
const CUSTOM_FIELD_NAME = 'mm_card_url';

// Маркер строки в comment клиента — по нему мы находим и обновляем строку
// со ссылкой при следующем webhook (чтобы не плодить дубликаты).
// Эмодзи в маркер НЕ КЛАДЁМ — Altegio при сохранении заменяет '📋' на '?',
// и идемпотентный матч ломается. Поиск через includes(MARKER), значит
// покроет любые префиксы (включая legacy блоки с эмодзи или '?').
const COMMENT_MARKER = 'Карточка M&M:';

const REQUIRED_ENV = [
  'ALTEGIO_PARTNER_TOKEN', 'ALTEGIO_USER_TOKEN', 'ALTEGIO_COMPANY_ID',
  'PLATFORM_BASE_URL', 'FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'WEBHOOK_SECRET',
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Healthcheck — Altegio дёргает GET при первичной настройке webhook
    if (request.method === 'GET') {
      return jsonResponse({
        status: 'ok',
        service: 'mm-altegio-webhook',
        firestore: env.FIREBASE_PROJECT_ID || null,
        time: new Date().toISOString(),
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
    }

    // Конфигурация — проверяем явно, чтобы не было silent-fail
    const missing = REQUIRED_ENV.filter(k => !env[k]);
    if (missing.length) {
      console.error('[config] missing env vars:', missing.join(','));
      return jsonResponse({ ok: false, error: 'misconfigured' }, 500);
    }

    // Authorization: принимаем два режима, потому что Altegio при сохранении
    // webhook URL режет query string и шлёт со своим Authorization header.
    //   1) ?secret=<WEBHOOK_SECRET> в URL  — для curl/manual triggers/тестов.
    //   2) Authorization header + валидный payload — для реальных Altegio.
    // Доп. фильтр company_id (env.ALTEGIO_COMPANY_ID) ниже отсекает левые
    // запросы — заголовок Authorization есть у каждого второго бота, но
    // правильный company_id знают только из настроек филиала.
    const secretMatches = url.searchParams.get('secret') === env.WEBHOOK_SECRET;
    const hasAuthHeader = !!request.headers.get('authorization');
    if (!secretMatches && !hasAuthHeader) {
      console.warn('[auth] missing or invalid secret param');
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    }
    // Метаданные авторизации — для аудита, без значений
    const authHeader = request.headers.get('authorization') || '';
    console.log('[auth]', {
      via: secretMatches ? 'query' : 'header',
      authHeaderLen: authHeader.length,
      authHeaderPrefix: authHeader.slice(0, 8), // например "Bearer " — без токена
    });

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
    }

    const { resource, status, resource_id, data, company_id } = payload;

    // Логируем только метаданные. PII (ФИО, телефоны, дата рождения) НЕ ЛОГИРУЕМ —
    // логи Cloudflare хранятся ~3 дня и доступны всем с правами на аккаунт.
    console.log('[webhook]', { resource, status, resource_id, company_id });

    if (resource !== 'client') {
      return jsonResponse({ ok: true, skipped: 'not_a_client_event', resource });
    }

    if (String(company_id) !== String(env.ALTEGIO_COMPANY_ID)) {
      return jsonResponse({ ok: true, skipped: 'wrong_company' });
    }

    try {
      if (status === 'delete') {
        const ourCardId = await markCardDeletedInFirestore({ env, altegioId: resource_id });
        return jsonResponse({ ok: true, action: 'delete', ourCardId });
      }

      // create / update — апсёрт в Firestore + запись ссылки в Altegio
      const altegioClient = data || { id: resource_id };
      const ourCardId = await upsertCardInFirestore({ env, altegioClient });

      const cardUrl = `${env.PLATFORM_BASE_URL.replace(/\/$/, '')}/?id=${ourCardId}`;
      const altegioWriteResult = await writeCustomFieldToAltegioClient({
        env,
        clientId: resource_id,
        cardUrl,
      });

      return jsonResponse({ ok: true, action: status, ourCardId, cardUrl, altegioWriteResult });
    } catch (e) {
      // Детали — только в логи Cloudflare. Наружу — generic, чтобы не утечь
      // ни Altegio-токены, ни Firestore project ID через сообщение об ошибке.
      console.error('[webhook] error:', e?.message || String(e), e?.stack || '');
      return jsonResponse({ ok: false, error: 'internal_error' }, 500);
    }
  },
};

/* ============================================================
 * FIRESTORE — upsert/delete карточки в документ mmClients/data
 * ============================================================ */

async function fetchFirestoreDoc(env) {
  const url = `${FIRESTORE_API}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/mmClients/data?key=${env.FIREBASE_API_KEY}`;
  const resp = await fetch(url);
  if (resp.status === 404) {
    // Документ ещё не создавался — стартуем с пустого state.
    return { staff: [], clients: [], _exists: false, _updateTime: null };
  }
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`firestore GET failed: ${resp.status} ${txt.slice(0, 200)}`);
  }
  const json = await resp.json();
  const decoded = decodeFirestoreFields(json.fields || {});
  return {
    staff: Array.isArray(decoded.staff) ? decoded.staff : [],
    clients: Array.isArray(decoded.clients) ? decoded.clients : [],
    _exists: true,
    // updateTime нужен для optimistic-locking: PATCH пройдёт только если
    // документ не менялся с этого момента (см. patchFirestoreDoc).
    _updateTime: json.updateTime || null,
  };
}

async function patchFirestoreDoc(env, state) {
  let url = `${FIRESTORE_API}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/mmClients/data?key=${env.FIREBASE_API_KEY}`;
  // OPTIMISTIC CONCURRENCY: пишем документ только если он не изменился с
  // момента нашего GET. Если другой webhook или платформа записали раньше —
  // Firestore вернёт 400/409 FAILED_PRECONDITION, и withFirestoreRetry
  // повторит весь цикл fetch→modify→patch со свежим снимком. Без этого два
  // одновременных webhook'а теряли карточки (инциденты Лоры и Айнагуль).
  if (state._exists && state._updateTime) {
    url += `&currentDocument.updateTime=${encodeURIComponent(state._updateTime)}`;
  } else if (!state._exists) {
    url += `&currentDocument.exists=false`;
  }
  const fields = encodeFirestoreFields({
    staff: state.staff,
    clients: state.clients,
    ts: Date.now(),
  });
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  // Firestore REST на проваленный precondition отвечает 400 (с status
  // FAILED_PRECONDITION в теле) либо 409. Распознаём оба и сигналим retry.
  if (resp.status === 409 || resp.status === 412 || resp.status === 400) {
    const txt = await resp.text();
    if (resp.status !== 400 || /FAILED_PRECONDITION|exists|updateTime/i.test(txt)) {
      const err = new Error('firestore precondition failed (concurrent write)');
      err.code = 'PRECONDITION_FAILED';
      throw err;
    }
    // 400 по другой причине — это реальная ошибка, не ретраим
    throw new Error(`firestore PATCH failed: 400 ${txt.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`firestore PATCH failed: ${resp.status} ${txt.slice(0, 200)}`);
  }
}

// Optimistic-concurrency retry. fn() делает полный цикл fetch→modify→patch.
// Если patchFirestoreDoc упал с PRECONDITION_FAILED (кто-то записал документ
// параллельно) — повторяем весь цикл со свежим GET. Экспоненциальный backoff
// с jitter разводит конкурентов во времени, чтобы они не толкались бесконечно.
async function withFirestoreRetry(fn) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e && e.code === 'PRECONDITION_FAILED' && attempt < MAX_ATTEMPTS) {
        const delay = Math.min(80 * 2 ** (attempt - 1), 1200) + Math.random() * 150;
        console.log(`[firestore] concurrent write, retry ${attempt}/${MAX_ATTEMPTS} in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  // Сюда не доходим — последняя попытка либо вернёт значение, либо бросит.
  throw new Error('firestore retry exhausted');
}

async function upsertCardInFirestore({ env, altegioClient }) {
  const altegioIdStr = String(altegioClient.id || '');
  if (!altegioIdStr) throw new Error('altegio client missing id');

  // Весь цикл fetch→modify→patch — внутри retry с optimistic-locking.
  return await withFirestoreRetry(async () => {
    const state = await fetchFirestoreDoc(env);
    const idx = state.clients.findIndex(c => String(c.altegioId || '') === altegioIdStr);

    let cardId;
    if (idx >= 0) {
      // Обновление существующей — синкаем только поля, которые приходят из Altegio.
      // Поля, заполненные мастером (анамнез, фото, замеры, рекомендации) — НЕ ТРОГАЕМ.
      // updatedAt бампаем ТОЛЬКО при реальном изменении: иначе remote-копия
      // искусственно «свежеет» и merge на платформе может откатить правки мастера.
      const c = state.clients[idx];
      cardId = c.id;
      let changed = false;
      if (altegioClient.name && c.fio !== altegioClient.name) { c.fio = altegioClient.name; changed = true; }
      if (altegioClient.phone && c.phone !== altegioClient.phone) { c.phone = altegioClient.phone; changed = true; }
      if (String(c.altegioId || '') !== altegioIdStr) { c.altegioId = altegioIdStr; changed = true; }
      if (c.deleted) { c.deleted = false; changed = true; }
      if (changed) {
        c.updatedAt = Date.now();
      } else {
        // Ничего не изменилось — выходим без записи, чтобы не дёргать Firestore
        // и не плодить лишние ts-апдейты.
        return cardId;
      }
    } else {
      // Новая карточка — заводим скелет, мастер дозаполнит при следующем визите клиента.
      cardId = `alt_${altegioIdStr}_${shortRand()}`;
      state.clients.push({
        id: cardId,
        date: new Date().toISOString().slice(0, 10),
        specialist: '',
        specialistId: '',
        fio: altegioClient.name || '',
        phone: altegioClient.phone || '',
        age: '',
        weight: '',
        height: '',
        source: [],
        complaints: '',
        anamnesis: [],
        anamnesisOther: '',
        recommendations: '',
        initialPhotos: [],
        altegioId: altegioIdStr,
        altegioLink: '',
        sessions: [],
        measurements: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    await patchFirestoreDoc(env, state);
    return cardId;
  });
}

async function markCardDeletedInFirestore({ env, altegioId }) {
  const altegioIdStr = String(altegioId || '');
  if (!altegioIdStr) return null;

  return await withFirestoreRetry(async () => {
    const state = await fetchFirestoreDoc(env);
    const idx = state.clients.findIndex(c => String(c.altegioId || '') === altegioIdStr);
    if (idx < 0) return null;

    // Soft-delete: помечаем флагом, реальные данные/фото сохраняем — мастер мог
    // потратить часы на анамнез, нельзя потерять при случайном удалении в Altegio.
    if (state.clients[idx].deleted === true) {
      // Уже помечена — не пишем повторно.
      return state.clients[idx].id;
    }
    state.clients[idx].deleted = true;
    state.clients[idx].updatedAt = Date.now();
    await patchFirestoreDoc(env, state);
    return state.clients[idx].id;
  });
}

function shortRand() {
  return Math.random().toString(36).slice(2, 10);
}

/* ============================================================
 * FIRESTORE — энкод/декод нативных полей (REST API)
 * ============================================================ */

function encodeFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFirestoreFields(v) } };
  return { stringValue: String(v) };
}

function encodeFirestoreFields(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    out[k] = encodeFirestoreValue(obj[k]);
  }
  return out;
}

function decodeFirestoreValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in v) return decodeFirestoreFields(v.mapValue.fields || {});
  return null;
}

function decodeFirestoreFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) {
    out[k] = decodeFirestoreValue(fields[k]);
  }
  return out;
}

/* ============================================================
 * ALTEGIO — запись ссылки в кастомное поле клиента
 *   API /client/{company}/{id} требует name и phone в PUT всегда. Поэтому
 *   GET-им клиента, мерджим custom_fields, PUT-им с обязательными полями.
 * ============================================================ */

async function writeCustomFieldToAltegioClient({ env, clientId, cardUrl }) {
  const clientUrl = `${ALTEGIO_API}/client/${env.ALTEGIO_COMPANY_ID}/${clientId}`;

  // 1. GET — забираем актуальные name/phone и существующие custom_fields
  const getResp = await fetch(clientUrl, { method: 'GET', headers: altegioHeaders(env) });
  if (getResp.status === 404) {
    // Клиент удалён в Altegio между webhook'ом и нашим GET — нечего обновлять.
    return { success: false, reason: 'altegio_client_not_found' };
  }
  if (!getResp.ok) {
    const txt = await getResp.text();
    throw new Error(`altegio GET failed: ${getResp.status} ${txt.slice(0, 200)}`);
  }
  const getJson = await getResp.json();
  const cur = (getJson && (getJson.data || getJson)) || {};

  // 2. Мержим custom_fields — чужие поля сохраняем, наше mm_card_url добавляем/обновляем
  const existingCustomFields = cur.custom_fields && typeof cur.custom_fields === 'object'
    ? cur.custom_fields : {};
  const mergedCustomFields = {
    ...existingCustomFields,
    [CUSTOM_FIELD_NAME]: cardUrl,
  };

  // 3. Дополняем comment ссылкой — стандартный UI Altegio показывает comment
  // прямо в карточке клиента, в отличие от custom_fields. Идемпотентно:
  // удаляем предыдущую нашу строку (если есть) и добавляем свежую в конец.
  // Текст, который мастер сам написал в комментарии, сохраняется.
  const newComment = mergeCommentWithCardUrl(cur.comment || '', cardUrl);

  // 4. PUT — name+phone обязательны, иначе Altegio вернёт "The required parameter name was not passed"
  // Приводим к строкам — Altegio может вернуть phone как число (77071234567),
  // а API ожидает строку. Без cast PUT может сбойнуть.
  const body = {
    name: cur.name == null ? '' : String(cur.name),
    phone: cur.phone == null ? '' : String(cur.phone),
    comment: newComment,
    custom_fields: mergedCustomFields,
  };

  const putResp = await fetch(clientUrl, {
    method: 'PUT',
    headers: altegioHeaders(env),
    body: JSON.stringify(body),
  });
  if (!putResp.ok) {
    const txt = await putResp.text();
    throw new Error(`altegio PUT failed: ${putResp.status} ${txt.slice(0, 200)}`);
  }
  const putJson = await putResp.json();

  return {
    success: putJson?.success !== false,
    data: putJson?.data ? { custom_fields: putJson.data.custom_fields } : null,
  };
}

function altegioHeaders(env) {
  return {
    'Authorization': `Bearer ${env.ALTEGIO_PARTNER_TOKEN}, User ${env.ALTEGIO_USER_TOKEN}`,
    'Accept': 'application/vnd.api.v2+json',
    'Content-Type': 'application/json',
  };
}

/**
 * Идемпотентно встраивает строку «Карточка M&M: <url>» в comment клиента.
 * Удаляет ТОЛЬКО строки, которые однозначно являются нашим блоком — то есть:
 *   - начинаются с маркера (опционально с префиксом-мусором: "📋 ", "? ", " " …),
 *   - сразу после маркера идёт http(s)-URL.
 * Это защищает от случайного съедания текста мастера, в котором маркер
 * упомянут как обычная фраза, например "Не путать! Карточка M&M: внутреннее".
 */
function mergeCommentWithCardUrl(existingComment, cardUrl) {
  const lines = String(existingComment || '').split('\n');
  const cleanLines = lines.filter(l => !isOurMarkerLine(l));
  // Убираем висячие пустые строки в конце, чтобы не накапливались между апдейтами
  while (cleanLines.length && cleanLines[cleanLines.length - 1].trim() === '') {
    cleanLines.pop();
  }
  const ourLine = `${COMMENT_MARKER} ${cardUrl}`;
  return cleanLines.length ? `${cleanLines.join('\n')}\n\n${ourLine}` : ourLine;
}

function isOurMarkerLine(line) {
  const idx = line.indexOf(COMMENT_MARKER);
  if (idx < 0) return false;
  // Перед маркером допускаем только пробелы и не-словесные символы (эмодзи "📋",
  // подменённое Altegio "?", прочий мусор). Если есть буквы/цифры — это текст
  // мастера, не наш блок.
  const before = line.slice(0, idx);
  if (/[\p{L}\p{N}]/u.test(before)) return false;
  // Сразу после маркера должен быть URL (http://… или https://…). Иначе это
  // не наш формат.
  const after = line.slice(idx + COMMENT_MARKER.length).trim();
  return /^https?:\/\//i.test(after);
}

/* ============================================================
 * UTIL
 * ============================================================ */

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
