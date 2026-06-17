#!/usr/bin/env node
/**
 * verify_v2_migration.js
 *
 * Скрипт верификации миграции clients[] из mmClients/data в mmClientsV2.
 *
 * Запуск:
 *   node verify_v2_migration.js
 *
 * Проверки:
 *   1. Подсчёт документов: V1 (mmClients/data.clients[].length) ≈ V2 (count в mmClientsV2)
 *   2. Спот-проверка 20 случайных карточек по ключевым полям
 *   3. Важные карточки (Жанель Баубекова, Алена Рахматуллина)
 *   4. mmStaffV2 — должно быть 4 документа
 *   5. Поиск null/undefined клиентов в V2
 *   6. Карточки с id вида alt_* должны иметь поле altegioId
 *
 * Никаких внешних зависимостей — только встроенный fetch (Node 18+).
 */

'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Конфиг
// ────────────────────────────────────────────────────────────────────────────

const PROJECT_ID = 'mmclients-eea40';
const API_KEY = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const SPOT_CHECK_SAMPLE_SIZE = 20;
const COUNT_TOLERANCE = 5; // допустимое расхождение V1 vs V2

// Карточки, которые обязаны существовать с полными данными
const CRITICAL_CARDS = [
  {
    id: 'alt_176472553_84766rx4',
    label: 'Жанель Баубекова',
    mustHave: ['fio', 'phone'], // минимальный набор
  },
  {
    id: 'alt_183132871_w6n42ho8',
    label: 'Алена Рахматуллина',
    mustHave: ['fio', 'phone', 'complaints', 'anamnesis'],
    mustEqual: { age: 26 },
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Утилиты для Firestore REST API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Декодирует значение Firestore REST formata в обычный JS.
 * Firestore возвращает { stringValue: "..." } / { integerValue: "..." } и т.д.
 */
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = decodeValue(v);
  }
  return out;
}

/**
 * GET документ по полному пути (без BASE).
 * Возвращает декодированный объект полей или null при 404.
 */
async function getDoc(path) {
  const url = `${BASE}/${path}?key=${API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return decodeFields(json.fields || {});
}

/**
 * Листает коллекцию полностью (с пагинацией).
 * Возвращает массив { id, fields } для каждого документа.
 */
async function listCollection(collectionPath, pageSize = 300) {
  const out = [];
  let pageToken = null;
  let safety = 0;

  while (true) {
    safety++;
    if (safety > 200) throw new Error('pagination safety break');

    const params = new URLSearchParams({ key: API_KEY, pageSize: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${BASE}/${collectionPath}?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`LIST ${collectionPath} → HTTP ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();

    for (const doc of json.documents || []) {
      // doc.name = projects/.../documents/collection/id
      const id = doc.name.split('/').pop();
      out.push({ id, fields: decodeFields(doc.fields || {}) });
    }

    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers для сравнения карточек V1 vs V2
// ────────────────────────────────────────────────────────────────────────────

function lenSafe(x) {
  if (x == null) return 0;
  if (Array.isArray(x)) return x.length;
  if (typeof x === 'string') return x.length;
  return 0;
}

/**
 * Сравнивает ключевые поля V1-карточки и V2-карточки.
 * Возвращает массив строк-различий (пустой = всё ок).
 */
function diffCards(v1, v2) {
  const diffs = [];
  const fields = ['fio', 'phone', 'altegioId'];
  for (const f of fields) {
    const a = v1?.[f] ?? null;
    const b = v2?.[f] ?? null;
    if (String(a ?? '') !== String(b ?? '')) {
      diffs.push(`${f}: V1="${a}" vs V2="${b}"`);
    }
  }
  // длины
  const lenChecks = [
    ['complaints', lenSafe(v1?.complaints), lenSafe(v2?.complaints)],
    ['anamnesis', lenSafe(v1?.anamnesis), lenSafe(v2?.anamnesis)],
    ['sessions', lenSafe(v1?.sessions), lenSafe(v2?.sessions)],
    ['initialPhotos', lenSafe(v1?.initialPhotos), lenSafe(v2?.initialPhotos)],
  ];
  for (const [name, a, b] of lenChecks) {
    if (a !== b) diffs.push(`${name}.length: V1=${a} vs V2=${b}`);
  }
  return diffs;
}

// ────────────────────────────────────────────────────────────────────────────
// Раннер проверок
// ────────────────────────────────────────────────────────────────────────────

const results = []; // { name, pass, detail }

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const mark = pass ? '✓ PASS' : '✗ FAIL';
  console.log(`${mark}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Проверки
// ────────────────────────────────────────────────────────────────────────────

async function checkCounts(v1Clients, v2Docs) {
  const v1Count = v1Clients.length;
  const v2Count = v2Docs.length;
  const diff = Math.abs(v1Count - v2Count);
  const pass = diff <= COUNT_TOLERANCE;
  record(
    'Подсчёт документов V1 vs V2',
    pass,
    `V1=${v1Count}, V2=${v2Count}, diff=${diff} (tolerance=${COUNT_TOLERANCE})`
  );
}

async function checkSpotSample(v1Clients, v2ById) {
  // фильтруем V1 на те, у кого есть id
  const withId = v1Clients.filter(c => c && c.id);
  if (withId.length === 0) {
    record('Spot-check 20 случайных карточек', false, 'в V1 нет клиентов с id');
    return;
  }

  // случайная выборка
  const shuffled = withId.slice().sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, Math.min(SPOT_CHECK_SAMPLE_SIZE, shuffled.length));

  let okCount = 0;
  const failures = [];

  for (const v1 of sample) {
    const v2 = v2ById.get(v1.id);
    if (!v2) {
      failures.push(`id=${v1.id} (${v1.fio || '—'}): отсутствует в V2`);
      continue;
    }
    const diffs = diffCards(v1, v2);
    if (diffs.length === 0) {
      okCount++;
    } else {
      failures.push(`id=${v1.id} (${v1.fio || '—'}): ${diffs.join('; ')}`);
    }
  }

  const pass = okCount === sample.length;
  const detail = `${okCount}/${sample.length} совпадают` +
    (failures.length ? '\n   ' + failures.slice(0, 10).join('\n   ') : '');
  record('Spot-check случайных карточек', pass, detail);
}

async function checkCriticalCards(v2ById) {
  for (const card of CRITICAL_CARDS) {
    const doc = v2ById.get(card.id);
    if (!doc) {
      record(`Важная карточка: ${card.label} (${card.id})`, false, 'не найдена в mmClientsV2');
      continue;
    }
    const missing = [];
    for (const f of card.mustHave) {
      const val = doc[f];
      const empty = val == null || (Array.isArray(val) && val.length === 0) || val === '';
      if (empty) missing.push(`пусто: ${f}`);
    }
    if (card.mustEqual) {
      for (const [k, expected] of Object.entries(card.mustEqual)) {
        if (doc[k] !== expected) missing.push(`${k}=${doc[k]} (ожидалось ${expected})`);
      }
    }
    const pass = missing.length === 0;
    record(`Важная карточка: ${card.label}`, pass, pass ? 'ок' : missing.join('; '));
  }
}

async function checkStaff() {
  try {
    const docs = await listCollection('mmStaffV2');
    const pass = docs.length === 4;
    record('mmStaffV2 содержит 4 мастера', pass, `найдено ${docs.length}`);
  } catch (e) {
    record('mmStaffV2 содержит 4 мастера', false, `ошибка: ${e.message}`);
  }
}

async function checkNullClients(v2Docs) {
  const bad = [];
  for (const doc of v2Docs) {
    const f = doc.fields || {};
    const fio = f.fio;
    const phone = f.phone;
    const fioBad = fio == null || (typeof fio === 'string' && fio.trim() === '');
    const phoneBad = phone == null || (typeof phone === 'string' && phone.trim() === '');
    if (fioBad && phoneBad) {
      bad.push(doc.id);
    }
  }
  const pass = bad.length === 0;
  record(
    'Нет карточек без fio и phone',
    pass,
    pass ? `0 проблемных` : `${bad.length} проблемных: ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? '…' : ''}`
  );
}

async function checkAltDocsHaveAltegioId(v2Docs) {
  const missing = [];
  for (const doc of v2Docs) {
    if (!doc.id.startsWith('alt_')) continue;
    const altId = doc.fields?.altegioId;
    if (altId == null || altId === '' || altId === 0) {
      missing.push(doc.id);
    }
  }
  const pass = missing.length === 0;
  record(
    'Карточки alt_* имеют altegioId',
    pass,
    pass ? `все ок` : `${missing.length} без altegioId: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`
  );
}

// ────────────────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('═══ verify_v2_migration.js ═══');
  console.log(`Project: ${PROJECT_ID}\n`);

  // 1. Загружаем старый mmClients/data
  console.log('→ Загружаю mmClients/data (V1)…');
  let v1Doc;
  try {
    v1Doc = await getDoc('mmClients/data');
  } catch (e) {
    console.error('FATAL: не удалось прочитать mmClients/data:', e.message);
    process.exit(2);
  }
  if (!v1Doc) {
    console.error('FATAL: mmClients/data не найден');
    process.exit(2);
  }
  const v1Clients = Array.isArray(v1Doc.clients) ? v1Doc.clients : [];
  console.log(`  V1 клиентов: ${v1Clients.length}`);

  // 2. Листаем mmClientsV2 целиком
  console.log('→ Листаю коллекцию mmClientsV2 (V2)…');
  let v2Docs = [];
  try {
    v2Docs = await listCollection('mmClientsV2');
  } catch (e) {
    console.error('FATAL: не удалось пролистать mmClientsV2:', e.message);
    process.exit(2);
  }
  console.log(`  V2 документов: ${v2Docs.length}\n`);

  // индекс по id для O(1) lookup
  const v2ById = new Map();
  for (const d of v2Docs) v2ById.set(d.id, d.fields);

  console.log('───────── Проверки ─────────');

  await checkCounts(v1Clients, v2Docs);
  await checkSpotSample(v1Clients, v2ById);
  await checkCriticalCards(v2ById);
  await checkStaff();
  await checkNullClients(v2Docs);
  await checkAltDocsHaveAltegioId(v2Docs);

  // итог
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log('\n═══ ИТОГ ═══');
  console.log(`passed ${passed}/${total}`);

  if (passed < total) {
    console.log('\nFAIL detail:');
    for (const r of results) {
      if (!r.pass) console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  } else {
    console.log('Миграция выглядит корректной — можно переключать платформу.');
    process.exit(0);
  }
})().catch(e => {
  console.error('UNCAUGHT:', e);
  process.exit(3);
});
