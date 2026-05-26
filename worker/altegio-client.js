/**
 * altegio-client.js
 *
 * Утилиты для интеграции с Altegio API (только чтение): проверка истории
 * визитов клиента + получение свободных слотов записи. Извлечено из бота
 * M&M Fabrica (worker/mh-bot.js) как переиспользуемый модуль для других
 * проектов, работающих с Altegio.
 *
 * Стек: чистый JS на fetch — работает в Cloudflare Workers, Node 18+,
 * Deno, современных браузерах. Зависимостей нет.
 *
 * ── Переменные окружения ───────────────────────────────────────────────────
 *  ALTEGIO_PARTNER_TOKEN       — bearer-токен партнёра Altegio (обязательно)
 *  ALTEGIO_USER_TOKEN          — user-токен Altegio (обязательно)
 *  ALTEGIO_COMPANY_ID          — id филиала Altegio (обязательно)
 *  ALTEGIO_CONSULT_SERVICE_ID  — id услуги для чтения слотов (нужно только
 *                                для getAltegioSlots; можно переопределить
 *                                через opts.serviceId)
 *
 *  Передаются в виде объекта env: { ALTEGIO_PARTNER_TOKEN, ... }.
 *
 * ── Принцип ────────────────────────────────────────────────────────────────
 * Только чтение из Altegio. Запись (создание клиентов, бронирование) НЕ
 * делаем — оставляем менеджеру. При любой ошибке функции возвращают
 * безопасный фоллбэк (false / null), не бросают исключение наружу.
 */

const ALTEGIO_API = 'https://api.alteg.io/api/v1';

/**
 * Заголовки Altegio API (двойной токен: партнёр + пользователь).
 */
export function altegioHeaders(env) {
  return {
    Authorization: `Bearer ${env.ALTEGIO_PARTNER_TOKEN}, User ${env.ALTEGIO_USER_TOKEN}`,
    Accept: 'application/vnd.api.v2+json',
    'Content-Type': 'application/json',
  };
}

/**
 * Есть ли у телефона история визитов в Altegio (= действующий клиент).
 * Используется как гейт «новый/действующий».
 * @returns {Promise<boolean>} true, если есть хотя бы один визит
 */
export async function altegioHasVisitHistory(env, phone) {
  if (!env.ALTEGIO_PARTNER_TOKEN || !env.ALTEGIO_USER_TOKEN || !env.ALTEGIO_COMPANY_ID) {
    return false;
  }
  const url = `${ALTEGIO_API}/company/${env.ALTEGIO_COMPANY_ID}/clients/search`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: altegioHeaders(env),
      body: JSON.stringify({
        page: 1,
        page_size: 5,
        fields: ['id', 'phone', 'visit_count'],
        filters: [{ type: 'quick_search', state: phone }],
      }),
    });
  } catch (e) {
    console.error('altegio search error:', e && e.message);
    return false;
  }
  if (!res.ok) {
    console.error('altegio search:', res.status);
    return false;
  }
  const data = await res.json().catch(() => null);
  const list = (data && data.data) || [];
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((c) => Number(c && c.visit_count) > 0);
}

/**
 * Свободные окна записи на услугу из Altegio. Только чтение.
 * @returns {Promise<string[]|null>} массив "YYYY-MM-DD: HH:mm, HH:mm" или null
 */
export async function getAltegioSlots(env, opts = {}) {
  const serviceId = opts.serviceId || env.ALTEGIO_CONSULT_SERVICE_ID;
  const maxDates = opts.maxDates ?? 2;
  const maxTimes = opts.maxTimesPerDate ?? 3;
  if (!env.ALTEGIO_PARTNER_TOKEN || !env.ALTEGIO_USER_TOKEN
    || !env.ALTEGIO_COMPANY_ID || !serviceId) {
    return null;
  }
  const co = env.ALTEGIO_COMPANY_ID;
  const sid = encodeURIComponent(serviceId);
  try {
    const datesRes = await fetch(`${ALTEGIO_API}/book_dates/${co}?service_ids[]=${sid}`,
      { headers: altegioHeaders(env) });
    if (!datesRes.ok) { console.error('altegio book_dates:', datesRes.status); return null; }
    const dJson = await datesRes.json().catch(() => null);
    const d = dJson && dJson.data;
    const dates = (d && (d.booking_dates || d.working_dates)) || [];
    if (!Array.isArray(dates) || !dates.length) return null;

    const out = [];
    for (const date of dates.slice(0, maxDates)) {
      const tRes = await fetch(`${ALTEGIO_API}/book_times/${co}/0/${date}?service_ids[]=${sid}`,
        { headers: altegioHeaders(env) });
      if (!tRes.ok) continue;
      const tJson = await tRes.json().catch(() => null);
      const times = (tJson && tJson.data) || [];
      const hhmm = times.map((t) => (t && (t.time || t))).filter(Boolean).slice(0, maxTimes);
      if (hhmm.length) out.push(`${date}: ${hhmm.join(', ')}`);
    }
    return out.length ? out : null;
  } catch (e) {
    console.error('getAltegioSlots error:', e && e.message);
    return null;
  }
}

/* ── Пример использования (Cloudflare Worker / Node 18+) ─────────────────────

import { altegioHasVisitHistory, getAltegioSlots } from './altegio-client.js';

const env = {
  ALTEGIO_PARTNER_TOKEN: '...',
  ALTEGIO_USER_TOKEN: '...',
  ALTEGIO_COMPANY_ID: '12345',
  ALTEGIO_CONSULT_SERVICE_ID: '67890',
};

const isExisting = await altegioHasVisitHistory(env, '77071234567');
if (isExisting) { /* передать диалог менеджеру, не отвечать ботом *\/ }

const slots = await getAltegioSlots(env);
// → ["2026-05-23: 11:00, 14:00, 17:00", "2026-05-24: 10:00, 13:00"]

────────────────────────────────────────────────────────────────────────────── */
