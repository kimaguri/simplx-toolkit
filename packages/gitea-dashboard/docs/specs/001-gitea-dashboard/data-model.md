# Data Model: Gitea Dashboard

Все сущности живут в хранилищах браузера; своего сервера нет. Ключ `instanceId` — хэш нормализованного `baseUrl`
(`https://git.example` → `i_<sha1[0..8]>`), чтобы кэш и история уведомлений разных подключений не смешивались (spec, Edge Cases).

## Раскладка хранилищ

| Хранилище | Ключ | Содержимое | Почему здесь |
|---|---|---|---|
| `storage.sync` | `settings` | `Settings` (без токена) | синхронизируется между устройствами разработчика |
| `storage.sync` | `pins:<instanceId>` | `RepoRef[]` | закреплённые — синхронно (FR-014) |
| `storage.local` | `instances` | `Instance[]` + `activeInstanceId` | задел под несколько подключений (FR-007) |
| `storage.local` | `token:<instanceId>` | строка PAT | **только local**, никогда не sync (FR-003) |
| `storage.local` | `snapshot:<instanceId>` | `Snapshot` | мгновенный показ окна (FR-042) |
| `storage.local` | `statusCache:<instanceId>` | `Record<sha, CiStatus>` | переиспользование статусов CI (FR-022) |
| `storage.local` | `prHeads:<instanceId>` | `Record<"owner/repo", { maxUpdatedAt, heads: Record<number, PrHead> }>` | head sha и конфликты по репо |
| `storage.local` | `seen:<instanceId>` | `SeenEvents` | дедупликация уведомлений (FR-061) |
| `storage.local` | `poll:<instanceId>` | `PollState` | бэкофф, режим, пауза по авторизации |
| `storage.local` | `ui` | `{ lastTab, othersCollapsed }` | последний раздел (FR-070), свёрнутость «Остальных» (FR-030) |

Лимит `storage.sync`: 8 КБ на ключ, 100 КБ всего — `settings` + `pins` укладываются (≤ 200 закреплённых).

## Сущности

### Instance
| Поле | Тип | Правила |
|---|---|---|
| `id` | string | `i_` + 8 hex от sha1(`baseUrl`) |
| `baseUrl` | string | нормализован: `https`/`http`, без хвостового `/`, без `/api/v1` |
| `login`, `userId` | string?, number? | из проверки подключения |
| `serverVersion` | string? | |
| `capabilities` | `Capabilities` | результат последней проверки |
| `checkedAt` | ISO 8601? | |

### Capabilities
`{ actions: 'org' | 'repo' | 'unsupported' | 'forbidden', notifications: boolean, orgs: string[], missingScopes: Scope[] }`
- `org` — сборки по организациям; `repo` — запасной режим по репозиториям (FR-034); `unsupported` — нет API (версия); `forbidden` — нет права.

### Settings (sync)
| Поле | Тип | По умолчанию | Валидация |
|---|---|---|---|
| `pollIntervalSec` | number | 60 | ≥ 30 (FR-040) |
| `badgeMode` | `'reviews' \| 'builds' \| 'sum'` | `reviews` | FR-050 |
| `recentWindowHours` | number | 24 | 1–168 |
| `redBadgeWindowMin` | number | 30 | 5–1440 (FR-051) |
| `showOtherPrs` | boolean | true | FR-020 |
| `notify.buildFailed` | `'off' \| 'myPrs' \| 'myPushes' \| 'mine' \| 'all'` | `mine` | `mine` = мои PR + мои пуши (FR-060) |
| `notify.buildSucceededMyPr` | boolean | false | |
| `notify.reviewRequested` | boolean | true | |
| `notify.comments` | boolean | false | этап полировки |
| `scope.excludeRepos` / `scope.excludeOrgs` / `scope.includeRepos` | string[] | [] | FR-035 |
| `repoModeLimit` | number | 30 | предупреждение при превышении |

### RepoRef / Repo
`RepoRef = { owner, name }` (ключ `owner/name`). `Repo = RepoRef & { private, updatedAt, htmlUrl, pinned }`.

### PullRequest
| Поле | Источник / правило |
|---|---|
| `id`, `repo`, `number`, `title`, `author`, `updatedAt`, `htmlUrl` | поиск PR |
| `draft` | `pull_request.draft` |
| `group: 'review' \| 'mine' \| 'other'` | `review` приоритетнее `mine`; PR показывается один раз |
| `headSha`, `headRef`, `mergeable` | список PR репо (`prHeads`); `mergeable=false` → конфликт |
| `ci: CiStatus` | `statusCache[headSha]` |

### CiStatus
`{ state: 'success' | 'failure' | 'error' | 'pending' | 'warning' | 'skipped' | 'none', fetchedAt }`
- `none` ⇐ `total_count = 0` (пустой ответ Gitea отдаёт `state:"pending"` — смотреть только на `total_count`). Окончательные — всё, кроме `pending`; не перезапрашиваются (FR-022).
- UI: `error` = падение, `skipped` = «нет проверок».

### Run
| Поле | Правило |
|---|---|
| `id`, `attempt`, `number`, `repo`, `branch`, `event`, `actor`, `headSha`, `htmlUrl`, `title` | из API (`run_attempt`, `display_title`) |
| `workflow` | `name` из кэша workflows репо (R5), иначе имя файла из `path` до `@` |
| `state: RunState` | маппинг ниже |
| `startedAt`, `completedAt` | длительность = `(completedAt ?? now) − startedAt` |
| `mine` | `actor`/`trigger_actor` = я, или `pull_requests[].number` — мой открытый PR этого репо (R6) |
| `group: 'mine' \| 'others'` | `mine` или закреплённый репо → `mine` (FR-030) |

**RunState** (термины UI Gitea, FR-032): `waiting | blocked | running | success | failure | cancelled | skipped`.
Маппинг API → RunState (research R4): `queued→waiting`, `waiting→blocked`, `in_progress→running`, `completed + conclusion → conclusion`. Активные = `waiting | blocked | running`.

### Snapshot
`{ fetchedAt, prs, runs, counts: { reviews, activeMine, activeOthers, failedOthers }, redUntil?, error?: { kind: 'auth' | 'network' | 'forbidden' | 'server', at, detail }, sectionErrors?: { prs?, runs? } }` — `detail` без токена и заголовков (FR-003). При ошибке цикла прошлые `prs`/`runs`/`fetchedAt` **сохраняются**, выставляется только `error` (окно показывает «данные на ЧЧ:ММ»). Маппинг видов ошибок — contracts/extension-surface.md «Словарь ошибок».

### SeenEvents
`{ initializedAt: ISO 8601, keys: Record<string, epochMs> }`, ≤ 500 ключей, вытесняются самые старые.
Ключи: `fail:<runId>:<attempt>`, `ok:<runId>:<attempt>` (попытка = отдельное событие, FR-061), `review:<prId>`, `note:<threadId>:<updatedAt>`.

### PollState
`{ mode: 'base' | 'fast', backoffSec: 0..600, pausedForAuth: boolean, lastOkAt }`

## Переходы состояний

**Подключение**: `unconfigured → checking → ok | error(kind)`; `ok → error(auth)` при 401 в фоне → опрос на паузе до сохранения настроек (FR-044).

**Опрос**: `base` ⇄ `fast` (есть активные «мои» сборки → фон раз в 30 с; при открытом окне 15–20 с). Сеть/5xx → бэкофф 60→120→…→600 с; успех сбрасывает.

**Уведомление**: кандидат, если ключа нет в `seen`, время события ≥ `seen.initializedAt` и в пределах `recentWindowHours` (FR-062). Ключ пишется **до** показа. Первый успешный опрос после подключения только засевает `seen`.

**Бейдж**: число по `badgeMode`; красный, пока `now < redUntil`, где `redUntil = completedAt(моя упавшая) + redBadgeWindowMin`.
