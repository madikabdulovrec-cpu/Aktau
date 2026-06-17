// restore_from_backup.js — восстановление Firestore из снапшота.
//
// Поддерживает 2 формата:
//   V2 snapshot (mm-backup-worker-v2): {schemaVersion:2, clientsV2:[], staffV2:[], legacy}
//   V1 snapshot (pre-sync-*.json или ручной dump): {fields: {clients:{arrayValue}, staff:{arrayValue}}}
//
// Куда восстанавливать:
//   --target=v2 — в коллекции mmClientsV2 + mmStaffV2 (default, актуальная архитектура)
//   --target=v1 — в старый документ mmClients/data (только для отката V2 → V1)
//
// Опции:
//   --backup=<path>     путь к JSON-снапшоту (обязательно)
//   --target=v1|v2      куда восстанавливать (default v2)
//   --pick=<clientId>   восстановить ОДНУ карточку (минимально-инвазивно)
//   --staff             включая mmStaffV2 (default: только клиенты)
//   --apply             реальная запись (без флага — dry-run)
//   --overwrite         перезаписать существующие (default: skip уже существующих)
//
// Примеры:
//   node worker/restore_from_backup.js --backup=.local_backups/pre-sync-20260617-121349.json
//     ↑ dry-run, V1 формат → восстановит в V2 коллекции
//
//   node worker/restore_from_backup.js --backup=.local_backups/snap-2026-06-18.json --apply
//     ↑ полное восстановление V2 в V2
//
//   node worker/restore_from_backup.js --backup=... --pick=alt_176472553_84766rx4 --apply
//     ↑ восстановить только Жанель Баубекова

const fs = require('fs');

const PROJ = 'mmclients-eea40';
const KEY = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const DELAY_MS = 30; // rate-limit

const argv = process.argv.slice(2);
function arg(name, def) {
  const a = argv.find(x => x.startsWith('--' + name + '=') || x === '--' + name);
  if (!a) return def;
  if (!a.includes('=')) return true;
  return a.split('=')[1];
}
const BACKUP = arg('backup');
const TARGET = arg('target', 'v2');
const PICK = arg('pick');
const STAFF = !!arg('staff');
const APPLY = !!arg('apply');
const OVERWRITE = !!arg('overwrite');

if (!BACKUP) {
  console.error('Usage: node worker/restore_from_backup.js --backup=<path> [--target=v2] [--pick=<id>] [--staff] [--apply] [--overwrite]');
  process.exit(1);
}
if (!['v1', 'v2'].includes(TARGET)) {
  console.error('--target must be v1 or v2');
  process.exit(1);
}

// === Firestore REST codec ===
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

// === Парсинг снапшота — определяем V1 или V2 ===
function parseSnapshot(raw) {
  const j = JSON.parse(raw);
  // V2 формат: явный schemaVersion + массивы clientsV2/staffV2
  if (j.schemaVersion === 2 && Array.isArray(j.clientsV2)) {
    return {
      version: 2,
      clients: j.clientsV2.map(doc => decFields(doc.fields || {})),
      staff: (j.staffV2 || []).map(doc => decFields(doc.fields || {})),
      meta: { backed_up_at: j.backed_up_at, source: 'v2-snapshot' },
    };
  }
  // V1 формат: либо fields.clients.arrayValue, либо плоский {clients:[], staff:[]}
  if (j.fields && j.fields.clients) {
    const decoded = decFields(j.fields);
    return {
      version: 1,
      clients: Array.isArray(decoded.clients) ? decoded.clients : [],
      staff: Array.isArray(decoded.staff) ? decoded.staff : [],
      meta: { source: 'v1-firestore-rest' },
    };
  }
  if (Array.isArray(j.clients)) {
    return {
      version: 1,
      clients: j.clients,
      staff: Array.isArray(j.staff) ? j.staff : [],
      meta: { source: 'v1-flat-json' },
    };
  }
  throw new Error('Unknown snapshot format. Ожидался V2 (schemaVersion:2) или V1 (fields.clients.arrayValue).');
}

// === Записать одну карточку в нужный target ===
async function writeOne(col, doc) {
  if (!doc.id) {
    console.warn('  skip: document has no id', JSON.stringify(doc).slice(0, 100));
    return { skipped: true };
  }
  const url = `${BASE}/${col}/${encodeURIComponent(doc.id)}?key=${KEY}`;
  if (!OVERWRITE) {
    // Если документ существует — пропускаем
    const head = await fetch(url);
    if (head.ok) return { skipped: 'exists' };
  }
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: encFields(doc) }),
  });
  if (!r.ok) {
    return { error: r.status + ' ' + (await r.text()).slice(0, 200) };
  }
  return { ok: true };
}

// === V1 target: восстановление в mmClients/data (single-doc) ===
async function writeV1Target(clients, staff) {
  const url = `${BASE}/mmClients/data?key=${KEY}`;
  console.log(`[V1] Восстанавливаю ${clients.length} клиентов + ${staff.length} мастеров в mmClients/data...`);
  if (!APPLY) {
    console.log('  DRY-RUN — пропускаем PATCH');
    return;
  }
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fields: encFields({ clients, staff, ts: Date.now(), _restored_at: new Date().toISOString() }),
    }),
  });
  if (!r.ok) {
    console.error('PATCH mmClients/data failed:', r.status, (await r.text()).slice(0, 300));
    process.exit(1);
  }
  console.log('  ✓ V1 target restored');
}

(async () => {
  console.log('=== restore_from_backup.js ===');
  console.log('Backup:', BACKUP);
  console.log('Target:', TARGET);
  console.log('Pick:', PICK || '(all)');
  console.log('Staff:', STAFF);
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY-RUN');
  console.log('Overwrite:', OVERWRITE);
  console.log('');

  if (!fs.existsSync(BACKUP)) { console.error('Файл не найден:', BACKUP); process.exit(1); }
  const raw = fs.readFileSync(BACKUP, 'utf8');
  const snap = parseSnapshot(raw);
  console.log(`Снапшот: v${snap.version}, source=${snap.meta.source}`);
  console.log(`  Клиентов: ${snap.clients.length}`);
  console.log(`  Мастеров: ${snap.staff.length}`);
  if (snap.meta.backed_up_at) console.log(`  Дата:    ${snap.meta.backed_up_at}`);
  console.log('');

  // Фильтр --pick
  let clientsToRestore = snap.clients;
  if (PICK) {
    clientsToRestore = snap.clients.filter(c => c.id === PICK);
    if (clientsToRestore.length === 0) {
      console.error(`Карточка id="${PICK}" не найдена в снапшоте.`);
      process.exit(1);
    }
    console.log(`Pick: восстанавливаю только ${PICK} (fio: ${clientsToRestore[0].fio || '-'})`);
  }

  // Восстановление
  if (TARGET === 'v1') {
    // В V1 target — пишем один документ
    await writeV1Target(clientsToRestore, STAFF ? snap.staff : []);
  } else {
    // V2 target — пишем по одной карточке
    console.log(`[V2] Восстанавливаю в mmClientsV2 (${clientsToRestore.length} карточек)...`);
    let ok = 0, skip = 0, fail = 0;
    for (let i = 0; i < clientsToRestore.length; i++) {
      const c = clientsToRestore[i];
      if (!APPLY) {
        if (i < 5) console.log(`  DRY [${i+1}/${clientsToRestore.length}] ${c.id} | ${c.fio || '-'}`);
        ok++; continue;
      }
      const res = await writeOne('mmClientsV2', c);
      if (res.ok) ok++;
      else if (res.skipped) skip++;
      else { fail++; console.error(`  ✗ ${c.id}:`, res.error); }
      if (ok % 50 === 0) console.log(`  ✓ ${ok}/${clientsToRestore.length}`);
      await sleep(DELAY_MS);
    }
    console.log(`[V2] clients: ${ok} ok, ${skip} skip(already-exists), ${fail} fail`);

    if (STAFF) {
      console.log(`[V2] Восстанавливаю в mmStaffV2 (${snap.staff.length} мастеров)...`);
      let sOk = 0, sSkip = 0, sFail = 0;
      for (const s of snap.staff) {
        if (!APPLY) { sOk++; continue; }
        const res = await writeOne('mmStaffV2', s);
        if (res.ok) sOk++;
        else if (res.skipped) sSkip++;
        else { sFail++; console.error(`  ✗ ${s.id}:`, res.error); }
        await sleep(DELAY_MS);
      }
      console.log(`[V2] staff: ${sOk} ok, ${sSkip} skip, ${sFail} fail`);
    }
  }

  console.log('');
  console.log(APPLY ? '✓ DONE' : 'DRY-RUN done. Add --apply for real write.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
