# Миграция: single-document → коллекции (V2 архитектура)

> **TL;DR:** этот файл — пошаговый план будущей миграции платформы M&M Карточки
> клиентов с одного Firestore-документа `mmClients/data` на коллекции
> `mmClientsV2/{id}` и `mmStaffV2/{id}`. Сама миграция НЕ выполнена — это
> рискованная операция, требующая отдельной сессии с тестированием. План +
> скрипт + Rules — готовы.

## Зачем нужна миграция

**Текущая архитектура:**
- Один документ `mmClients/data` хранит ВСЕХ клиентов (массив `clients[]`) и
  ВСЕХ мастеров (`staff[]`).
- Размер: ~300 КБ из лимита 1 МБ. Запас 3.3x.
- При каждом изменении ЛЮБОЙ карточки — пишем ВЕСЬ массив. Race условия
  лечатся через `runTransaction` + merge-by-id (см. `cloudPush` в index.html).

**Проблемы:**
1. **Лимит 1 МБ** — при росте до 800+ клиентов начнём упираться.
2. **Contention** — параллельные пуши блокируют друг друга, что усиливает
   риск race-условий (хотя merge-on-write это в основном лечит).
3. **Worker сложнее** — `altegio-webhook.js` каждый раз делает GET всего
   документа, мерджит, PATCH с precondition (см. `withFirestoreRetry`).

**После миграции:**
- Каждая карточка — свой документ `mmClientsV2/{id}` до 1 МБ.
- Параллельные write'ы НЕ конфликтуют (Firestore сам управляет lock'ами на
  уровне документа).
- Платформа подписывается на коллекцию, получает только реальные изменения.
- Worker делает простой `PATCH /mmClientsV2/{id}` без retry-цикла.

## Почему миграция НЕ сделана сейчас

1. **Уже принятые фиксы (P0/P1/P2/P3/P4) устраняют корневую причину потери
   данных:** optimistic concurrency + merge-on-write + auto-save + drafts +
   ежедневный R2 backup.
2. **Размер документа 300 КБ — запас 3x.** До критической точки полгода+.
3. **Миграция требует переписать ~30% кода index.html и весь Worker.**
   Это новые баги, новые регрессии. Делать только если P0-P4 не решат
   проблему за 2-3 недели наблюдения.

## Подготовленные материалы

| Файл | Назначение | Статус |
|------|------------|--------|
| `worker/migrate_to_collection.js` | Перенос данных из `mmClients/data` в `mmClientsV2`+`mmStaffV2` | ✅ готов, поддерживает DRY_RUN |
| `firestore.rules.v2` | Правила доступа для новых коллекций | ✅ готов |
| Этот файл | Пошаговый план переключения с diff-ями | ✅ готов |

## Пошаговый план миграции (когда решите делать)

### Шаг 1. Подготовка (15 минут)

1. **Backup сделать прямо сейчас** (даже если R2 backup уже работает —
   снять manual snapshot для уверенности):
   ```bash
   mkdir -p .local_backups
   curl -s "https://firestore.googleapis.com/v1/projects/mmclients-eea40/databases/(default)/documents/mmClients/data?key=AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro" \
     -o ".local_backups/pre-migration-$(date +%Y%m%d_%H%M%S).json"
   ```

2. **Залить Firestore Rules v2** (см. `firestore.rules.v2`):
   - Firebase Console → Build → Firestore → Rules → вставить → Publish.
   - **Не удаляй** правила для `mmClients/{docId}` — они нужны для отката.

3. **Предупредить мастеров:** «5 минут не работать в платформе».

### Шаг 2. Dry-run миграции (1 минута)

```bash
DRY_RUN=1 node worker/migrate_to_collection.js
```

Должен вывести что-то вроде:
```
MODE: DRY-RUN
[1/4] Чтение mmClients/data... ✓ Прочитано: 255 клиентов, 3 мастеров
[2/4] Проверка целевых коллекций... ✓ Пусты — можно мигрировать чисто
[3/4] DRY ... (3 staff)
[4/4] DRY ... (255 clients)
DONE: staff: 3 migrated, clients: 255 migrated
```

Если есть ошибки — НЕ продолжать, разбираться.

### Шаг 3. Реальная миграция (30 секунд)

```bash
node worker/migrate_to_collection.js
```

Проверить в Firebase Console:
- `mmClientsV2` — 255 документов.
- `mmStaffV2` — 3 документа.
- `mmClients/data` — НЕ удалён, остался как страховка.

### Шаг 4. Переключение платформы на V2 (1-2 часа разработки)

В `clients_platform/index.html` сделать следующие изменения (примеры diff-ей):

#### 4.1. `cloudLoad()` — читать коллекции вместо документа

```diff
- db.collection('mmClients').doc('data').get().then(snap => {
-   ...
-   const data = snap.data();
-   STATE.staff = mergeArraysById(STATE.staff, data.staff || []);
-   STATE.clients = mergeArraysById(STATE.clients, data.clients || []);
+ Promise.all([
+   db.collection('mmStaffV2').get(),
+   db.collection('mmClientsV2').get(),
+ ]).then(([staffSnap, clientsSnap]) => {
+   const remoteStaff = staffSnap.docs.map(d => d.data());
+   const remoteClients = clientsSnap.docs.map(d => d.data());
+   STATE.staff = mergeArraysById(STATE.staff, remoteStaff);
+   STATE.clients = mergeArraysById(STATE.clients, remoteClients);
```

#### 4.2. `cloudSubscribe()` — подписка на коллекцию

```diff
- cloudUnsubscribe = db.collection('mmClients').doc('data').onSnapshot(snap => {
-   if(snap.metadata.hasPendingWrites) return;
-   const data = snap.data();
-   STATE.staff = mergeArraysById(STATE.staff, data.staff);
-   STATE.clients = mergeArraysById(STATE.clients, data.clients);
- });
+ const unsubClients = db.collection('mmClientsV2').onSnapshot(qs => {
+   qs.docChanges().forEach(change => {
+     if(change.doc.metadata.hasPendingWrites) return;
+     const c = change.doc.data();
+     const i = STATE.clients.findIndex(x => x.id === c.id);
+     if(change.type === 'removed') {
+       if(i >= 0) STATE.clients.splice(i, 1);
+     } else {
+       if(i >= 0) STATE.clients[i] = mergeArraysById([c], [STATE.clients[i]])[0];
+       else STATE.clients.unshift(c);
+     }
+   });
+   saveLocalOnly();
+   if(currentScreen === 'dashScreen') renderClientList();
+ });
+ const unsubStaff = db.collection('mmStaffV2').onSnapshot(qs => { /* аналогично */ });
+ cloudUnsubscribe = () => { unsubClients(); unsubStaff(); };
```

#### 4.3. `cloudPush()` — писать только изменённое

```diff
- async function cloudPush() {
-   ...
-   await db.runTransaction(async tx => {
-     const remote = (await tx.get(ref)).data() || {};
-     const mergedClients = mergeArraysById(STATE.clients, remote.clients || []);
-     tx.set(ref, { staff, clients: mergedClients, ts: Date.now() });
-   });
+ // Глобальный set для tracking «что менялось»
+ const cloudDirtyClients = new Set();
+ const cloudDirtyStaff = new Set();
+
+ // saveClient/deleteClient/saveSession/saveMeasurement: вместо saveState() →
+ //   STATE.clients[i] = ...; cloudDirtyClients.add(id); cloudPush();
+
+ async function cloudPush() {
+   if(!db || !cloudInitialLoadDone) return;
+   const batch = db.batch();
+   for(const id of cloudDirtyClients) {
+     const c = STATE.clients.find(x => x.id === id);
+     if(c) batch.set(db.collection('mmClientsV2').doc(id), c);
+     else batch.delete(db.collection('mmClientsV2').doc(id));
+   }
+   for(const id of cloudDirtyStaff) {
+     const s = STATE.staff.find(x => x.id === id);
+     if(s) batch.set(db.collection('mmStaffV2').doc(id), s);
+     else batch.delete(db.collection('mmStaffV2').doc(id));
+   }
+   await batch.commit();
+   cloudDirtyClients.clear();
+   cloudDirtyStaff.clear();
+ }
```

> ⚠️ **Нужно пройтись по ВСЕМ местам, где меняется STATE.clients или STATE.staff,
> и добавить `cloudDirtyClients.add(c.id)` или `cloudDirtyStaff.add(s.id)`.**
> Это: `saveClient`, `deleteClient`, `saveSession`, `deleteSession`,
> `saveMeasurement`, `deleteMeasurement`, `saveMaster`, `toggleMaster`,
> `deleteMaster`, плюс `cloudSubscribe` merge (для синхронизации с
> Worker'ом).

### Шаг 5. Переключение Worker'а на V2 (1 час)

В `worker/altegio-webhook.js` основные функции:

#### `fetchFirestoreDoc` → `findClientByAltegioId`

```diff
- async function fetchFirestoreDoc(env) {
-   const r = await fetch(`${BASE}/mmClients/data?key=${KEY}`);
-   const j = await r.json();
-   return { ...decFields(j.fields), _updateTime: j.updateTime };
- }
+ async function findClientByAltegioId(env, altegioId) {
+   // Используем runQuery для поиска по полю altegioId
+   const body = {
+     structuredQuery: {
+       from: [{ collectionId: 'mmClientsV2' }],
+       where: { fieldFilter: { field: { fieldPath: 'altegioId' }, op: 'EQUAL', value: { stringValue: String(altegioId) } } },
+       limit: 1,
+     },
+   };
+   const r = await fetch(`${BASE}:runQuery?key=${KEY}`, {
+     method: 'POST', headers: { 'content-type': 'application/json' },
+     body: JSON.stringify(body),
+   });
+   const arr = await r.json();
+   const hit = arr.find(x => x.document);
+   if(!hit) return null;
+   return { ...decFields(hit.document.fields), _docName: hit.document.name, _updateTime: hit.document.updateTime };
+ }
```

#### `patchFirestoreDoc` → `setFirestoreClient`

```diff
- async function patchFirestoreDoc(env, fields, updateTime) {
-   const url = `${BASE}/mmClients/data?key=${KEY}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
-   return fetch(url, { method: 'PATCH', ... body: JSON.stringify({ fields: encFields({ staff, clients, ts: Date.now() }) }) });
- }
+ async function setFirestoreClient(env, client) {
+   // PATCH с precondition (optimistic locking) для конкретной карточки.
+   const id = client.id;
+   const url = `${BASE}/mmClientsV2/${encodeURIComponent(id)}?key=${KEY}`;
+   const headers = { 'content-type': 'application/json' };
+   // Если у нас есть _updateTime — добавляем precondition. Если нет
+   // (новая карточка) — пишем без precondition.
+   const precond = client._updateTime ? `&currentDocument.updateTime=${encodeURIComponent(client._updateTime)}` : '';
+   const r = await fetch(url + precond, { method: 'PATCH', headers, body: JSON.stringify({ fields: encFields(client) }) });
+   if (!r.ok) {
+     if (r.status === 412) throw new Error('PRECONDITION_FAILED');
+     throw new Error(`patch failed: ${r.status} ${await r.text()}`);
+   }
+   return r.json();
+ }
```

`withFirestoreRetry` остаётся как страховка от рассинхронизации `_updateTime`.

### Шаг 6. Деплой и тестирование (30 минут)

1. Залить новый `index.html` в Plesk.
2. Задеплоить новый Worker.
3. Открыть платформу:
   - Список карточек загружается? ✓
   - Открыть карточку, нажать «Редактировать», что-то изменить, «Сохранить» — обновилось? ✓
   - Создать новую карточку — появилась? ✓
   - Создать клиента в Altegio — карточка появилась на платформе? ✓
   - Mass-test: открыть в двух браузерах одновременно, отредактировать одну карточку в обоих — нет ли race condition? ✓
4. Мониторить Firestore Console на errors в течение 30 минут.

### Шаг 7. Очистка (через 1-2 недели)

После того как V2 поработал стабильно неделю:

```bash
# Удалить старый документ
curl -X DELETE "https://firestore.googleapis.com/v1/projects/mmclients-eea40/databases/(default)/documents/mmClients/data?key=AIzaSyBq5a1ACYjwzSW6XYbH8SOCoC5KTMSUoro"
```

И из `firestore.rules.v2` убрать секцию `match /mmClients/{docId}`.

## Откат (если что-то пошло не так)

Если V2 платформа поломалась:
1. Залить ОБРАТНО в Plesk предыдущий `index.html` (из git: `git checkout HEAD~1 clients_platform/index.html`).
2. Откатить Worker (Cloudflare → Deployments → Rollback на предыдущий).
3. Старый документ `mmClients/data` НЕ был тронут — данные на месте.
4. Карточки, изменённые в V2 после миграции, останутся в `mmClientsV2/*` —
   потребуется обратный sync (можно написать ещё один скрипт).

## Когда делать миграцию

**Не делать**, если за следующие 2-3 недели:
- Документ `mmClients/data` < 700 КБ.
- Нет жалоб мастеров на потерю данных.
- R2 backup работает.

**Делать**, если:
- Документ растёт быстрее ожидаемого (> 700 КБ).
- Появляются новые race-condition даже с merge-on-write.
- Планируется добавить больше мастеров (5+) — contention пойдёт вверх.
