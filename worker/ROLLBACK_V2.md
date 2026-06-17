# ROLLBACK V2 — пошаговый план отката с V2 на V1

> Документ написан 17.06.2026 сразу после миграции `mmClients/data` → `mmClientsV2` + `mmStaffV2`.
> Worker `mm-altegio` уже переключён на V2 и задеплоен. Платформа (`clients_platform/index.html`) переключена локально, готовится залив в Plesk.
> Если что-то пойдёт не так — ниже три сценария отката в порядке нарастания паники.

---

## Когда применять rollback

Откатываемся **только** если наблюдаем один из этих симптомов:

1. **Мастера не видят свои карточки клиентов** — после логина пустой список или ошибка «не удалось загрузить».
2. **Permission denied / 403** в консоли браузера при чтении `mmClientsV2/*` или `mmStaffV2/*` — значит Firestore Rules не пускают (Rules не были раскатаны или сломаны).
3. **Worker mm-altegio перестал писать новые записи** — в Altegio создаётся запись, но в Firestore она не появляется (проверяется по `wrangler tail` или Cloudflare Dashboard → Logs).
4. **Потеря данных** — у клиента было 12 визитов, после миграции стало 3. Сравниваем со снапшотом `pre-sync-20260617-121349.json`.
5. **Дубликаты клиентов** — один и тот же телефон создал две карточки в `mmClientsV2` (значит логика merge-by-phone в worker'е сломалась).

### Когда НЕ применять rollback

- **Просто медленно** — не rollback, а оптимизация (добавить индексы Firestore, пагинацию, кэш).
- **У одного мастера баг** — это не катастрофа, чиним точечно, не трогаем всю систему.
- **Косметика UI** — переверстать кнопку проще, чем откатить базу.
- **Один webhook потерялся** — Altegio дозвонится, retry-логика отработает. Подождите 5-10 минут.

---

## Что лежит в «сейфе» (бэкапы и страховки)

| Что | Где | Зачем |
|-----|-----|-------|
| Полный снапшот Firestore до миграции | `C:/Users/Madiyar/Desktop/клод проекты/Атырау/.local_backups/pre-sync-20260617-121349.json` | Восстановление `mmClients/data` 1-в-1 как было |
| Снапшот после компактификации | `C:/Users/Madiyar/Desktop/клод проекты/Атырау/.local_backups/audit-snapshot-now.json` | Сравнение «до/после» по диффу |
| Старая версия Worker'а в git | `git -C "C:/Users/Madiyar/Desktop/клод проекты/Атырау" log --oneline \| grep -i altegio` | Откат деплоя через `wrangler rollback` или checkout файла |
| Старая версия index.html в git | `HEAD~1 clients_platform/index.html` | `git checkout HEAD~1 -- clients_platform/index.html` |
| **Старый `mmClients/data` в Firestore — НЕ удалялся** | Firestore document `mmClients/data` | Лежит как есть, ничего не делали с ним. V1-платформа всё ещё прочитает. |
| Предыдущая версия worker'а в Cloudflare | Dashboard → Workers → mm-altegio → Versions → `c40cb417` | One-click rollback через UI |

**Главная страховка:** старый документ `mmClients/data` НЕ был удалён в процессе миграции. Это значит, что V1-платформа (старая) полностью работоспособна, если её откатить.

---

## Сценарий А: rollback только платформы

**Когда:** данные в `mmClientsV2` целые, worker пишет нормально, но новая платформа глючит (верстка, JS-ошибки, неправильная фильтрация).

**Время выполнения:** 5-10 минут.

### Шаги

1. **Откатить index.html в git:**
   ```powershell
   git -C "C:/Users/Madiyar/Desktop/клод проекты/Атырау" checkout HEAD~1 -- clients_platform/index.html
   ```

2. **Залить старую версию в Plesk:**
   - Зайти в Plesk → Files → `clients.mmfabrica.com/httpdocs/`
   - Загрузить `clients_platform/index.html` (замена существующего)
   - Проверить, что версия в `<meta name="app-version">` поменялась (баннер version-check в браузере покажет обновление)

3. **Мастера перезагружают вкладку** через banner version-check (он покажется автоматически).

4. **Worker остаётся на V2** — он независим, продолжает писать в `mmClientsV2`.

5. **ВНИМАНИЕ — десинхронизация:**
   - V1-платформа читает из `mmClients/data` (старый снапшот).
   - Worker пишет в `mmClientsV2` (новая коллекция).
   - Новые визиты, которые приходят через Altegio, **НЕ будут видны** в откаченной платформе.
   - Решение: запустить **обратную синхронизацию `mmClientsV2` → `mmClients/data`**:
     ```powershell
     node worker/reverse_sync_v2_to_v1.js --dry-run
     # Проверить вывод
     node worker/reverse_sync_v2_to_v1.js --apply
     ```
   - Скрипт `reverse_sync_v2_to_v1.js` **нужно написать сейчас**, если ещё нет — берёт всё из `mmClientsV2`, склеивает обратно в формат `mmClients/data` (один документ, массив clients).
   - После этого либо запускать его cron'ом каждые 5 минут, либо параллельно откатить и worker (Сценарий Б).

### Verify после Сценария А

- Открыть `https://clients.mmfabrica.com` в incognito.
- Залогиниться мастером.
- Должны быть видны все клиенты как были до миграции.
- Создать тестовую запись в Altegio → подождать 30 сек → проверить, что появилась (если запущена обратная синхронизация).

---

## Сценарий Б: полный rollback Worker + Platform

**Когда:** данные ещё целые, но проблема системная — и в платформе глючит, и worker пишет криво. Возвращаемся к стабильной V1 целиком.

**Время выполнения:** 15-20 минут.

### Шаги

1. **Откат Worker'а через Cloudflare Dashboard:**
   - Открыть https://dash.cloudflare.com
   - Workers & Pages → `mm-altegio` → вкладка **Deployments** (или Versions)
   - Найти версию `c40cb417` (последняя V1-версия до миграции)
   - Нажать **Rollback to this version**
   - Подтвердить
   - В течение 30 сек новый трафик уйдёт на старую версию

   Альтернатива через CLI:
   ```powershell
   cd "C:/Users/Madiyar/Desktop/клод проекты/Атырау/worker"
   npx wrangler rollback --message "rollback V2 to V1 c40cb417"
   ```

2. **Откатить index.html в Plesk** (как в Сценарии А, шаги 1-3).

3. **Запустить обратную синхронизацию `mmClientsV2` → `mmClients/data`:**
   ```powershell
   node worker/reverse_sync_v2_to_v1.js --apply
   ```
   - Это перенесёт всё, что worker успел записать в V2 после миграции, обратно в старый формат.
   - Только разово — после этого worker уже снова пишет в V1.

4. **Verify по той же chek-логике** (см. ниже раздел «Verify»).

5. **(Опционально) удалить или заархивировать `mmClientsV2` и `mmStaffV2`:**
   - Не удалять сразу — оставить как бэкап на 1-2 недели.
   - Через 2 недели, если V1 стабильна, можно почистить:
     ```powershell
     node worker/cleanup_v2_collections.js --confirm
     ```

### Verify после Сценария Б

- `https://clients.mmfabrica.com` — мастера видят свои карточки.
- Создать запись в Altegio → проверить, что появилась в `mmClients/data` (не в `mmClientsV2`).
- `wrangler tail mm-altegio` — логи показывают запись в V1-путь.

---

## Сценарий В: восстановление из снапшота (полная катастрофа)

**Когда:** данные потеряны или повреждены (визиты пропали, дубликаты, что-то затёрло). Worker и платформа уже отказывают.

**Время выполнения:** 30-60 минут.

### Шаги

1. **Остановить worker** (чтобы не писал поверх восстанавливаемых данных):
   - Cloudflare Dashboard → `mm-altegio` → Settings → **Pause Worker**
   - Либо temporary route detach.
   - Altegio webhooks будут получать 503 — это ОК, они retry'ются.

2. **Подготовить снапшот:**
   ```powershell
   cd "C:/Users/Madiyar/Desktop/клод проекты/Атырау"
   ls .local_backups/pre-sync-20260617-121349.json
   # Размер должен быть ~5-20 MB
   ```

3. **Расшифровать Firestore REST формат и восстановить `mmClients/data`:**

   Снапшот — это JSON в формате Firestore REST (с типами вроде `stringValue`, `arrayValue`). Скрипт `restore_from_backup.js` должен:
   - Прочитать JSON.
   - Конвертировать Firestore REST → plain JSON.
   - PATCH-ить документ `mmClients/data` обратно как было.

   ```powershell
   node worker/restore_from_backup.js --backup=.local_backups/pre-sync-20260617-121349.json --dry-run
   # Проверить вывод
   node worker/restore_from_backup.js --backup=.local_backups/pre-sync-20260617-121349.json --apply
   ```

   Если `restore_from_backup.js` ещё не существует — написать его сейчас. Основа:
   ```javascript
   const fs = require('fs');
   const fetch = require('node-fetch');
   const backup = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
   const plain = firestoreRestToPlain(backup); // конвертер
   await patchFirestore('mmClients/data', plain);
   ```

4. **Откатить Worker на V1** (Сценарий Б, шаг 1).

5. **Откатить index.html на V1** (Сценарий А, шаги 1-2).

6. **Снять паузу с Worker'а:**
   - Cloudflare Dashboard → `mm-altegio` → Settings → **Resume Worker**

7. **Принудительно перезапустить retry в Altegio:**
   - Если есть очередь webhook'ов, которые получили 503 — Altegio сам ретрайнет.
   - На всякий случай — пройтись по визитам за последние сутки в Altegio UI и убедиться, что они есть в `mmClients/data`.

### Verify после Сценария В

- `mmClients/data` содержит данные из снапшота.
- Worker пишет новые записи в `mmClients/data`.
- Платформа показывает все карточки.
- Количество клиентов совпадает со снапшотом (`audit-snapshot-now.json` для сверки).

---

## Команды для откатов (сводный чек-лист)

```powershell
# 1. Просмотреть последние commits и найти точку отката
git -C "C:/Users/Madiyar/Desktop/клод проекты/Атырау" log --oneline -10

# 2. Откат index.html на предыдущий коммит
git -C "C:/Users/Madiyar/Desktop/клод проекты/Атырау" checkout HEAD~1 -- clients_platform/index.html

# 3. Просмотреть какие версии worker'а есть в Cloudflare
cd "C:/Users/Madiyar/Desktop/клод проекты/Атырау/worker"
npx wrangler deployments list

# 4. Откатить worker на конкретную версию
npx wrangler rollback --message "rollback V2 to V1"

# 5. Обратная синхронизация V2 → V1 (после отката платформы)
node worker/reverse_sync_v2_to_v1.js --dry-run
node worker/reverse_sync_v2_to_v1.js --apply

# 6. Восстановить mmClients/data из бэкапа
node worker/restore_from_backup.js --backup=.local_backups/pre-sync-20260617-121349.json --dry-run
node worker/restore_from_backup.js --backup=.local_backups/pre-sync-20260617-121349.json --apply

# 7. Проверка состояния Firestore после отката
node worker/audit_clients.js > audit-after-rollback.json
diff <(jq -S . .local_backups/audit-snapshot-now.json) <(jq -S . audit-after-rollback.json)
```

---

## Чек-лист «всё прошло»

После любого из сценариев пройтись по этому списку:

- [ ] `https://clients.mmfabrica.com` открывается в incognito без ошибок 5xx.
- [ ] Мастер логинится и видит свой список клиентов.
- [ ] Количество клиентов у мастера совпадает с тем, что было до миграции (сверить со снапшотом).
- [ ] Создание тестовой записи в Altegio → появляется в Firestore в течение 60 сек.
- [ ] `wrangler tail mm-altegio` — нет ошибок 500/permission denied.
- [ ] В консоли браузера на платформе нет ошибок 403/permission-denied.
- [ ] Фото до/после загружаются и отображаются.
- [ ] Поиск по телефону работает (находит существующего клиента).

---

## Что зафиксировать после rollback

В `MEMORY.md` или `project_clients_platform.md` обязательно записать:

1. **Дату и время** инцидента и отката.
2. **Какой сценарий** (А/Б/В) применили.
3. **Что было не так** — конкретный симптом, почему откатывались.
4. **Что переделать** перед следующей попыткой миграции — список фиксов.
5. **Кто видел/участвовал** (для пост-мортема).

---

## Контакты эскалации

| Куда | Как | Когда |
|------|-----|-------|
| **Firebase support** | https://console.firebase.google.com → Help → Support | Если Firestore недоступен / Rules не сохраняются / квоты |
| **Cloudflare support** | https://dash.cloudflare.com → Support | Если Workers падают / rollback через UI не работает |
| **Plesk хостинг** | Личный кабинет хостинг-провайдера | Если `clients.mmfabrica.com` отдаёт 5xx на уровне веб-сервера |
| **Altegio support** | https://yclients.com/contacts (бывшие YClients) | Если webhook'и не приходят в worker вообще |

---

## Превентивные действия (чтобы rollback не понадобился)

- Перед заливом index.html в Plesk — открыть локально, залогиниться, прокликать 3 ключевых сценария (логин, поиск по телефону, добавление визита).
- Worker деплоить с тегом версии, не перезатирать `latest` без тестов.
- Снапшоты `mmClientsV2` снимать каждые 6 часов первые 3 дня после миграции (cron: `node worker/audit_clients.js > .local_backups/v2-snapshot-$(date).json`).
- После 7 дней стабильной работы V2 — старый `mmClients/data` всё равно НЕ удалять ещё 30 дней.

---

**Документ актуален на 17.06.2026. Обновлять при каждом изменении в архитектуре V2.**
