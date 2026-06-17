// sync_delta_v1_to_v2.js
// ============================================================================
// DELTA-СИНК: догнать mmClientsV2 правками, которые случились в старом
// mmClients/data ПОКА шла массовая миграция (migrate_to_collection.js).
//
// КОНТЕКСТ:
//   Только что прошла миграция 2169 клиентов из single-doc mmClients/data
//   в коллекцию mmClientsV2/{id}. Сама миграция заняла ~5-10 минут — за это
//   время мастера могли что-то сохранить в платформе. Поскольку платформа
//   на момент миграции всё ещё писала в СТАРЫЙ mmClients/data, эти свежие
//   правки в mmClientsV2 НЕ попали.
//
//   Скрипт идёт по старому массиву clients[] и для каждой записи смотрит,
//   что лежит в mmClientsV2/{id}:
//     1) если в V2 такой карточки нет     → добавить (она появилась во время
//        миграции и не была подхвачена основным проходом).
//     2) если в V2 карточка есть, но её updatedAt СТАРШЕ, чем у версии в V1
//        → перезаписать V2 версией из V1 (V1 свежее, значит правка прилетела
//        ПОСЛЕ того, как migrate_to_collection.js уже записал эту карточку).
//     3) если в V2 updatedAt >= V1 → ничего не делать (V2 уже актуальна или
//        даже свежее — Worker мог записать напрямую через altegio-webhook).
//
//   Записи, которые есть в V2, но отсутствуют в V1, НЕ трогаем — это могли
//   быть новые карточки, созданные через Worker напрямую в V2 уже после того,
//   как платформу переключили на новую коллекцию.
//
// БЕЗОПАСНОСТЬ:
//   - По умолчанию DRY-RUN: только покажет diff, ничего не пишет.
//   - Старый mmClients/data НЕ изменяется, читаем только.
//   - Между запросами sleep 30 мс, чтобы не словить rate-limit Firestore.
//
// ЗАПУСК:
//   node sync_delta_v1_to_v2.js          # dry-run (показать diff)
//   node sync_delta_v1_to_v2.js --apply  # реально перенести в V2
// ============================================================================

const PROJ = 'mmclients-eea40';
const KEY  = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;

const APPLY = process.argv.includes('--apply');
const BATCH_DELAY_MS = 30; // пауза между запросами против rate-limit

// ============== Firestore JSON encoding (как в migrate_to_collection.js) ==============
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Парсер updatedAt: поддерживает и число (ms-since-epoch), и ISO-строку.
// Возвращает число (ms). Отсутствие/мусор → 0, чтобы такая запись считалась
// "самой старой" и при сравнении проигрывала любой нормальной отметке времени.
function parseUpdatedAt(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    // Возможно ISO ("2026-06-17T..."), возможно строка с числом.
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

// ============== Main ==============
(async () => {
  console.log('============================================');
  console.log(' DELTA SYNC: mmClients/data → mmClientsV2');
  console.log(' MODE:', APPLY ? 'APPLY (реальная запись)' : 'DRY-RUN (ничего не пишем)');
  console.log('============================================');

  // ----- 1. Читаем старый single-document mmClients/data -----
  console.log('\n[1/3] Чтение mmClients/data (V1, single-doc)...');
  const r1 = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  if (!r1.ok) {
    console.error('  GET V1 failed:', r1.status, (await r1.text()).slice(0, 200));
    process.exit(1);
  }
  const doc1 = await r1.json();
  const d1 = decFields(doc1.fields || {});
  const v1Clients = Array.isArray(d1.clients) ? d1.clients : [];
  // Индекс id → клиент. Если в массиве вдруг есть дубликаты — выиграет
  // последний (что разумно: вероятнее всего это и есть самая свежая запись).
  const v1ById = new Map();
  for (const c of v1Clients) if (c && c.id) v1ById.set(String(c.id), c);
  console.log(`  V1: ${v1Clients.length} клиентов в массиве, уникальных id: ${v1ById.size}`);

  // ----- 2. Читаем всю коллекцию mmClientsV2 (с пагинацией) -----
  console.log('\n[2/3] Чтение коллекции mmClientsV2 (V2)...');
  const v2ById = new Map();
  let pageToken = '';
  let pages = 0;
  while (true) {
    const url = `${BASE}/mmClientsV2?key=${KEY}&pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error('  list V2 failed:', resp.status, (await resp.text()).slice(0, 200));
      process.exit(1);
    }
    const j = await resp.json();
    const docs = j.documents || [];
    for (const d of docs) {
      // d.name = ".../mmClientsV2/{id}" → берём последний сегмент как id
      const id = d.name.split('/').pop();
      v2ById.set(String(id), decFields(d.fields || {}));
    }
    pages++;
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
    await sleep(BATCH_DELAY_MS);
  }
  console.log(`  V2: ${v2ById.size} документов (страниц: ${pages})`);

  // ----- 3. Определяем дельту -----
  console.log('\n[3/3] Расчёт дельты...');
  const onlyInV1 = [];       // нет в V2 совсем → надо создать
  const fresherInV1 = [];    // есть в V2, но V1.updatedAt > V2.updatedAt → перезаписать
  const onlyInV2 = [];       // есть в V2, но нет в V1 → НЕ трогаем (логируем)
  const upToDate = [];       // V2 >= V1 → ничего не делать

  for (const [id, c1] of v1ById.entries()) {
    const c2 = v2ById.get(id);
    if (!c2) { onlyInV1.push(c1); continue; }
    const t1 = parseUpdatedAt(c1.updatedAt);
    const t2 = parseUpdatedAt(c2.updatedAt);
    if (t1 > t2) fresherInV1.push({ c1, t1, t2 });
    else upToDate.push(id);
  }
  for (const id of v2ById.keys()) {
    if (!v1ById.has(id)) onlyInV2.push(id);
  }

  console.log(`  Всего в V1:                 ${v1ById.size}`);
  console.log(`  Всего в V2:                 ${v2ById.size}`);
  console.log(`  Fresh в V1 (updatedAt >):   ${fresherInV1.length}`);
  console.log(`  Только в V1 (нет в V2):     ${onlyInV1.length}`);
  console.log(`  Только в V2 (нет в V1):     ${onlyInV2.length}  (НЕ трогаем)`);
  console.log(`  Совпадают / V2 свежее:      ${upToDate.length}`);

  // Покажем по 5 примеров каждой категории, чтобы было видно что мигрируется.
  if (fresherInV1.length) {
    console.log('\n  Примеры fresh-in-V1 (top 5):');
    for (const { c1, t1, t2 } of fresherInV1.slice(0, 5)) {
      console.log(`    ${c1.id}  ${c1.fio || ''}   V1:${new Date(t1).toISOString()}  >  V2:${new Date(t2).toISOString()}`);
    }
  }
  if (onlyInV1.length) {
    console.log('\n  Примеры only-in-V1 (top 5):');
    for (const c of onlyInV1.slice(0, 5)) console.log(`    ${c.id}  ${c.fio || ''}`);
  }
  if (onlyInV2.length) {
    console.log('\n  Примеры only-in-V2 (top 5, НЕ трогаем):');
    for (const id of onlyInV2.slice(0, 5)) console.log(`    ${id}`);
  }

  // ----- Применяем (если --apply) -----
  const toWrite = [...onlyInV1, ...fresherInV1.map(x => x.c1)];
  if (!APPLY) {
    console.log(`\nDRY-RUN: было бы записано ${toWrite.length} карточек в mmClientsV2.`);
    console.log('Запусти с --apply, чтобы реально перенести.');
    return;
  }

  console.log(`\nAPPLY: пишем ${toWrite.length} карточек в mmClientsV2...`);
  let ok = 0, fail = 0;
  for (let i = 0; i < toWrite.length; i++) {
    const c = toWrite[i];
    if (!c || !c.id) { console.warn('    клиент без id, skip:', JSON.stringify(c).slice(0, 100)); continue; }
    try {
      // PATCH без updateMask → полная замена документа полями из V1.
      // Это именно то поведение, которое нам нужно: V1-версия свежее, она и
      // должна стать новым состоянием в V2.
      const url = `${BASE}/mmClientsV2/${encodeURIComponent(c.id)}?key=${KEY}`;
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: encFields(c) }),
      });
      if (!resp.ok) {
        console.error(`    FAIL ${c.id} (${c.fio || ''}):`, resp.status, (await resp.text()).slice(0, 200));
        fail++;
      } else {
        ok++;
        if (ok % 10 === 0) console.log(`    ${ok}/${toWrite.length}`);
      }
      await sleep(BATCH_DELAY_MS);
    } catch (e) {
      console.error(`    EXCEPTION ${c.id}:`, e?.message);
      fail++;
    }
  }

  console.log('\n============================================');
  console.log(' DELTA SYNC DONE');
  console.log(`   записано:  ${ok}`);
  console.log(`   ошибок:    ${fail}`);
  console.log(`   режим:     APPLY`);
  console.log('============================================');
})();
