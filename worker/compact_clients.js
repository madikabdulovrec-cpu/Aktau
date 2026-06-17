// Компактификация карточек: удалить пустые поля (поля со значениями '', [], null).
// Зачем: после массового sync 1161 новой карточки документ занимает 905 КБ из
// 1024 (88%). У пустых карточек поля типа initialPhotos:[], sessions:[],
// measurements:[], anamnesis:[], complaints:'', anamnesisOther:'' занимают
// ~40-50 байт каждое × 1100 пустых карточек = ~50 КБ зря.
//
// Платформа (clients_platform/index.html) корректно обрабатывает отсутствующие
// поля через `c.field || ''` / `c.field || []` — поведение не изменится.

const fs = require('fs');
const PROJ = 'mmclients-eea40';
const KEY = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const APPLY = process.argv.includes('--apply');

function encVal(v) { if (v === null || v === undefined) return { nullValue: null }; if (typeof v === 'boolean') return { booleanValue: v }; if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }; if (typeof v === 'string') return { stringValue: v }; if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } }; if (typeof v === 'object') return { mapValue: { fields: encFields(v) } }; return { stringValue: String(v) }; }
function encFields(o) { const r = {}; for (const k of Object.keys(o)) r[k] = encVal(o[k]); return r; }
function decVal(v) { if (!v || typeof v !== 'object') return v; if ('nullValue' in v) return null; if ('booleanValue' in v) return v.booleanValue; if ('integerValue' in v) return parseInt(v.integerValue, 10); if ('doubleValue' in v) return v.doubleValue; if ('stringValue' in v) return v.stringValue; if ('timestampValue' in v) return v.timestampValue; if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal); if ('mapValue' in v) return decFields(v.mapValue.fields || {}); return null; }
function decFields(f) { const r = {}; for (const k of Object.keys(f)) r[k] = decVal(f[k]); return r; }

// Поля которые ОБЯЗАТЕЛЬНЫ — НЕ удаляем даже если пустые (платформа может
// ожидать их наличие): id, fio, phone, createdAt, updatedAt.
const REQUIRED = new Set(['id', 'fio', 'phone', 'createdAt', 'updatedAt']);

function compactCard(c) {
  const out = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (REQUIRED.has(k)) { out[k] = v; continue; }
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

async function run() {
  console.log(APPLY ? '=== APPLY ===' : '=== DRY-RUN ===');
  const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  const doc = await r.json();
  if (!r.ok) { console.error('GET fail:', doc); process.exit(1); }
  const updateTime = doc.updateTime;
  const d = decFields(doc.fields || {});
  const clients = Array.isArray(d.clients) ? d.clients : [];
  const staff = Array.isArray(d.staff) ? d.staff : [];

  const before = JSON.stringify({ staff, clients }).length;
  const compact = clients.map(compactCard);
  const after = JSON.stringify({ staff, clients: compact }).length;

  console.log(`Размер: ${(before / 1024).toFixed(1)} КБ → ${(after / 1024).toFixed(1)} КБ`);
  console.log(`Освобождается: ${((before - after) / 1024).toFixed(1)} КБ`);
  console.log(`Использовано после: ${(100 * after / 1048576).toFixed(1)}%`);

  if (!APPLY) { console.log('DRY-RUN — запустите с --apply'); return; }

  const url = `${BASE}/mmClients/data?key=${KEY}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
  const body = { fields: encFields({ staff, clients: compact, ts: Date.now() }) };
  const p = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!p.ok) { console.error('PATCH FAIL:', p.status, (await p.text()).slice(0, 500)); process.exit(1); }
  console.log('✅ PATCH ok. updateTime:', (await p.json()).updateTime);
}
run().catch(e => { console.error('FATAL:', e); process.exit(1); });
