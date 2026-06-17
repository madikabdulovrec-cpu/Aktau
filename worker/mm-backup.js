/**
 * M&M Backup Worker V2 — ежедневный snapshot Firestore в R2 bucket.
 *
 * V2 архитектура: бэкапим ДВЕ коллекции через listDocuments REST endpoint:
 *   mmClientsV2/{id}  — карточки клиентов
 *   mmStaffV2/{id}    — мастера (вместе с SHA-256 passHash для логина)
 *
 * Также бэкапим старый mmClients/data — он остался как frozen snapshot на
 * случай отката, и пока не удалён, обновляется лишь в фолбэке.
 *
 * Сценарий: раз в сутки cron triggers fetch → listDocuments по mmClientsV2
 * (с pagination, pageSize=300) → склейка в один JSON → PUT в R2 с ключом
 * backups/YYYY-MM-DD.json. Дополнительно cleanup'ит файлы старше
 * RETENTION_DAYS, чтобы bucket не разрастался.
 *
 * Восстановление: открыть R2 dashboard → скачать нужный YYYY-MM-DD.json →
 * восстановить через worker/restore_from_backup.js (есть локально).
 *
 * Endpoints:
 *   GET /         — healthcheck + список последних снапшотов
 *   GET /backup   — ручной запуск бэкапа (?secret=<BACKUP_SECRET>)
 *   GET /list     — список всех файлов в bucket с size+date
 *   scheduled()   — автоматический cron в 03:00 UTC
 *
 * Bindings (Settings → Variables and Secrets → Bindings → R2 buckets):
 *   BACKUPS         — R2 bucket "mm-clients-backups" (создать в Cloudflare UI)
 *
 * Env vars:
 *   FIREBASE_PROJECT_ID   — mmclients-eea40           (Plaintext)
 *   FIREBASE_API_KEY      — public Web API key        (Secret)
 *   BACKUP_SECRET         — для ручного запуска       (Secret)
 *   RETENTION_DAYS        — сколько дней хранить, def 30 (Plaintext, опционально)
 *
 * Cron trigger (Settings → Trigger Events → Cron):
 *   0 3 * * *    — каждый день в 03:00 UTC (06:00 GMT+5)
 */

const FIRESTORE_API = 'https://firestore.googleapis.com/v1';
const COLLECTION_CLIENTS = 'mmClientsV2';
const COLLECTION_STAFF = 'mmStaffV2';
const LEGACY_DOC_PATH = 'mmClients/data'; // оставлен для совместимости

const REQUIRED_ENV = ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'BACKUP_SECRET'];

export default {
  async fetch(request, env, ctx) {
    const missing = REQUIRED_ENV.filter(k => !env[k]);
    if (missing.length) {
      console.error('[config] missing env vars:', missing.join(','));
      return json({ ok: false, error: 'misconfigured', missing }, 500);
    }
    if (!env.BACKUPS) {
      console.error('[config] R2 binding BACKUPS not configured');
      return json({ ok: false, error: 'r2_not_bound' }, 500);
    }

    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      // Healthcheck + последние 5 снапшотов
      const list = await listBackups(env, 5);
      return json({
        status: 'ok',
        service: 'mm-backup',
        firestore: env.FIREBASE_PROJECT_ID,
        retention_days: parseRetention(env),
        last_backups: list.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === '/list' && request.method === 'GET') {
      // Полный список, защищён secret'ом — может содержать намёки на структуру
      if (url.searchParams.get('secret') !== env.BACKUP_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const list = await listBackups(env, 1000);
      return json({ ok: true, count: list.objects.length, files: list.objects.map(o => ({
        key: o.key, size: o.size, uploaded: o.uploaded,
      })) });
    }

    if (url.pathname === '/backup' && request.method === 'GET') {
      // Ручной запуск бэкапа
      if (url.searchParams.get('secret') !== env.BACKUP_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      try {
        const result = await doBackup(env);
        return json({ ok: true, manual: true, ...result });
      } catch (e) {
        console.error('[manual backup] error:', e?.message || String(e));
        return json({ ok: false, error: 'backup_failed' }, 500);
      }
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },

  // Cron handler — Cloudflare сам триггерит по расписанию (см. wrangler.toml / UI)
  async scheduled(event, env, ctx) {
    const missing = REQUIRED_ENV.filter(k => !env[k]);
    if (missing.length || !env.BACKUPS) {
      console.error('[scheduled] misconfigured, missing:', missing.join(','), 'r2:', !!env.BACKUPS);
      return;
    }
    try {
      const result = await doBackup(env);
      console.log('[scheduled] backup ok:', result);
    } catch (e) {
      console.error('[scheduled] backup failed:', e?.message || String(e));
    }
  },
};

/* ============================================================
 * BACKUP LOGIC
 * ============================================================ */

async function doBackup(env) {
  // V2: листаем ОБЕ коллекции через listDocuments REST (pagination, pageSize=300).
  // Каждый документ — отдельная запись. Собираем в один JSON-блоб:
  //   { clientsV2: [{id, name, fields}, ...], staffV2: [...], legacy: {...}, meta }
  // Это и есть наш дневной снапшот, его кладём в R2.
  const clientsV2 = await listAllDocuments(env, COLLECTION_CLIENTS);
  const staffV2 = await listAllDocuments(env, COLLECTION_STAFF);

  // Также берём старый mmClients/data — он остался как frozen snapshot после
  // миграции, в нём могут быть исторические данные что не дошли до V2. Не
  // критично если он 404, тогда просто опускаем.
  let legacy = null;
  try {
    const legacyResp = await fetch(`${FIRESTORE_API}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${LEGACY_DOC_PATH}?key=${env.FIREBASE_API_KEY}`);
    if (legacyResp.ok) {
      legacy = await legacyResp.json();
    }
  } catch (e) { /* legacy опционален */ }

  const snapshot = {
    schemaVersion: 2,
    backed_up_at: new Date().toISOString(),
    project: env.FIREBASE_PROJECT_ID,
    clientsV2,
    staffV2,
    legacy, // null если уже удалён или 404
    counts: {
      clients: clientsV2.length,
      staff: staffV2.length,
    },
  };

  const raw = JSON.stringify(snapshot);
  const size = raw.length;

  // PUT в R2 — ключ по дате (YYYY-MM-DD). Если за день уже есть — перезапишем
  // свежим (последний snapshot каждого дня).
  const dateKey = new Date().toISOString().slice(0, 10);
  const r2Key = `backups/${dateKey}.json`;
  await env.BACKUPS.put(r2Key, raw, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      schema_version: '2',
      clients: String(clientsV2.length),
      staff: String(staffV2.length),
      legacy_present: legacy ? '1' : '0',
      backed_up_at: snapshot.backed_up_at,
      source: 'mm-backup-worker-v2',
    },
  });

  // Cleanup — удаляем файлы старше RETENTION_DAYS
  const retention = parseRetention(env);
  const cleanup = await cleanupOldBackups(env, retention);

  return {
    key: r2Key,
    size_bytes: size,
    clients: clientsV2.length,
    staff: staffV2.length,
    legacy_present: !!legacy,
    retention_days: retention,
    cleaned: cleanup,
  };
}

// Постранично выкачиваем все документы из коллекции через listDocuments REST.
// Возвращаем массив объектов вида { name, fields, createTime, updateTime } —
// это формат Firestore REST, как его сохраняет Firebase. Восстановление через
// restore_from_backup.js знает как декодировать.
async function listAllDocuments(env, collectionId) {
  const all = [];
  let pageToken = null;
  let page = 0;
  while (true) {
    page++;
    if (page > 50) break; // safety cap: 50 страниц × 300 = 15000 документов
    const params = new URLSearchParams({
      key: env.FIREBASE_API_KEY,
      pageSize: '300',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${FIRESTORE_API}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collectionId}?${params}`;
    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`listDocuments ${collectionId} failed: ${r.status} ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    if (Array.isArray(j.documents)) all.push(...j.documents);
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return all;
}

async function listBackups(env, limit) {
  return await env.BACKUPS.list({ prefix: 'backups/', limit });
}

async function cleanupOldBackups(env, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const list = await env.BACKUPS.list({ prefix: 'backups/', limit: 1000 });
  const toDelete = [];
  for (const obj of list.objects) {
    // ключ: backups/YYYY-MM-DD.json — парсим дату
    const m = obj.key.match(/backups\/(\d{4}-\d{2}-\d{2})\.json/);
    if (!m) continue;
    const objDate = Date.parse(m[1] + 'T00:00:00Z');
    if (objDate < cutoff) toDelete.push(obj.key);
  }
  if (toDelete.length) {
    await env.BACKUPS.delete(toDelete);
  }
  return { deleted: toDelete.length, keys: toDelete };
}

function parseRetention(env) {
  const n = parseInt(env.RETENTION_DAYS || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
