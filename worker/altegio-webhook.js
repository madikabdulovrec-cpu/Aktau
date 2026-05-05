/**
 * M&M Altegio Webhook Receiver — Cloudflare Worker
 *
 * Принимает webhook от Altegio о событиях клиента и:
 *   1. Создаёт/обновляет карточку в нашей платформе (Firestore — TODO)
 *   2. Пишет ссылку обратно в кастомное поле клиента в Altegio
 *
 * Env vars (Settings → Variables and Secrets в Cloudflare Dashboard):
 *   ALTEGIO_PARTNER_TOKEN — bearer токен партнёра
 *   ALTEGIO_USER_TOKEN    — user-токен системного пользователя приложения
 *   ALTEGIO_COMPANY_ID    — ID филиала (1330174)
 *   PLATFORM_BASE_URL     — базовый URL платформы (clients.mmfabrica.com)
 *   FIREBASE_PROJECT_ID   — TODO когда подключим Firebase
 *   FIREBASE_API_KEY      — TODO когда подключим Firebase
 */

const ALTEGIO_API = 'https://api.alteg.io/api/v1';
const CUSTOM_FIELD_NAME = 'mm_card_url';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Healthcheck для Altegio при первичной настройке webhook
    if (request.method === 'GET') {
      return jsonResponse({
        status: 'ok',
        service: 'mm-altegio-webhook',
        time: new Date().toISOString(),
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
    }

    console.log('[altegio webhook]', JSON.stringify(payload));

    // Формат webhook от Altegio:
    // { company_id, resource: 'client', resource_id, status: 'create'|'update'|'delete', data: {...} }
    const { resource, status, resource_id, data, company_id } = payload;

    // Реагируем только на события клиентов
    if (resource !== 'client') {
      return jsonResponse({ ok: true, skipped: 'not_a_client_event', resource });
    }

    // На всякий случай проверим company_id — наш ли филиал
    if (String(company_id) !== String(env.ALTEGIO_COMPANY_ID)) {
      return jsonResponse({ ok: true, skipped: 'wrong_company', got: company_id });
    }

    try {
      if (status === 'delete') {
        // TODO: пометить карточку как удалённую в Firestore
        return jsonResponse({ ok: true, action: 'delete_logged', resource_id });
      }

      // create / update — нужно создать или обновить нашу карточку
      const ourCardId = await upsertCardInFirestore({ env, altegioClient: data || { id: resource_id } });

      // Записать ссылку обратно в кастомное поле клиента в Altegio
      const cardUrl = `${env.PLATFORM_BASE_URL.replace(/\/$/, '')}/?id=${ourCardId}`;
      await writeCustomFieldToAltegioClient({ env, clientId: resource_id, cardUrl });

      return jsonResponse({ ok: true, action: status, ourCardId, cardUrl });
    } catch (e) {
      console.error('[altegio webhook] error', e);
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  },
};

/* ============================================================
 * Firestore upsert (TODO: реализовать когда будет Firebase)
 * ============================================================ */
async function upsertCardInFirestore({ env, altegioClient }) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) {
    // Заглушка пока Firebase не подключен
    console.log('[firestore] STUB: would upsert', altegioClient);
    return 'stub_' + (altegioClient.id || 'unknown');
  }
  // TODO: реальный Firestore REST upsert
  // POST/PATCH https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents/mmClients/data
  return 'stub_' + altegioClient.id;
}

/* ============================================================
 * Запись ссылки в кастомное поле клиента в Altegio
 * ============================================================ */
async function writeCustomFieldToAltegioClient({ env, clientId, cardUrl }) {
  const url = `${ALTEGIO_API}/client/${env.ALTEGIO_COMPANY_ID}/${clientId}`;
  const body = {
    custom_fields: { [CUSTOM_FIELD_NAME]: cardUrl },
  };
  const resp = await fetch(url, {
    method: 'PUT',
    headers: altegioHeaders(env),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`altegio PUT failed: ${resp.status} ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

function altegioHeaders(env) {
  return {
    'Authorization': `Bearer ${env.ALTEGIO_PARTNER_TOKEN}, User ${env.ALTEGIO_USER_TOKEN}`,
    'Accept': 'application/vnd.api.v2+json',
    'Content-Type': 'application/json',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
