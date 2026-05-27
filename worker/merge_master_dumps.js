// Merge анкет из localStorage-дампов мастеров в Firestore.
//
// Использование:
//   1. Положить JSON-файлы (присланные мастерами) в .local_backups/master_dumps/.
//      Формат файла: { device, user:{name,staffId,...}, clients:[...] }.
//      Один файл = один мастер. Можно нескольких мастеров — каждый в свой файл.
//   2. Запустить: node worker/merge_master_dumps.js
//   3. Скрипт читает все файлы, по каждой карточке выбирает САМУЮ СВЕЖУЮ по
//      updatedAt версию (с не пустыми полями мастера), сливает с текущим
//      Firestore (не затирая поля от Altegio: fio/phone/altegioId).
//   4. После merge — PATCH с precondition (optimistic-locking).
//
// Безопасно: только мерджит, ничего не удаляет. Если в текущей карточке
// уже есть данные мастера — копируется только если из дампа НОВЕЕ.

const fs = require('fs');
const path = require('path');

const PROJ='mmclients-eea40', KEY='AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro';
const BASE=`https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const DUMPS_DIR='C:/Users/Madiyar/Desktop/клод проекты/Атырау/.local_backups/master_dumps';

function encVal(v){if(v===null||v===undefined)return{nullValue:null};if(typeof v==='boolean')return{booleanValue:v};if(typeof v==='number')return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};if(typeof v==='string')return{stringValue:v};if(Array.isArray(v))return{arrayValue:{values:v.map(encVal)}};if(typeof v==='object')return{mapValue:{fields:encFields(v)}};return{stringValue:String(v)};}
function encFields(o){const r={};for(const k of Object.keys(o))r[k]=encVal(o[k]);return r;}
function decVal(v){if(!v||typeof v!=='object')return v;if('nullValue'in v)return null;if('booleanValue'in v)return v.booleanValue;if('integerValue'in v)return parseInt(v.integerValue,10);if('doubleValue'in v)return v.doubleValue;if('stringValue'in v)return v.stringValue;if('timestampValue'in v)return v.timestampValue;if('arrayValue'in v)return(v.arrayValue.values||[]).map(decVal);if('mapValue'in v)return decFields(v.mapValue.fields||{});return null;}
function decFields(f){const r={};for(const k of Object.keys(f))r[k]=decVal(f[k]);return r;}

function nonEmpty(v){
  if(v===null||v===undefined) return false;
  if(typeof v==='string') return v.trim().length>0;
  if(Array.isArray(v)) return v.length>0;
  if(typeof v==='object') return Object.keys(v).length>0;
  return false;
}
function hasMasterData(c){
  return nonEmpty(c.anamnesis) || nonEmpty(c.complaints) || nonEmpty(c.recommendations)
    || nonEmpty(c.anamnesisOther) || nonEmpty(c.initialPhotos) || nonEmpty(c.sessions)
    || nonEmpty(c.measurements) || nonEmpty(c.age) || nonEmpty(c.weight)
    || nonEmpty(c.height) || nonEmpty(c.source);
}
function scoreOf(c){
  return (c.anamnesis||[]).length + (c.sessions||[]).length + (c.measurements||[]).length
    + (c.initialPhotos||[]).length + ((c.complaints||'').length>0?1:0)
    + ((c.recommendations||'').length>0?1:0) + ((c.anamnesisOther||'').length>0?1:0);
}

(async()=>{
  if(!fs.existsSync(DUMPS_DIR)){
    console.error('Папка не найдена:', DUMPS_DIR);
    process.exit(1);
  }
  const files=fs.readdirSync(DUMPS_DIR).filter(f=>f.endsWith('.json')).sort();
  if(files.length===0){
    console.log('Нет дампов в '+DUMPS_DIR+'. Положите JSON-файлы от мастеров и запустите снова.');
    return;
  }
  console.log('Найдено дампов:', files.length);

  // Собираем по ключу (altegioId || id) самую свежую/полную версию карточки
  const bestByKey = new Map();
  for(const f of files){
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(DUMPS_DIR,f),'utf8')); }
    catch(e){ console.error('  ❌ '+f+' — invalid JSON:', e.message); continue; }
    const dump = Array.isArray(raw) ? { clients: raw } : raw;
    const arr = Array.isArray(dump.clients) ? dump.clients : [];
    const masterName = dump.user?.name || dump.device || f;
    let candidates = 0;
    for(const c of arr){
      if(!hasMasterData(c)) continue;
      const k = String(c.altegioId||'') || c.id || '';
      if(!k) continue;
      candidates++;
      const ex = bestByKey.get(k);
      const ts = Number(c.updatedAt)||0;
      // приоритет: новее updatedAt, при равенстве — больше полей заполнено
      if(!ex || ts > (ex._ts||0) || (ts === (ex._ts||0) && scoreOf(c) > scoreOf(ex))){
        bestByKey.set(k, Object.assign({}, c, { _ts:ts, _from: masterName }));
      }
    }
    console.log('  ✓ '+f+' ('+masterName+'): '+candidates+' карточек с анкетами');
  }
  console.log('Уникальных карточек с данными мастера:', bestByKey.size);
  if(bestByKey.size===0){ console.log('Нечего восстанавливать.'); return; }

  // GET Firestore
  const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
  const doc = await r.json();
  const d = decFields(doc.fields||{});
  const clients = Array.isArray(d.clients)?d.clients:[];
  const staff = Array.isArray(d.staff)?d.staff:[];
  console.log('Firestore сейчас:', clients.length, 'клиентов');

  // Merge
  const mergeLog = [];
  let mergedCount = 0;
  for(const cur of clients){
    const k = String(cur.altegioId||'') || cur.id || '';
    if(!k) continue;
    const fromDump = bestByKey.get(k);
    if(!fromDump) continue;

    // Применяем только если в текущей карточке поле пустое ИЛИ из дампа новее
    const dumpTs = Number(fromDump.updatedAt)||0;
    const curTs = Number(cur.updatedAt)||0;
    const dumpIsNewer = dumpTs > curTs;

    let touched = false;
    const fields = ['anamnesis','anamnesisOther','complaints','recommendations',
      'initialPhotos','sessions','measurements','source','age','weight','height',
      'date','specialist','specialistId','altegioLink'];
    for(const f of fields){
      const cv = cur[f];
      const dv = fromDump[f];
      if(!nonEmpty(dv)) continue;
      if(!nonEmpty(cv) || dumpIsNewer){
        cur[f] = dv;
        touched = true;
      }
    }
    if(touched){
      cur.updatedAt = Math.max(curTs, dumpTs) || Date.now();
      if(Number(fromDump.createdAt)) cur.createdAt = Math.min(Number(cur.createdAt)||Date.now(), Number(fromDump.createdAt));
      mergedCount++;
      mergeLog.push({fio:cur.fio, altId:cur.altegioId, from:fromDump._from,
        anamnesis:(cur.anamnesis||[]).length, sessions:(cur.sessions||[]).length,
        photos:(cur.initialPhotos||[]).length, measure:(cur.measurements||[]).length});
    }
  }
  console.log('\nКарточек смерджено:', mergedCount);
  for(const e of mergeLog){
    console.log(`  ✓ ${e.fio} (alt=${e.altId}) ← ${e.from}   anamn:${e.anamnesis} sess:${e.sessions} photos:${e.photos} measure:${e.measure}`);
  }
  if(mergedCount===0){ console.log('Ничего не подошло — все карточки в Firestore уже актуальны.'); return; }

  // PATCH с precondition
  const url=`${BASE}/mmClients/data?key=${KEY}&currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`;
  const p=await fetch(url,{
    method:'PATCH', headers:{'content-type':'application/json'},
    body:JSON.stringify({fields:encFields({staff,clients,ts:Date.now()})}),
  });
  if(!p.ok){
    console.error('❌ PATCH fail:', p.status, (await p.text()).slice(0,300));
    process.exit(1);
  }
  console.log('\n✅ PATCH ok. Анкеты восстановлены для', mergedCount, 'карточек.');
})();
