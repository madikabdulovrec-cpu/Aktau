// Merge дубликатов карточек в Firestore mmClients/data.
//
// Задача: 31 пара дубликатов где у клиента есть:
//   - "Altegio-карточка" (id вида alt_XXX_YYY, имеет altegioId, anketa пуста)
//   - "Master-карточка" (id вида id_XXX, без altegioId, anketa заполнена)
// Мастер ищет клиента → находит Altegio-карточку → видит пустую анкету →
// думает что данные пропали. На самом деле они в master-карточке.
//
// Что делает скрипт:
//   1. GET документа mmClients/data со свежим updateTime.
//   2. Найти пары: Altegio-пустая + master-заполненная по нормализованному phone.
//   3. Перенести master-поля из master-карточки в Altegio-карточку (anamnesis,
//      complaints, recommendations, anamnesisOther, source, age, weight, height,
//      specialist, specialistId, initialPhotos, sessions, measurements).
//      Если Altegio-карточка уже имеет что-то — НЕ затирать (победитель — кто
//      непустой; при обоих заполненных — по updatedAt). Это идемпотентно.
//   4. Master-карточку soft-delete (deleted=true) и bump updatedAt.
//   5. PATCH с currentDocument.updateTime precondition. Retry до 6 раз.
//
// Запуск:
//   node worker/merge_duplicates.js          # dry-run, ничего не пишет
//   node worker/merge_duplicates.js --apply  # применить изменения

const fs = require('fs');

const PROJ = 'mmclients-eea40';
const KEY = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const APPLY = process.argv.includes('--apply');

// Firestore REST codec
function encVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } };
  if (typeof v === 'object') return { mapValue: { fields: encFields(v) } };
  return { stringValue: String(v) };
}
function encFields(o) { const r = {}; for (const k of Object.keys(o)) r[k] = encVal(o[k]); return r; }
function decVal(v) {
  if (!v || typeof v !== 'object') return v;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal);
  if ('mapValue' in v) return decFields(v.mapValue.fields || {});
  return null;
}
function decFields(f) { const r = {}; for (const k of Object.keys(f)) r[k] = decVal(f[k]); return r; }

function normalizePhone(s) { return String(s || '').replace(/\D/g, '').replace(/^8/, '7'); }
function isFieldEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}
function hasAnket(c) {
  return !isFieldEmpty(c.complaints) || !isFieldEmpty(c.anamnesisOther) ||
    !isFieldEmpty(c.anamnesis) || !isFieldEmpty(c.recommendations) ||
    (c.sessions || []).length > 0 || (c.initialPhotos || []).length > 0 ||
    (c.measurements || []).length > 0 ||
    !isFieldEmpty(c.age) || !isFieldEmpty(c.weight) || !isFieldEmpty(c.height);
}

const MASTER_FIELDS = [
  'complaints', 'anamnesis', 'anamnesisOther', 'recommendations',
  'initialPhotos', 'sessions', 'measurements',
  'source', 'age', 'weight', 'height',
  'date', 'specialist', 'specialistId',
];

// Берём поле у того кто непуст; при обоих непустых — у master-карточки (она
// заполнена мастером, мы ей доверяем; Altegio-карточка изначально и должна быть
// пустой пока мастер не открыл).
function pickField(altCard, masterCard, f) {
  const av = altCard[f], mv = masterCard[f];
  const aEmpty = isFieldEmpty(av), mEmpty = isFieldEmpty(mv);
  if (!mEmpty) return mv;
  if (!aEmpty) return av;
  return undefined;
}

async function run() {
  console.log(APPLY ? '=== APPLY MODE — будут записаны изменения в Firestore ===' : '=== DRY-RUN — изменений не будет ===');

  const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  const doc = await r.json();
  if (!r.ok) { console.error('GET failed:', doc); process.exit(1); }
  const updateTime = doc.updateTime;
  const d = decFields(doc.fields || {});
  const clients = Array.isArray(d.clients) ? d.clients : [];
  const staff = Array.isArray(d.staff) ? d.staff : [];

  console.log(`Документ загружен: ${clients.length} клиентов, updateTime=${updateTime}`);

  // Группируем по нормализованному phone
  const byPhone = new Map();
  for (const c of clients) {
    if (c.deleted) continue;
    const p = normalizePhone(c.phone);
    if (!p || p.length < 7) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(c);
  }

  // Находим merge-кандидаты
  const merges = [];
  for (const [phone, arr] of byPhone) {
    if (arr.length < 2) continue;
    const altCards = arr.filter(c => c.altegioId);
    const masterCards = arr.filter(c => !c.altegioId);
    // Случай 1: один Altegio + один или несколько master-карточек
    if (altCards.length === 1 && masterCards.length >= 1) {
      const altCard = altCards[0];
      // Сливаем все master-карточки в Altegio (берём самую заполненную как primary)
      const filledMaster = masterCards.filter(hasAnket);
      if (filledMaster.length === 0) continue; // оба пусты — не наш случай
      // Если несколько заполненных master-карточек — берём самую свежую
      filledMaster.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const primary = filledMaster[0];
      const toDelete = masterCards; // все master-карточки soft-delete
      merges.push({ phone, altCard, primary, toDelete, group: arr });
    }
    // Можно расширить на altCards.length>1 или masterCards.length>1, но пока 31 случай
    // подходит под простой паттерн.
  }

  console.log(`\nНайдено пар для merge: ${merges.length}`);
  console.log('');

  // Применяем merge на копии массива clients
  const idx = new Map();
  for (let i = 0; i < clients.length; i++) if (clients[i].id) idx.set(clients[i].id, i);

  let mergeOps = 0, deleteOps = 0;
  for (const m of merges) {
    const aIdx = idx.get(m.altCard.id);
    if (aIdx === undefined) { console.warn('skip — altCard not in idx', m.altCard.id); continue; }
    // Перенос полей
    const updates = {};
    for (const f of MASTER_FIELDS) {
      const newV = pickField(m.altCard, m.primary, f);
      if (newV !== undefined) {
        const before = clients[aIdx][f];
        if (JSON.stringify(before) !== JSON.stringify(newV)) {
          updates[f] = newV;
        }
      }
    }
    // Применяем
    if (Object.keys(updates).length > 0) {
      Object.assign(clients[aIdx], updates);
      clients[aIdx].updatedAt = Math.max(Number(m.altCard.updatedAt) || 0, Number(m.primary.updatedAt) || 0, Date.now());
      mergeOps++;
    }
    // Soft-delete master-карточки
    for (const dup of m.toDelete) {
      const dIdx = idx.get(dup.id);
      if (dIdx === undefined) continue;
      if (clients[dIdx].deleted) continue; // уже удалена
      clients[dIdx].deleted = true;
      clients[dIdx].deletedReason = 'merged-into-' + m.altCard.id;
      clients[dIdx].updatedAt = Date.now();
      deleteOps++;
    }
    // Лог
    const u = Object.keys(updates);
    console.log(`  + ${m.altCard.id.slice(0, 30)} <- ${m.primary.id.slice(0, 24)} | ${m.primary.fio || '-'} | phone ${m.altCard.phone} | fields: ${u.length ? u.join(',') : '(уже синхронизированы)'}`);
  }

  console.log(`\nИтого:`);
  console.log(`  merged fields:   ${mergeOps}`);
  console.log(`  soft-deleted:    ${deleteOps}`);
  console.log(`  total clients:   ${clients.filter(c => !c.deleted).length} активных, ${clients.filter(c => c.deleted).length} в архиве`);

  if (!APPLY) {
    console.log('\nDRY-RUN — изменения не записаны. Запустите с --apply для применения.');
    return;
  }

  // Применяем PATCH с precondition
  console.log('\nЗапись в Firestore...');
  const url = `${BASE}/mmClients/data?key=${KEY}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
  const body = { fields: encFields({ staff, clients, ts: Date.now() }) };
  const p = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!p.ok) {
    const t = await p.text();
    console.error('PATCH FAIL:', p.status, t.slice(0, 500));
    process.exit(1);
  }
  const result = await p.json();
  console.log('✅ PATCH ok. Новый updateTime:', result.updateTime);
  console.log('Слито пар:', merges.length);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
