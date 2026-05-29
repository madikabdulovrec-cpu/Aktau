// migrate_to_collection.js
// ============================================================================
// МИГРАЦИОННЫЙ СКРИПТ: single-document mmClients/data → коллекции mmClientsV2/{id}
// + mmStaffV2/{id}.
//
// ЗАЧЕМ: текущая архитектура хранит ВСЕХ клиентов и мастеров в одном
// Firestore-документе (mmClients/data). Это работает, пока документ < 1 МБ.
// Сейчас ~300 КБ (255 клиентов), но при росте до 800+ клиентов лимит будет
// близко. Плюс single-doc создаёт contention: одна транзакция блокирует
// другую, race condition'ы между Worker'ом и платформой требуют сложного
// merge-on-write (см. altegio-webhook.js → withFirestoreRetry).
//
// ЦЕЛЬ: после миграции каждая карточка — свой документ в коллекции.
//  - Параллельные write'ы не конфликтуют (Firestore сам управляет lock'ами).
//  - Размер коллекции не ограничен (только лимит документа: 1 МБ на карточку).
//  - cloudSubscribe слушает коллекцию и получает только реально изменённые
//    карточки, не весь массив (быстрее, дешевле reads).
//  - Worker делает простой `doc/{id}`.set() без runTransaction.
//
// БЕЗОПАСНОСТЬ:
//  - Скрипт ТОЛЬКО ЧИТАЕТ старый документ и ЗАПИСЫВАЕТ в новые коллекции.
//  - Старый mmClients/data ОСТАЁТСЯ как есть — откат = просто не переключать UI.
//  - Запускать в режиме DRY_RUN сначала, потом APPLY.
//
// ЗАПУСК:
//   1. dry-run (просто посчитает, ничего не пишет):
//        DRY_RUN=1 node worker/migrate_to_collection.js
//   2. реальная запись:
//        node worker/migrate_to_collection.js
//   3. проверка после:
//        node -e "fetch('https://firestore.googleapis.com/v1/projects/mmclients-eea40/databases/(default)/documents/mmClientsV2?key=AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro&pageSize=5').then(r=>r.json()).then(d=>console.log(JSON.stringify(d).slice(0,500)))"
// ============================================================================

const PROJ = 'mmclients-eea40';
const KEY  = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;

const DRY_RUN = !!process.env.DRY_RUN;
const BATCH_DELAY_MS = 50; // пауза между записями чтобы не словить rate-limit

// ============== Firestore JSON encoding ==============
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

// ============== Main ==============
(async () => {
  console.log('============================================');
  console.log(' MIGRATION: mmClients/data → mmClientsV2 + mmStaffV2');
  console.log(' MODE:', DRY_RUN ? 'DRY-RUN (ничего не пишем)' : 'APPLY (реальная запись)');
  console.log('============================================');

  // 1. Читаем старый документ
  console.log('\n[1/4] Чтение mmClients/data...');
  const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  if (!r.ok) {
    console.error('  ❌ GET failed:', r.status, (await r.text()).slice(0, 200));
    process.exit(1);
  }
  const doc = await r.json();
  const d = decFields(doc.fields || {});
  const clients = Array.isArray(d.clients) ? d.clients : [];
  const staff = Array.isArray(d.staff) ? d.staff : [];
  console.log(`  ✓ Прочитано: ${clients.length} клиентов, ${staff.length} мастеров`);

  // 2. Проверка целевых коллекций — пустые?
  console.log('\n[2/4] Проверка целевых коллекций...');
  const rClients = await fetch(`${BASE}/mmClientsV2?key=${KEY}&pageSize=1`);
  const rStaff = await fetch(`${BASE}/mmStaffV2?key=${KEY}&pageSize=1`);
  const existingClients = rClients.ok ? (await rClients.json()).documents : [];
  const existingStaff = rStaff.ok ? (await rStaff.json()).documents : [];
  if ((existingClients?.length || 0) > 0 || (existingStaff?.length || 0) > 0) {
    console.error('  ⚠️  Целевые коллекции НЕ пусты:');
    console.error('       mmClientsV2:', existingClients?.length || 0, 'документов');
    console.error('       mmStaffV2:  ', existingStaff?.length || 0, 'документов');
    console.error('  Скрипт безопасный (merge), но проверь — возможно миграция уже была.');
    console.error('  Чтобы продолжить — установи FORCE=1, либо удали целевые коллекции и запусти снова.');
    if (!process.env.FORCE) process.exit(2);
  } else {
    console.log('  ✓ Целевые коллекции пусты — можно мигрировать чисто.');
  }

  // 3. Миграция staff
  console.log('\n[3/4] Миграция staff → mmStaffV2/{id}...');
  let staffOk = 0, staffFail = 0;
  for (const s of staff) {
    if (!s || !s.id) { console.warn('    ⚠️ staff без id, skip:', JSON.stringify(s).slice(0, 100)); continue; }
    if (DRY_RUN) {
      console.log(`    DRY ${s.id} (${s.name || s.login || '—'})`);
      staffOk++; continue;
    }
    try {
      // PATCH с createIfMissing — создаст или обновит документ.
      const url = `${BASE}/mmStaffV2/${encodeURIComponent(s.id)}?key=${KEY}`;
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: encFields(s) }),
      });
      if (!resp.ok) {
        console.error(`    ❌ ${s.id}:`, resp.status, (await resp.text()).slice(0, 200));
        staffFail++;
      } else {
        staffOk++;
      }
      await sleep(BATCH_DELAY_MS);
    } catch (e) {
      console.error(`    ❌ ${s.id} exception:`, e?.message);
      staffFail++;
    }
  }
  console.log(`  staff: ${staffOk} ok, ${staffFail} fail`);

  // 4. Миграция clients
  console.log('\n[4/4] Миграция clients → mmClientsV2/{id}...');
  let clientsOk = 0, clientsFail = 0;
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    if (!c || !c.id) { console.warn('    ⚠️ client без id, skip:', JSON.stringify(c).slice(0, 100)); continue; }
    if (DRY_RUN) {
      if (i % 25 === 0) console.log(`    DRY ${i + 1}/${clients.length}: ${c.fio || c.id}`);
      clientsOk++; continue;
    }
    try {
      const url = `${BASE}/mmClientsV2/${encodeURIComponent(c.id)}?key=${KEY}`;
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: encFields(c) }),
      });
      if (!resp.ok) {
        console.error(`    ❌ ${c.id} (${c.fio}):`, resp.status, (await resp.text()).slice(0, 200));
        clientsFail++;
      } else {
        clientsOk++;
        if (clientsOk % 25 === 0) console.log(`    ✓ ${clientsOk}/${clients.length}`);
      }
      await sleep(BATCH_DELAY_MS);
    } catch (e) {
      console.error(`    ❌ ${c.id} exception:`, e?.message);
      clientsFail++;
    }
  }

  console.log('\n============================================');
  console.log(' DONE');
  console.log(`   staff:   ${staffOk} migrated, ${staffFail} failed`);
  console.log(`   clients: ${clientsOk} migrated, ${clientsFail} failed`);
  console.log(`   mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log('============================================');
  console.log('\nПроверь результат в Firestore Console:');
  console.log('   https://console.firebase.google.com/project/' + PROJ + '/firestore/databases/-default-/data/~2FmmClientsV2');
  console.log('\nСтарый документ mmClients/data ОСТАЛСЯ нетронутым — это страховка.');
  console.log('После проверки и переключения index.html на V2 — старый документ можно удалить.');
})();
