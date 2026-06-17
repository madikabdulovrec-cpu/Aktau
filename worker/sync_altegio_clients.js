// Массовая синхронизация клиентов Altegio → Firestore mmClients/data.
//
// Зачем: Worker mm-altegio создаёт карточки только по webhook (создание/
// изменение клиента в Altegio). Клиенты, которые были в Altegio ДО запуска
// Worker'а (до мая 2026) — никогда не получили карточку в Firestore. Это
// порождает жалобы «нет карты клиента, перешёл по ссылке — пусто».
//
// Что делает:
//   1. GET /clients/{company}?page=1..N (count=200) — постранично выкачивает
//      ВСЕХ клиентов Altegio. Останавливается когда страница пустая.
//   2. GET текущего документа Firestore mmClients/data.
//   3. Для каждого Altegio-клиента: если нет в Firestore по altegioId — добавляет
//      минимальную карточку: { id: alt_{altegioId}_{rand}, fio, phone, altegioId,
//      altegioLink, createdAt, updatedAt }. Анкета пустая — заполнит мастер.
//   4. PATCH Firestore с precondition.
//
// Безопасно:
//   - Не трогает существующие карточки.
//   - Не удаляет ничего.
//   - Если карточка уже есть (по altegioId) — пропускает.
//   - PATCH с currentDocument.updateTime — не перетрёт параллельные изменения.
//
// Запуск:
//   node worker/sync_altegio_clients.js          # dry-run
//   node worker/sync_altegio_clients.js --apply  # применить

const fs = require('fs');

const PROJ = 'mmclients-eea40';
const KEY = 'AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const ALTEGIO_COMPANY = 1330174;
const ALTEGIO_AUTH = 'Bearer e8ye6b5d82fyg32dnhmk, User 2b6f792e8af7f3b617585bb508e51374';
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

function shortRand() {
  return Math.random().toString(36).slice(2, 10);
}

async function fetchAllAltegioClients() {
  console.log('Качаю клиентов Altegio постранично...');
  const all = [];
  for (let page = 1; page < 50; page++) { // safety cap 50 страниц = 10000 клиентов
    const r = await fetch(`https://api.alteg.io/api/v1/clients/${ALTEGIO_COMPANY}?page=${page}&count=200`, {
      headers: { 'Authorization': ALTEGIO_AUTH, 'Accept': 'application/vnd.api.v2+json' }
    });
    if (!r.ok) { console.error('Altegio GET fail page', page, r.status); break; }
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    if (data.length === 0) break;
    all.push(...data);
    process.stdout.write(`  page ${page}: +${data.length} (всего ${all.length})\r`);
    if (data.length < 200) break; // последняя страница
  }
  console.log('');
  console.log(`Всего клиентов в Altegio: ${all.length}`);
  return all;
}

async function run() {
  console.log(APPLY ? '=== APPLY MODE — будут созданы карточки в Firestore ===' : '=== DRY-RUN — изменений не будет ===');

  // 1. Текущий Firestore
  const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  const doc = await r.json();
  if (!r.ok) { console.error('Firestore GET fail:', doc); process.exit(1); }
  const updateTime = doc.updateTime;
  const d = decFields(doc.fields || {});
  const clients = Array.isArray(d.clients) ? d.clients : [];
  const staff = Array.isArray(d.staff) ? d.staff : [];
  console.log(`Firestore: ${clients.length} клиентов, updateTime=${updateTime}`);

  // Индекс существующих по altegioId (как строка)
  const existingAltIds = new Set();
  for (const c of clients) {
    if (c.altegioId) existingAltIds.add(String(c.altegioId));
  }
  console.log(`С привязкой к Altegio (altegioId): ${existingAltIds.size}`);

  // 2. Все клиенты Altegio
  const altClients = await fetchAllAltegioClients();

  // 3. Найти отсутствующих
  const missing = altClients.filter(a => !existingAltIds.has(String(a.id)));
  console.log(`\nОтсутствует в Firestore: ${missing.length} клиентов\n`);

  if (missing.length === 0) {
    console.log('Все клиенты уже синхронизированы.');
    return;
  }

  // Топ-10 для просмотра
  console.log('Первые 10 для проверки:');
  for (const c of missing.slice(0, 10)) {
    console.log(`  ${c.id} | ${(c.name || '-').padEnd(30)} | ${c.phone || '-'} | визитов: ${c.visits || 0}`);
  }
  if (missing.length > 10) console.log(`  ... ещё ${missing.length - 10} клиентов`);

  // 4. Сформировать новые карточки
  const now = Date.now();
  const newCards = missing.map(c => ({
    id: `alt_${c.id}_${shortRand()}`,
    fio: String(c.name || '').trim() || '—',
    phone: String(c.phone || ''),
    altegioId: String(c.id),
    altegioLink: c.custom_fields?.mm_card_url || '',
    specialist: '',
    specialistId: '',
    date: '',
    age: '',
    weight: '',
    height: '',
    source: [],
    complaints: '',
    anamnesis: [],
    anamnesisOther: '',
    recommendations: '',
    initialPhotos: [],
    sessions: [],
    measurements: [],
    createdAt: now,
    updatedAt: now,
  }));

  const newClients = [...clients, ...newCards];
  console.log(`\nКлиентов после sync: ${newClients.length} (+${newCards.length})`);

  if (!APPLY) {
    console.log('\nDRY-RUN — запустите с --apply для применения.');
    return;
  }

  // 5. PATCH с precondition
  console.log('\nЗапись в Firestore...');
  const url = `${BASE}/mmClients/data?key=${KEY}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
  const body = { fields: encFields({ staff, clients: newClients, ts: now }) };
  const p = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!p.ok) {
    const t = await p.text();
    console.error('PATCH FAIL:', p.status, t.slice(0, 500));
    process.exit(1);
  }
  const result = await p.json();
  console.log('✅ PATCH ok. Новый updateTime:', result.updateTime);
  console.log(`Создано карточек: ${newCards.length}. Жанель Баубекова (alt 176472553) должна быть в списке.`);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
