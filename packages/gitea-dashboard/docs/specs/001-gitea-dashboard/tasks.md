# Tasks: Gitea Dashboard

**Input**: `specs/001-gitea-dashboard/` — plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Prerequisites**: plan.md, spec.md
**Tests**: включены — test-first для `src/api`, `src/domain`, `src/background` (Vitest + `WxtVitest()` + `fakeBrowser`). Задача-тест идёт **до** задачи-кода; исполнитель обязан показать, что тест **падает** (RED) до реализации, и приложить вывод.
**Organization**: по пользовательским историям; каждая фаза — самостоятельно проверяемый инкремент.
**Rev.2 (2026-09-26)**: перестроено по `/speckit-analyze` — тесты перед кодом, опрос разбит на модули, «мои» сборки отдельным запросом, бейдж подключён, локализация всех строк, снимок при потере связи.

## Format: `[ID] [P?] [Story] Description`
- **[P]** — можно параллельно (разные файлы, нет зависимости от незавершённых задач)
- **[USn]** — история из spec.md
- Пути — от корня репозитория `gitea-dashboard/`

---

## Phase 1: Setup

- [ ] T001 Живые пробы Gitea личным токеном владельца (research.md «Остаточные риски»): код ответа `/user/orgs` и `/orgs/simplx/actions/runs` для токена без `read:organization`; `issues/search?type=pulls&state=open&review_requested=true` на живом PR с командным ревью; `actor=` на org-runs; сохранить обезличенные ответы (логины → `alice`/`bob`, без токенов) в `tests/fixtures/live/` и итог в `docs/probes.md`; обновить contracts/gitea-api.md при расхождении. **Выполняет владелец** (нужен личный токен); остальные задачи от неё не блокируются
- [X] T002 Создать каркас: `package.json` (name `gitea-dashboard`, version `0.1.0`, scripts `dev|build|zip|test|typecheck`), `tsconfig.json` (strict), `wxt.config.ts` с `@preact/preset-vite`, `srcDir: 'src'`, манифестом из contracts/extension-surface.md (permissions `storage,alarms,notifications`, `optional_host_permissions`, `commands._execute_action` Alt+G, `omnibox.keyword: 'gt'`, `options_ui.open_in_tab`, `default_locale: 'ru'`); `pnpm install`; `.gitignore` (`.output`, `.wxt`, `node_modules`); заглушки `src/entrypoints/{background.ts,popup/index.html,options/index.html}` чтобы `pnpm build` проходил
- [X] T003 [P] Настроить Vitest: `vitest.config.ts` с `WxtVitest()` и preact-алиасами, `tests/setup.ts` (сброс `fakeBrowser` в `beforeEach`), smoke-тест `tests/unit/smoke.test.ts`; `pnpm test` зелёный
- [X] T004 [P] Создать `public/_locales/ru/messages.json` (extName, extDescription, actionTitle, omniboxDescription) и `public/_locales/en/messages.json` с теми же ключами
- [X] T005 [P] Иконки `public/icon/{16,32,48,128}.png` (нейтральный значок без бренда Gitea)
- [X] T006 [P] Релизный workflow `.gitea/workflows/release.yml`: по тегу `v*` — `pnpm i --frozen-lockfile`, `pnpm test`, `pnpm zip`, загрузка `.output/*-chrome.zip` вложением в релиз через Gitea API (`GITEA_TOKEN` из секретов) (FR-075, research R13)

**Checkpoint**: `pnpm build` даёт `.output/chrome-mv3`, `pnpm test` зелёный.

---

## Phase 2: Foundational (блокирует все истории)

- [X] T007 Общие доменные типы `src/domain/types.ts` строго по data-model.md: `RepoRef, Repo, PullRequest, CiStatus, RunState, Run, Snapshot (+sectionErrors), Settings (+DEFAULT_SETTINGS), Instance, Capabilities, SeenEvents, PollState`, словарь ошибок `ApiErrorKind | SnapshotErrorKind | ConnectionKind` и функции маппинга из contracts/extension-surface.md «Словарь ошибок» (только типы + константы + чистые мапперы)
- [X] T008 [P] Тест `tests/unit/storage.test.ts`: `instanceId(baseUrl)` стабилен для `https://x/`, `https://x`, `https://x/api/v1`; токен пишется только в `local` (`token:<id>`), `settings` — в `sync`; `instances`+`activeInstanceId` в local; дефолты `Settings`; `pollIntervalSec < 30` отвергается
- [X] T009 [P] Тест `tests/unit/time.test.ts`: `relative(iso, now)` («5 мин назад», «вчера»), `duration(start, end|now)` → `1ч 02м`, `45с`, отсутствующий `started_at` → `—`
- [X] T010 [P] Узкие типы ответов Gitea в `src/api/types.ts` по contracts/gitea-api.md (Repository, SearchResults `{ok,data}`, Issue, PullRequest head/mergeable, CombinedStatus, WorkflowRun, WorkflowRunsList, Workflow, NotificationThread, User, Organization, ServerVersion)
- [X] T011 [P] Фикстуры `tests/fixtures/*.json` по форме Gitea v1.27.3: `repos-search.json`, `issues-search-review.json`, `issues-search-created.json`, `issues-search-org.json`, `pulls-open.json`, `status-success.json`, `status-warning.json`, `status-empty.json` (`state:"pending", total_count:0, statuses:null`), `runs-active.json`, `runs-recent.json` (все статусы и `conclusion`, запуск без ветки, запуск по тегу), `runs-flood.json` (60 чужих запусков), `runs-mine.json`, `workflows.json`, `notifications.json`, `user.json`, `orgs.json`, `version.json`
- [X] T012 Реализовать `src/lib/storage.ts` (`normalizeBaseUrl`, `instanceId` через `crypto.subtle` sha1, типизированные get/set для settings/pins (sync) и token/instances/snapshot/ui/кэшей (local), `onSnapshotChanged`) — до зелёного T008
- [X] T013 [P] Реализовать `src/lib/time.ts` — до зелёного T009; `src/lib/i18n.ts` (`t(key, subs?)` над `browser.i18n.getMessage`, фолбэк — ключ)
- [X] T014 Тест `tests/unit/client.test.ts`: заголовок `Authorization: token <t>`; только GET (иной метод — исключение); запрос к origin ≠ baseUrl запрещён; ≤ 4 одновременных (5-й ждёт); таймаут 15 с; маппинг ошибок → `ApiErrorKind`; текст ошибки не содержит токена; повторяемые параметры-массивы (`status=a&status=b`); чтение `X-Total-Count`
- [X] T015 Реализовать `src/api/client.ts` (`createClient({baseUrl, token})`, `get<T>(path, query)`, пул на 4, `ApiError{kind,status}`) — до зелёного T014
- [X] T016 Тест `tests/unit/endpoints.test.ts` (мок-fetch): пути и параметры A1–A15 из contracts/gitea-api.md; `searchRepos` разворачивает `{ok,data}`; `activeRuns(org)` шлёт три `status`; `myRuns(org, login)` шлёт `actor`
- [X] T017 Реализовать `src/api/endpoints.ts` — до зелёного T016
- [X] T018 [P] Общие компоненты окна `src/ui/`: `theme.css` (токены цветов, `prefers-color-scheme`), `List.tsx` (скролл внутри, выделение, `aria-activedescendant`), `StatusIcon.tsx` (RunState и CiStatus), `Empty.tsx`, `ErrorState.tsx` (кнопка «Открыть настройки»), `Stale.tsx` («данные на ЧЧ:ММ, нет связи»); все строки через `t()` с ключами в `public/_locales/ru/messages.json`
- [X] T019 Тест `tests/integration/poller-core.test.ts`: мьютекс (второй вызов во время цикла не запускает параллельный); ошибка секции `runs` пишет `sectionErrors.runs`, секция `prs` продолжает; ошибка `unreachable` всего цикла сохраняет прошлые `prs/runs/fetchedAt` и ставит `error.kind='network'`; 401 → `pausedForAuth`, дальнейшие alarms не ходят в сеть; бэкофф 60→120→…→600 при `network|server`, сброс при успехе (FR-042, FR-044, Edge Cases)
- [X] T020 Каркас фона: `src/background/messages.ts` (типы 4 сообщений из contracts/extension-surface.md), `src/background/poller/index.ts` (цикл с мьютексом, реестр секций, запись снимка по правилам T019, бэкофф, пауза по 401), `src/background/schedule.ts` (alarm `poll` по `pollIntervalSec`), `src/entrypoints/background.ts` (роутер сообщений, `settings-changed` → перепланировать и снять паузу) — до зелёного T019
- [X] T021 Оболочка окна `src/entrypoints/popup/{index.html,main.tsx,App.tsx}`: ширина 400 px, три таба (Репо/PR/Сборки, `Alt+1..3`), последний таб из `ui.lastTab` (FR-070), чтение снимка из storage при монтировании и подписка на изменения, `Stale` при `snapshot.error`, отправка `refresh{reason:'popup-open'}`; строки через `t()`

**Checkpoint**: окно открывается с тремя пустыми табами, фон принимает сообщения, клиент/хранилище/ядро опроса под тестами.

---

## Phase 3: User Story 1 — Подключение к Gitea (P1) 🎯 MVP

**Goal**: адрес + токен → проверка с понятной диагностикой; доступ только к origin инстанса.
**Independent Test**: quickstart Q1–Q5.

- [X] T022 [US1] Тест `tests/unit/connection.test.ts`: успех (login, version 1.27.3, `actions:'org'`); невалидный URL → `bad-url` без запроса; 401 → `auth`; fetch-исключение → `unreachable`; 200 не-JSON → `not-gitea`; 403 на `/user/orgs` → `scope` + `missingScopes:['read:organization']`; 404 на org- и repo-runs → `actions:'unsupported'`; 403 на org-runs и 200 на repo-runs → `actions:'repo'`; 403 на обоих → `actions:'forbidden'`; токен не встречается в отчёте
- [X] T023 [US1] Реализовать `src/background/connection.ts` (`checkConnection(baseUrl, token)` по таблице contracts/gitea-api.md «Коды ответа», сохранение `Instance` с `capabilities`) — до зелёного T022
- [X] T024 [US1] Страница настроек `src/entrypoints/options/{index.html,main.tsx,Options.tsx}` — секция «Подключение»: адрес (по умолчанию `https://git.sadmin.app`), токен (`type=password`), ссылка `<baseUrl>/user/settings/applications`, список прав (FR-002), кнопки «Сохранить» и «Проверить подключение», вывод отчёта через `t(messageKey)`, версия `runtime.getManifest().version` (FR-075); все строки и `diag_*`/`scope_*` ключи в `public/_locales/ru/messages.json`
- [X] T025 [US1] В обработчике клика «Сохранить» (`src/entrypoints/options/Options.tsx`) — `browser.permissions.request({origins:[origin+'/*']})`; отказ → сообщение, не сохранять; смена адреса → `permissions.remove` старого origin (FR-004, research R11)
- [X] T026 [US1] Окно `src/entrypoints/popup/App.tsx`: состояние «не настроено» (приглашение + `runtime.openOptionsPage()`), состояние `error.kind==='auth'` во всех табах (US1-1, Edge Cases)

**Checkpoint**: Q1–Q5 проходят вручную.

---

## Phase 4: User Story 2 — Быстрый переход к репозиторию (P1)

**Goal**: поиск, клавиатура, закрепление, omnibox.
**Independent Test**: quickstart Q6–Q7.

- [X] T027 [US2] Тест `tests/unit/repos.test.ts`: `mergeRepoList(pins, results)` — закреплённые сверху без дублей; сортировка по `updated_at`; `repoUrl(repo, mode)` для `open|pulls|actions`; `togglePin` пишет в `sync` под `pins:<instanceId>`; `omniboxSuggestions(query, pins, results)` ≤ 6
- [X] T028 [US2] Реализовать `src/domain/repos.ts` — до зелёного T027
- [X] T029 [US2] Таб `src/entrypoints/popup/tabs/Repos.tsx`: автофокус (FR-010), дебаунс 200 мс → `searchRepos` напрямую (исключение из plan.md), пустой запрос → pins + `sort=updated`, элемент (`owner/name`, замок приватности, относительное время), `↑/↓`, `Enter` и клик → репо, `Cmd|Ctrl+Enter` → `/pulls`, `Shift+Enter` → `/actions` (`tabs.create`), `Cmd|Ctrl+P` и иконка — закрепить с `preventDefault` (не открывать печать) (FR-011..014); строки через `t()`
- [X] T030 [US2] Omnibox в `src/entrypoints/background.ts` (обработчики в `src/background/omnibox.ts`): `onInputChanged` (дебаунс 200 мс, `omniboxSuggestions`), `onInputEntered` → репо или `/explore/repos?q=` (FR-015)

**Checkpoint**: Q6–Q7 проходят; раздел «Репо» работает без PR и сборок.

---

## Phase 5: User Story 3 — PR, которые ждут меня (P1)

**Goal**: группы PR, статус CI, конфликт, бейдж «ревью».
**Independent Test**: quickstart Q8 (без уведомления).

- [X] T031 [P] [US3] Тест `tests/unit/ci.test.ts`: `toCiStatus` — `total_count:0` ⇒ `none` даже при `state:"pending"`; `warning` ⇒ `warning`; `error` ⇒ показ как падение; `skipped` ⇒ «нет проверок»; `isFinal` (`pending` — нет)
- [X] T032 [P] [US3] Тест `tests/unit/prs.test.ts`: `groupPrs(review, created, others)` — PR в обеих выборках один раз в `review`; `others` исключает мои и `excludeRepos/excludeOrgs`, включает PR из `includeRepos` и моих репо; сортировка по `updatedAt`; слияние `prHeads` (sha, `mergeable:false` ⇒ конфликт) и `statusCache`; `reposNeedingHeads(prs, prHeads)` — только репо с выросшим `max(updated_at)`
- [X] T033 [P] [US3] Тест `tests/unit/badge.test.ts`: `badgeFor(settings, snapshot, now)` — `reviews` (0 ⇒ пусто, 12 ⇒ «12»), `builds` (= `activeMine`), `sum`; красный при `now < redUntil`, иначе нейтральный; `redUntilFrom(runs, redBadgeWindowMin)` по моей упавшей
- [X] T034 [US3] Реализовать `src/domain/ci.ts` и `src/domain/prs.ts` — до зелёного T031–T032
- [X] T035 [US3] Реализовать `src/domain/badge.ts` (все режимы и `redUntilFrom`) — до зелёного T033
- [X] T036 [US3] Интеграционный тест `tests/integration/poller-prs.test.ts` (fakeBrowser + мок-fetch по фикстурам): после цикла снимок содержит группы, CI, конфликт; бейдж (`action.setBadgeText`) = число ревью; второй цикл без изменений не делает A8/A9 (подсчёт запросов); A7 ходит по `owner=<org>` и `owner=<login>`
- [X] T037 [US3] Секция `src/background/poller/prs.ts` (записывает также `snapshot.prTotals = {review, mine, other}` из `X-Total-Count`, поле добавить в `Snapshot` в `src/domain/types.ts`; A5, A6, A7, A8 для изменившихся репо и `includeRepos`, A9 для новых sha или `pending`, кэши `prHeads`/`statusCache`, `counts.reviews`) и `src/background/poller/badge.ts` (`badgeFor` → `action.setBadgeText/BackgroundColor` после каждого цикла и по `settings-changed`); регистрация в `poller/index.ts` — до зелёного T036
- [X] T038 [US3] Таб `src/entrypoints/popup/tabs/Prs.tsx`: три группы с заголовками и счётчиками, элемент (заголовок, `owner/repo #N`, автор, время, `StatusIcon` CI, «черновик», «конфликт»), клик → новая вкладка, пустые состояния, «ещё N» ссылкой при `X-Total-Count > 50` (FR-020..023, FR-072); строки через `t()`

- [X] T064 [US3] Подключить табы к окну в `src/entrypoints/popup/App.tsx`: передать `snapshot`, `settings` (чтение `getSettings()` при монтировании + обновление по `storage.onChanged` ключа `settings`), `capabilities` активного подключения в `tabs/Prs.tsx` и `tabs/Builds.tsx`; в `tabs/Prs.tsx` показать «ещё N» ссылкой (`<baseUrl>/pulls`) при `snapshot.prTotals[group] > показанных`; тест в `tests/unit/popup-app.test.tsx` (табы получают данные снимка, смена `showOtherPrs` в storage прячет группу без переоткрытия) — найдено на шве T038/T046

- [X] T065 [US3] PR из `includeRepos` (репо вне организаций): расширить `ApiPullRequest` в `src/api/types.ts` полями `id, title, user.login, updated_at, html_url`, в `src/background/poller/prs.ts` для каждого `includeRepos` брать A8 и превращать открытые PR в группу «Остальные» (кроме моих); тест в `tests/integration/poller-prs.test.ts` (FR-034, analyze G3) — найдено на шве T037

**Checkpoint**: MVP (US1–US3) — quickstart Q1–Q8 без уведомлений.

---

## Phase 6: User Story 4 — Мониторинг сборок (P2)

**Goal**: активные и недавние запуски, группы «Мои и закреплённые»/«Остальные», тикающая длительность, адаптивная частота.
**Independent Test**: quickstart Q9 (без уведомления), Q11.

- [X] T039 [P] [US4] Тест `tests/unit/runs.test.ts`: маппинг `status/conclusion` → RunState по research R4 (`completed` без conclusion → `cancelled`); `workflow` из кэша, иначе файл из `path` (`ci.yml@refs/pull/12/head` → `ci.yml`); запуск без ветки и по тегу читаем; `mine` по actor/trigger_actor/`pull_requests` ∩ мои PR; `group` (закреплённый → `mine`); отсечение завершённых старше `recentWindowHours`; активные сверху; объединение нескольких источников по `id`; при `runs-flood.json` + `runs-mine.json` все мои запуски присутствуют (research R4 «не вытесняются»)
- [X] T040 [P] [US4] Тест `tests/unit/scope.test.ts`: `runSources(caps, settings, orgs, pins, ownRepos)` — `org` для каждой организации минус `excludeOrgs` (active+recent+mine), `repo` для **всех** закреплённых (и внутри организаций — иначе их вытеснит поток чужих запусков, research R4) в base и fast, `includeRepos`, своих репо; запасной режим `repo`: закреплённые + где мои PR/сборки за 7 дней, обрезка до `repoModeLimit` с флагом превышения; `excludeRepos` фильтрует; fast-режим — только active+mine+закреплённые
- [X] T041 [US4] Реализовать `src/domain/runs.ts` и `src/domain/scope.ts` — до зелёного T039–T040
- [X] T042 [US4] Интеграционный тест `tests/integration/poller-runs.test.ts`: org-режим — ровно 3 запроса на организацию за базовый цикл, 2 за fast; flood чужих не вытесняет мои; 403 на org → запасной режим; 404 → `sectionErrors.runs`, PR обновляются (SC-008); бейдж `builds` после цикла = `activeMine`; бюджет: 3 организации + 5 закреплённых + 5 своих репо ≤ 35 запросов за базовый цикл (SC-009)
- [X] T043 [US4] Секция `src/background/poller/runs.ts`: источники из `runSources`, A10/A11/A15 на организацию, A12 на репо (пул 4), A13 кэш имён workflow 24 ч (`workflows:<instanceId>`), запись `snapshot.runs`, `counts.activeMine/activeOthers/failedOthers`, `redUntil`; регистрация в `poller/index.ts` — до зелёного T042
- [X] T044 [US4] Тест `tests/integration/schedule.test.ts` (fake timers): `activeMine>0` → alarm `poll-fast` 0,5 мин, иначе снят; `popup-heartbeat` → цикл сборок каждые 15–20 с, остановка через 10 с без сердцебиений; `settings-changed` перепланирует `poll`
- [X] T045 [US4] Реализовать режимы в `src/background/schedule.ts` и обработку `popup-heartbeat` в `src/entrypoints/background.ts` (FR-041, research R10) — до зелёного T044
- [X] T046 [US4] Таб `src/entrypoints/popup/tabs/Builds.tsx`: «Мои и закреплённые» развёрнута, «Остальные» свёрнута со счётчиком активных/упавших (`ui.othersCollapsed`), элемент (репо, workflow, ветка, событие, автор, `StatusIcon`, длительность — тик раз в 1 с только у `running`, интервал очищается при размонтировании), клик → `htmlUrl`, «нет активных сборок», сообщение `sectionErrors.runs`/`unsupported`, `popup-heartbeat` каждые 5 с; строки через `t()`

- [X] T066 [US4] Собственные репо пользователя в опросе сборок: `ownRepos(login)` в `src/api/endpoints.ts` (A4 `repos/search?uid=<userId>&exclusive=true&limit=20`, только `has_actions`), кэш 1 ч в `src/lib/storage.ts`, передача в `runSources` из `src/background/poller/runs.ts` вместо `[]`; тест бюджета в `tests/integration/poller-runs.test.ts` (3 орг + 5 закреплённых + 5 своих ≤ 35) — найдено на шве T043

**Checkpoint**: Q9 (кроме уведомления) и Q11 проходят.

---

## Phase 7: User Story 5 — Уведомления и красный бейдж (P2)

**Goal**: одно уведомление на событие, без лавины при старте, клик ведёт на страницу; красный бейдж.
**Independent Test**: quickstart Q8–Q10.

- [X] T047 [US5] Тест `tests/unit/notify.test.ts`: `pickEvents(prev, next, seen, settings, now)` — падение попытки 1 → `fail:<id>:1`; перезапуск упал → `fail:<id>:2`; повтор цикла → нет событий; первый цикл (`seen` пуст) → только засев; старше `recentWindowHours` или до `initializedAt` — игнор; охваты `myPrs|myPushes|mine|all|off`; успех по моему PR; `review:<prId>` для новых в группе `review`; вытеснение `seen` > 500; `note:<threadId>:<updatedAt>` из notifications по моим PR
- [X] T048 [US5] Реализовать `src/domain/notify.ts` — до зелёного T047
- [X] T049 [US5] Интеграционный тест `tests/integration/notify-dedupe.test.ts`: падение → ровно одно `notifications.create` с id = ключ; «перезапуск браузера» (новый poller над тем же `fakeBrowser.storage`) → ноль; смена `baseUrl` → отдельный `seen`; клик → `tabs.create(url)` + `clear`; бейдж красный после моей упавшей и нейтральный через `redBadgeWindowMin` (SC-005, FR-051)
- [X] T050 [US5] Реализовать `src/background/notifier.ts`: ключ в `seen:<id>` **до** `notifications.create`, URL в `notifUrl:<id>` (TTL 24 ч), `notifications.onClicked` (FR-061..063); вызов после цикла в `poller/index.ts` — до зелёного T049
- [X] T051 [US5] Тест `tests/integration/poller-notes.test.ts`: A14 с `since`; 403 → `capabilities.notifications=false` без ошибки цикла; выключено в настройках → запроса нет
- [X] T052 [US5] Секция `src/background/poller/notes.ts` (A14, фильтр `subject.type=Pull` по моим PR) — до зелёного T051 (FR-060)

**Checkpoint**: Q8–Q10 проходят целиком.

---

## Phase 8: User Story 6 — Настройка охвата и частоты (P3)

**Goal**: все настройки `Settings` меняются без переустановки.
**Independent Test**: изменить каждую настройку → поведение меняется (spec US6).

- [X] T053 [US6] Тест `tests/integration/settings-apply.test.ts`: смена интервала перепланирует alarm; исключение репо/организации убирает его запуски и PR на следующем цикле; режим бейджа меняет число сразу после `settings-changed`
- [X] T054 [US6] Секции «Опрос и бейдж» и «Уведомления» в `src/entrypoints/options/Options.tsx`: интервал (≥ 30, по умолчанию 60), режим бейджа, окно «недавних» (1–168 ч), окно красного бейджа, «показывать остальные PR», охват падений, успех по моему PR, ревьюер, комментарии; сохранение → `settings-changed` (FR-040, FR-050, FR-060) — до зелёного T053
- [X] T055 [US6] Секция «Охват» `src/entrypoints/options/Scope.tsx`: организации из `capabilities.orgs` с галочками (`excludeOrgs`), исключённые репо (поиск + удалить), добавленные вне организаций, закреплённые (открепить); в режиме `repo` — счётчик и предупреждение при > `repoModeLimit` (FR-034, FR-035); строки через `t()`

**Checkpoint**: US6 приёмка 1–4 проходит.

---

## Phase 9: Polish & Cross-Cutting

- [X] T056 [P] Тест локализации `tests/unit/i18n-lint.test.ts`: в `src/**/*.tsx` нет кириллицы вне вызовов `t()`; все ключи, используемые в коде, есть в `ru/messages.json` и `en/messages.json` (FR-073); дописать недостающие ключи в `public/_locales/*`
- [X] T057 [P] Тёмная тема: проверить окно и настройки в `prefers-color-scheme: dark`, поправить `src/ui/theme.css` (FR-071)
- [X] T058 [P] Аудит пустых/ошибочных/устаревших состояний всех табов по Edge Cases спеки в `src/entrypoints/popup/tabs/*.tsx`; окно открыто 30 мин — нет роста числа интервалов и слушателей (проверка через DevTools, записать в `docs/acceptance.md`)
- [X] T059 [P] Тест безопасности `tests/integration/security.test.ts`: после полного цикла и ошибок `auth/unreachable` токена нет в `storage.sync`, в `snapshot`, в перехваченных `console.*`; все `fetch` только на `baseUrl` (SC-007, FR-006)
- [X] T060 [P] Проверка размера `scripts/check-size.mjs` — JS+CSS окна ≤ 300 КБ, скрипт `pnpm test:size`, вызов в `.gitea/workflows/release.yml` (SC-010)
- [X] T061 README.md: установка «загрузить распакованное» и обновление из релизов, права токена, горячие клавиши и omnibox, оценка нагрузки (research R10) + фактический замер (SC-009)
- [ ] T062 Прогон quickstart.md Q1–Q13 на `git.sadmin.app` личным токеном, результаты в `docs/acceptance.md`; замеры SC-001 и SC-002. **Выполняет владелец** (или с его токеном)
- [ ] T063 Выпуск `v0.1.0`: тег → release.yml → архив в релизе Gitea; установка из архива на чистом профиле

---

## Phase 10: Review fixes (финальное ревью стыков, 2026-09-26)

- [X] T067 [P] [US4] H1: `src/background/poller/runs.ts` — источники через `Promise.allSettled`: 404/403 одного репо-источника не валит секцию (источник пропускается, пометка в `snapshot.sectionErrors.runs` только если упали все источники); понижение `capabilities.actions` до `repo` только если 403 от **всех** организаций; быстрый цикл с частичным сбоем не считается полным обрывом; тест в `tests/integration/poller-runs.test.ts` (удалённый закреплённый репо → остальные сборки есть, бэкоффа нет; 403 у одной орг из двух → режим `org` сохранён)
- [X] T068 [P] M1: `src/background/poller/index.ts` — мьютекс учитывает режим: запрос `base` во время `fast` ставится в очередь и выполняется после; `fast` во время `base` получает `base`-промис; тест в `tests/integration/poller-core.test.ts`
- [X] T069 [P] [US5] M2: `src/background/poller/notes.ts` — собственный курсор `notesCursor:<instanceId>` в `src/lib/storage.ts`, двигается только при успешном запросе A14; тест в `tests/integration/poller-notes.test.ts` (fast-цикл между base не теряет комментарий; 500 в notes не двигает курсор)
- [X] T070 [P] M3: `src/background/schedule.ts` — `ensurePollAlarm(sec)`: `alarms.get('poll')` и создание только если нет или период другой; `reschedule` (settings-changed) пересоздаёт всегда; тест в `tests/integration/schedule.test.ts`
- [X] T071 M4+L1+L4: вынести роутер из `src/entrypoints/background.ts` в `src/background/router.ts` (`createRouter(deps)`): каждый обработчик с `.catch`, `afterCycle` в `finally`, `sendResponse` всегда; `settings-changed` → `resume` + `reschedule` + немедленный `runCycle('base')`; старт воркера → `ensurePollAlarm` + цикл, если последний снимок старше интервала; тесты `tests/integration/router.test.ts`; `settings-apply.test.ts` и `schedule.test.ts` переводятся на `createRouter` (после T068, T070)
- [X] T072 [P] [US1] M5: `src/background/connection.ts` — `checkConnection(..., {persist})`: ручная «Проверить» не меняет `activeInstanceId` и не создаёт подключение без токена (persist только из «Сохранить»); `src/entrypoints/options/Options.tsx` передаёт флаг; тесты `tests/unit/connection.test.ts`, `tests/unit/options-connection.test.tsx`
- [X] T073 L2+L3+L5+L6: удалить `prevRedUntil` из `src/domain/badge.ts`; иконки приватности/закрепления в `src/entrypoints/popup/tabs/Repos.tsx` — inline SVG как в `src/ui/StatusIcon.tsx`, `pins` убрать из зависимостей эффекта поиска (Cmd+P не перезапрашивает и не сбрасывает выделение); при смене адреса в `Options.tsx` удалять `token:<oldId>`; `persistCapabilities` в `runs.ts`/`notes.ts` перечитывает подключение и меняет только своё поле; в `vitest.config.ts` включить `restoreMocks: true` (утечка шпионов между тестами, найдено в T070) и прогнать весь набор (после T067, T069, T072)

---

## Phase 11: Интерфейс на shadcn/ui + React, всегда русский (решение владельца 2026-09-28)

- [X] T074 Переход Preact → React 19: `package.json` (react, react-dom, @types/react*, `@wxt-dev/module-react`; удалить preact, @preact/*, @testing-library/preact → @testing-library/react), `wxt.config.ts` (modules: ['@wxt-dev/module-react'], убрать preset-vite), `tsconfig.json` (jsx react-jsx без jsxImportSource preact), `vitest.config.ts` (алиасы), все `src/**/*.tsx` и `tests/**/*.test.tsx` — импорты `preact/hooks`→`react`, `render` из @testing-library/react; поведение не меняется — весь набор зелёный до и после (FR-076)
- [X] T075 Tailwind v4 + shadcn/ui канон: `@tailwindcss/vite`, `src/styles/globals.css` (shadcn-токены new-york/neutral, `@theme inline`, тёмная тема: класс `dark` на `<html>` по `prefers-color-scheme` + слушатель смены), `components.json`, `src/lib/utils.ts` (cn), компоненты через shadcn CLI в `src/components/ui/`: button, card, input, label, select, switch, checkbox, tabs, badge, separator, scroll-area, tooltip, sonner, skeleton, alert, form-примитивы по необходимости; lucide-react; удалить `src/ui/theme.css` и `tests/unit/theme-tokens.test.ts` (заменены токенами shadcn); сборка и тесты зелёные
- [X] T076 [P] Только русский: удалить `public/_locales/en`, `default_locale: 'ru'`; `tests/unit/i18n-lint.test.ts` — проверка «ключи есть в ru», сравнение ru/en убрать (FR-073)
- [X] T077 Общие UI-компоненты на shadcn в `src/ui/`: `StatusIcon` (lucide-иконки + цвета статусов через классы Tailwind, анимация `animate-spin` для running), `RepoIcons` (lucide Lock/Star), `Empty` / `ErrorState` (shadcn Alert + Button «Открыть настройки»), `Stale` (Alert компактный), `List` (сохранить клавиатурную логику и aria, внешний вид — строки с hover/selected по канону shadcn, ScrollArea); существующие тесты UI зелёные (после T075)
- [X] T078 Страница настроек на shadcn: `src/entrypoints/options/*` — max-w-2xl по центру, заголовок + версия, каждая секция = Card (CardHeader/CardTitle/CardDescription/CardContent/CardFooter с кнопкой «Сохранить»), поля Label над Input, Select вместо <select>, Switch вместо чекбоксов-настроек, Checkbox для организаций, списки репо как Badge с кнопкой удаления, отчёт проверки — Alert (success/destructive) со списком недостающих прав; тост sonner «Сохранено» / ошибки после каждого сохранения; все тесты options-* зелёные (адаптировать селекторы по ролям/label, не ослабляя проверки) (после T077)
- [X] T079 Окно на shadcn: `src/entrypoints/popup/*` — ширина 400 px, Tabs (Репо/PR/Сборки) с счётчиками-Badge, поиск Input с иконкой, строки списков: заголовок + вторичная строка muted-foreground, Badge «черновик»/«конфликт», StatusIcon, группы с заголовками и свёрнутой «Остальные» (Collapsible), «ещё N» — Button variant link, состояния — Alert/Skeleton; все тесты popup/tabs зелёные (после T077)
- [X] T081 Служебные `CLAUDE.md` (плагин claude-mem создаёт их в любых каталогах) не должны попадать в сборку: в `wxt.config.ts` хук `build:publicAssets` отфильтровывает `**/CLAUDE.md`; удалить `public/_locales/en/` (остался только `CLAUDE.md`, пустая локаль ломает загрузку в Chrome); тест `tests/unit/build-output.test.ts` (после `wxt build` в `.output/chrome-mv3` нет `CLAUDE.md`, каждая папка `_locales/*` содержит `messages.json`, есть только `ru`); `i18n-lint` считает локалью только каталог с `messages.json` — найдено при проверке T076
- [X] T080 Визуальная проверка: `scripts/screenshots.mjs` (Playwright `chromium.launchPersistentContext` с `--load-extension=.output/chrome-mv3`, заглушка Gitea на локальном http-сервере по фикстурам `tests/fixtures`, настройка через options, скриншоты окна (3 таба) и настроек в светлой и тёмной теме → `docs/screenshots/*.png`); поднять лимит в `scripts/check-size.mjs` до 400 КБ (SC-010 rev.) и проверить размер; обновить README (стек, скриншоты) (после T078, T079)

- [X] T082 Визуальные дефекты со скриншотов T080: (1) подсветка выбранной строки видна сразу в каждой группе (3 выделения на табе PR) — выделение должно быть одно на таб: единый индекс по всем строкам таба (PR, Сборки) и подсветка только при клавиатурной навигации/фокусе (hover — как обычно); (2) содержимое таба должно прокручиваться внутри окна (`min-h-0 flex-1 overflow-y-auto` для TabsContent), низ не обрезается; тесты в `tests/unit/prs-tab.test.tsx`, `tests/unit/builds-tab.test.tsx` (одна `aria-selected=true` на таб, стрелки проходят через границы групп, Enter открывает выбранную), пересъёмка `pnpm screenshots` и проверка кадров
---

## Dependencies & Execution Order

- **Setup (T001–T006)** → **Foundational (T007–T021)** → истории. T001 не блокирует ничего (результат может поправить контракт).
- Внутри Foundational: T007 → (T008, T009, T010, T011, T018 параллельно) → T012, T013 → T014 → T015 → T016 → T017 → T019 → T020 → T021.
- **US1** (T022–T026), **US2** (T027–T030), тесты **US3** (T031–T033) и **US4** (T039–T040) — параллельно после Foundational.
- Общие файлы (последовательно, не параллелить): `src/entrypoints/background.ts` (роутер + регистрация секций опроса) — T020 → T023 → T030 → T037 → T043 → T045 → T050 → T052; `src/background/poller/index.ts` — T020 → T037 → T043 → T050 → T052; `src/entrypoints/popup/App.tsx` — T021 → T026; `src/entrypoints/options/Options.tsx` — T024 → T025 → T054; `public/_locales/ru/messages.json` правят многие задачи — только дописывать ключи, мерж последовательно.
- **US5** после US3 и US4. **US6** после US5. **Polish** последним; T062–T063 — после всего.

```text
Setup → Foundational ─┬─ US1 ─┐
                      ├─ US2 ─┤
                      ├─ US3 ─┼─ US5 ─ US6 ─ Polish
                      └─ US4 ─┘
```

## Parallel Examples

- Foundational: T008, T009, T010, T011, T018 одновременно (после T007).
- После Foundational: T022 (US1), T027 (US2), T031+T032+T033 (US3), T039+T040 (US4) — одной волной.
- US3: T034 и T035 параллельно → T036 → T037 → T038.

## Implementation Strategy

1. **MVP** = Setup + Foundational + US1–US3 (T001–T038, ≈ 3 дня) → `v0.1.0`.
2. **Сборки и уведомления** = US4 + US5 (T039–T052, ≈ 2 дня) → `v0.2.0`.
3. **Настройка и полировка** = US6 + Polish (T053–T063, ≈ 1,5 дня) → `v0.3.0`.
