/**
 * M&M Backup Worker — ежедневный snapshot Firestore в R2 bucket.
 *
 * Сценарий: раз в сутки cron triggers fetch → GET документа mmClients/data →
 * PUT в R2 с ключом backups/YYYY-MM-DD.json. Дополнительно cleanup'ит файлы
 * старше RETENTION_DAYS, чтобы bucket не разрастался.
 *
 * Восстановление: открыть R2 dashboard → скачать нужный YYYY-MM-DD.json →
 * PATCH через Firestore REST на mmClients/data (или ручной импорт).
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
const FIRESTORE_DOC_PATH = 'mmClients/data';

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
  // 1. GET документ из Firestore (полный raw JSON — сохраняем как есть)
  const fsUrl = `${FIRESTORE_API}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIRESTORE_DOC_PATH}?key=${env.FIREBASE_API_KEY}`;
  const resp = await fetch(fsUrl);
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`firestore GET failed: ${resp.status} ${txt.slice(0, 200)}`);
  }
  const raw = await resp.text();
  const size = raw.length;

  // 2. Парсим для метаданных (для логов и healthcheck)
  let clientCount = 0;
  let staffCount = 0;
  try {
    const doc = JSON.parse(raw);
    clientCount = doc?.fields?.clients?.arrayValue?.values?.length || 0;
    staffCount  = doc?.fields?.staff?.arrayValue?.values?.length   || 0;
  } catch (e) { /* не критично */ }

  // 3. PUT в R2 — ключ по дате (YYYY-MM-DD). Если за день уже есть — перезапишем
  //    свежим (так мы сохраним последний snapshot каждого дня).
  const dateKey = new Date().toISOString().slice(0, 10); // 2026-05-19
  const r2Key = `backups/${dateKey}.json`;
  await env.BACKUPS.put(r2Key, raw, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
    },
    customMetadata: {
      clients: String(clientCount),
      staff: String(staffCount),
      backed_up_at: new Date().toISOString(),
      source: 'mm-backup-worker',
    },
  });

  // 4. Cleanup — удаляем файлы старше RETENTION_DAYS
  const retention = parseRetention(env);
  const cleanup = await cleanupOldBackups(env, retention);

  return {
    key: r2Key,
    size_bytes: size,
    clients: clientCount,
    staff: staffCount,
    retention_days: retention,
    cleaned: cleanup,
  };
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
