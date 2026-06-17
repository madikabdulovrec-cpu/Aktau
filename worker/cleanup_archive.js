// Hard-delete архивных карточек (deleted=true) из Firestore mmClients/data.
//
// Зачем: soft-delete (deleted=true) только помечает запись, но не освобождает
// место. После merge 73 master-карточек данные уже скопированы в Altegio-копии,
// дубли больше не нужны физически. Удалим их → освободится ~25-40 КБ.
//
// Безопасность:
//   - Только записи с deleted=true и deletedReason='merged-into-...'
//   - Полный бэкап перед операцией обязателен.
//   - PATCH с precondition.
//
// Запуск:
//   node worker/cleanup_archive.js          # dry-run
//   node worker/cleanup_archive.js --apply

const fs = require('fs');
const PROJ = 'mmclients-eea40';
const KEY = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const APPLY = process.argv.includes('--apply');

function encVal(v) { if (v === null || v === undefined) return { nullValue: null }; if (typeof v === 'boolean') return { booleanValue: v }; if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }; if (typeof v === 'string') return { stringValue: v }; if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } }; if (typeof v === 'object') return { mapValue: { fields: encFields(v) } }; return { stringValue: String(v) }; }
function encFields(o) { const r = {}; for (const k of Object.keys(o)) r[k] = encVal(o[k]); return r; }
function decVal(v) { if (!v || typeof v !== 'object') return v; if ('nullValue' in v) return null; if ('booleanValue' in v) return v.booleanValue; if ('integerValue' in v) return parseInt(v.integerValue, 10); if ('doubleValue' in v) return v.doubleValue; if ('stringValue' in v) return v.stringValue; if ('timestampValue' in v) return v.timestampValue; if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal); if ('mapValue' in v) return decFields(v.mapValue.fields || {}); return null; }
function decFields(f) { const r = {}; for (const k of Object.keys(f)) r[k] = decVal(f[k]); return r; }

async function run() {
  console.log(APPLY ? '=== APPLY ===' : '=== DRY-RUN ===');
  const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  const doc = await r.json();
  if (!r.ok) { console.error('GET fail:', doc); process.exit(1); }
  const updateTime = doc.updateTime;
  const d = decFields(doc.fields || {});
  const clients = Array.isArray(d.clients) ? d.clients : [];
  const staff = Array.isArray(d.staff) ? d.staff : [];

  const before = clients.length;
  const beforeSize = JSON.stringify({ staff, clients }).length;
  // Безопасный фильтр: удаляем только merged-into-*, остальные soft-deleted
  // оставляем (например, удалённые мастером вручную — могут понадобиться).
  const toKeep = clients.filter(c => !(c.deleted && (c.deletedReason || '').startsWith('merged-into-')));
  const removed = before - toKeep.length;
  const afterSize = JSON.stringify({ staff, clients: toKeep }).length;
  console.log(`Удалить: ${removed} карточек`);
  console.log(`Размер: ${(beforeSize / 1024).toFixed(1)} КБ → ${(afterSize / 1024).toFixed(1)} КБ (освободится ${((beforeSize - afterSize) / 1024).toFixed(1)} КБ)`);

  if (!APPLY) { console.log('DRY-RUN — запустите с --apply'); return; }

  const url = `${BASE}/mmClients/data?key=${KEY}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
  const body = { fields: encFields({ staff, clients: toKeep, ts: Date.now() }) };
  const p = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!p.ok) { console.error('PATCH FAIL:', p.status, (await p.text()).slice(0, 500)); process.exit(1); }
  console.log('✅ PATCH ok. updateTime:', (await p.json()).updateTime);
  console.log(`Удалено: ${removed}. Активных осталось: ${toKeep.length}`);
}
run().catch(e => { console.error('FATAL:', e); process.exit(1); });
