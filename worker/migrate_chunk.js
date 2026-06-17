// Параллельный чанк миграции mmClients/data → mmClientsV2 + mmStaffV2.
// Принимает --from=N --to=M аргументы, мигрирует только клиентов в диапазоне.
// Идемпотентен — PATCH с тем же id перезаписывает (можно гонять несколько раз).
//
// Запуск 4 параллельных чанков (~2.5 минуты вместо 70):
//   node worker/migrate_chunk.js --from=0    --to=550
//   node worker/migrate_chunk.js --from=550  --to=1100
//   node worker/migrate_chunk.js --from=1100 --to=1650
//   node worker/migrate_chunk.js --from=1650 --to=3000

const PROJ = 'mmclients-eea40';
const KEY = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const DELAY_MS = 10; // меньше delay — быстрее

const argv = process.argv.slice(2);
function arg(name, def) {
  const a = argv.find(x => x.startsWith('--' + name + '='));
  return a ? a.split('=')[1] : def;
}
const FROM = parseInt(arg('from', '0'), 10);
const TO = parseInt(arg('to', '99999'), 10);

function encVal(v) { if (v === null || v === undefined) return { nullValue: null }; if (typeof v === 'boolean') return { booleanValue: v }; if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }; if (typeof v === 'string') return { stringValue: v }; if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } }; if (typeof v === 'object') return { mapValue: { fields: encFields(v) } }; return { stringValue: String(v) }; }
function encFields(o) { const r = {}; for (const k of Object.keys(o)) r[k] = encVal(o[k]); return r; }
function decVal(v) { if (!v || typeof v !== 'object') return v; if ('nullValue' in v) return null; if ('booleanValue' in v) return v.booleanValue; if ('integerValue' in v) return parseInt(v.integerValue, 10); if ('doubleValue' in v) return v.doubleValue; if ('stringValue' in v) return v.stringValue; if ('timestampValue' in v) return v.timestampValue; if ('arrayValue' in v) return (v.arrayValue.values || []).map(decVal); if ('mapValue' in v) return decFields(v.mapValue.fields || {}); return null; }
function decFields(f) { const r = {}; for (const k of Object.keys(f)) r[k] = decVal(f[k]); return r; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log(`[chunk ${FROM}-${TO}] start`);
  const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  if (!r.ok) { console.error('GET fail', r.status); process.exit(1); }
  const doc = await r.json();
  const d = decFields(doc.fields || {});
  const clients = Array.isArray(d.clients) ? d.clients : [];
  const slice = clients.slice(FROM, TO);
  console.log(`[chunk ${FROM}-${TO}] slice: ${slice.length} clients`);

  let ok = 0, fail = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (!c || !c.id) continue;
    try {
      const url = `${BASE}/mmClientsV2/${encodeURIComponent(c.id)}?key=${KEY}`;
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: encFields(c) }),
      });
      if (resp.ok) ok++;
      else { fail++; console.error(`[chunk ${FROM}-${TO}] fail ${c.id}: ${resp.status}`); }
      if (ok % 50 === 0) console.log(`[chunk ${FROM}-${TO}] ${ok}/${slice.length}`);
      await sleep(DELAY_MS);
    } catch (e) {
      fail++;
      console.error(`[chunk ${FROM}-${TO}] exception ${c.id}: ${e.message}`);
    }
  }
  console.log(`[chunk ${FROM}-${TO}] DONE: ${ok} ok, ${fail} fail`);
})();
