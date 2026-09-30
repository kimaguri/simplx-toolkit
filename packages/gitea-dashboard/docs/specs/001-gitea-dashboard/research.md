# Research: Gitea Dashboard

Источники: исходники Gitea **v1.27.3** (`github.com/go-gitea/gitea/blob/v1.27.3/...`), swagger нашего инстанса, документация Chrome и WXT. Живых запросов к `git.sadmin.app` с токеном не было — остаточные риски в конце.

## R1. Сборки: по организации или по репозиториям
- **Decision**: основной режим — `GET /orgs/{org}/actions/runs` по каждой организации из `/user/orgs` + `/repos/{o}/{r}/actions/runs` для `scope.includeRepos` и собственных репо пользователя. Запасной (`capabilities.actions='repo'`) — по репозиториям, лимит 30.
- **Rationale**: org-роут охраняется `reqOrgMembership()` (api.go L1718-1723), не владением; выдача сужена до репо, чьи Actions пользователь может читать (shared/action.go L28-38). Один запрос на организацию вместо N.
- **Alternatives**: `/user/actions/runs` — только репо, *принадлежащие* пользователю (user/action.go L410) — не покрывает организации; `/admin/actions/runs` — только админ.

## R2. Минимальная версия Gitea
- **Decision**: сборки требуют **≥ 1.25** (PR #33964, CHANGELOG 1.25.0). Ниже — `capabilities.actions='unsupported'`, раздел деградирует (FR-033). Проверка — по `GET /version` + пробный запрос runs (404 ⇒ unsupported).
- **Alternatives**: парсить только версию — отвергнуто, форки (Forgejo) нумеруют иначе; решает пробный запрос.

## R3. Права токена
- **Decision**: `read:repository` (репо, PR, статусы, repo-runs), `read:issue` (поиск PR), `read:user` (`/user`, `/user/orgs`* ), `read:organization` (org-runs), `read:notification` (этап полировки). Диагностика: 403 на конкретной пробе → имя права.
- *`/user/orgs` в категории organization — проверяется пробой; диагностика опирается на пробу, не на таблицу.

## R4. Статусы сборок
- **Decision**: маппинг `convert.ToActionsStatus` (convert.go L427-452): `queued→waiting`, `waiting→blocked`, `in_progress→running` (включая Cancelling), `completed`+`conclusion ∈ success|failure|cancelled|skipped`; `completed` без conclusion → `failure`-подобный «unknown», показываем как `cancelled` с подсказкой.
- Активные одним запросом: `?status=queued&status=waiting&status=in_progress` (параметр повторяемый — shared/action.go L180-187).
- Порядок выдачи — `id DESC` (run_list.go L124-135) → недавние завершённые: `?limit=50` и отсечение по `completed_at < now − recentWindowHours`.
- **«Мои» не должны вытесняться** массовыми перезапусками (страница 50 забивается чужими PR): отдельный запрос на организацию `?actor=<me>&limit=30` + по закреплённым репо `/repos/{o}/{r}/actions/runs?limit=10`; результаты объединяются с общими по `id`.

## R5. Имя workflow
- **Decision**: `path = "<file>@<ref>"` (convert.go L325) → показываем имя файла; человеческое имя — из `GET /repos/{o}/{r}/actions/workflows` (кэш на репо, TTL 24 ч, только для репо, попавших в список). При ошибке — имя файла.

## R6. «Моя» сборка
- **Decision**: `mine = actor.login==me || trigger_actor.login==me || pull_requests[].number ∈ мои открытые PR этого репо`. `pull_requests` заполнен по умолчанию (convert.go L335-375), включая push в ветку открытого PR. `exclude_pull_requests` не передаём.

## R7. Статус CI в PR
- **Decision**: combined `GET /repos/{o}/{r}/commits/{sha}/status`; **`total_count==0` ⇒ `none`**, потому что пустой ответ отдаёт `state:"pending"` (status.go L55-61) и `statuses:null`. head sha и `mergeable` — из `GET /repos/{o}/{r}/pulls?state=open&sort=recentupdate&limit=50`, только для репо, чьи PR изменились (`updated_at`).

## R8. Поиск PR
- **Decision**: `issues/search?type=pulls&state=open` c `review_requested=true` / `created=true`; «остальные» — `owner=<org>` по организациям. **Без `q`**: только DB-путь учитывает командные запросы ревью и снимает PR после Approve/Reject (issue_search.go L392-415); индексатор по `q` этого не делает.

## R9. Кэширование и ETag
- **Decision**: ETag не реализуем — JSON API его не ставит и `If-None-Match` игнорирует (httpcache только у raw/registry). Экономия: неизменный sha → окончательный статус не перезапрашивается; `updated_at` → список PR репо не перезапрашивается; `X-Total-Count` для счётчиков.

## R10. Частота опроса
- **Decision**: `chrome.alarms` ≥ 30 с (docs: `periodInMinutes < 0.5` игнорируется). Фон: `poll` (60 с по умолчанию) + `poll-fast` (30 с при активных «моих» сборках). 15–20 с — только при открытом окне: окно шлёт `popup-heartbeat`, фон держит `setTimeout`-цикл, пока приходят сердцебиения.
- Бюджет базового режима на цикл: на организацию 3 (активные, последние, мои) + закреплённые вне охвата организаций ≤ 5 + собственные репо пользователя с Actions (только базовый цикл) ≤ 5 + поиск PR 2 + «остальные» 1 на организацию и 1 на себя + списки PR 0–5 + статусы 0–10. Итого **1 организация ≈ 10–20/мин, 3 организации ≈ 16–35/мин** (SC-009). fast-цикл: только «активные» + «мои» на организацию (2×) и закреплённые.

## R11. Доступ к Gitea из расширения
- **Decision**: `optional_host_permissions: ["https://*/*","http://*/*"]`, при сохранении — `permissions.request({origins:[origin+'/*']})` из обработчика клика (жест обязателен). Запросы — из service worker и страниц расширения; с выданным host-правом CORS не мешает (у Gitea `[cors] ENABLED=false` по умолчанию). Заголовок `Authorization: token <PAT>`.

## R12. Стек
- **Decision**: **TypeScript + WXT 0.21 + Preact 10 (`@preact/preset-vite`) + Vitest (`WxtVitest`, `fakeBrowser`)**; без UI-библиотек, CSS руками (≈ 15 КБ бандл окна при цели ≤ 300 КБ).
- **Rationale**: WXT даёт генерацию MV3-манифеста, `_locales`, `wxt zip` (FR-075), fake-browser для тестов фоновой логики. Preact — ~4 КБ против ~45 КБ React.
- **Alternatives**: CRXJS 3.0 — жив, но ниже уровнем (нет zip, fake-browser); React — вес без выигрыша; Svelte/Solid — у WXT есть шаблоны, но команда знает React-подобный JSX.
- **Риски**: у WXT нет официального Preact-модуля — алиас `react→preact/compat` и Vitest настраиваем сами; dev-команда WXT `wxt:reload-extension` занимает слот горячих клавиш (у нас одна команда — конфликта нет).

## R13. Выпуск (FR-075)
- **Decision**: `.gitea/workflows/release.yml` по тегу `v*`: `pnpm i --frozen-lockfile && pnpm test && pnpm zip` → вложение `gitea-dashboard-<ver>-chrome.zip` в релиз через API. Версия — из `package.json`, видна в настройках (`runtime.getManifest().version`).

## Остаточные риски (проверить живьём личным токеном, T-задача «пробы»)
1. `/user/orgs` и `/orgs/{org}/actions/runs` с токеном без `read:organization` → точный код (403?) для диагностики.
2. Где будет жить репозиторий расширения на нашем Gitea (org `simplx` или личный) и наличие раннера для релиза.
3. Поведение `review_requested` при `ISSUE_INDEXER_TYPE` нашего инстанса без `q` — по коду DB-путь, подтвердить на живом PR.
