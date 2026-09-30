# Data Model: 002

Модель данных фичи 001 не меняется (Snapshot, PullRequest, Run, Settings, Instance). Новое:

## PageRoute (адрес страницы)
`{ section: 'repos' | 'prs' | 'builds', view?: 'groups' | 'table' | 'history', params: URLSearchParams }` ↔ `#/<section>?<params>`. По умолчанию раздел из `ui.lastPageSection` (storage.local), иначе `prs`.

## PrTableFilter (в адресе)
| Параметр | Тип | Пример |
|---|---|---|
| `repo` | повторяемый `owner/name` | `repo=acme/platform&repo=acme/core` |
| `author` | повторяемый login | `author=alice` |
| `ci` | повторяемый CiState | `ci=failure&ci=pending` |
| `group` | повторяемый review/mine/other | |
| `draft` | `only` / `exclude` | |
| `conflict` | `only` | |
| `q` | строка | |
| `sort` | `<column>:<asc|desc>`, по умолчанию `updated:desc` | |

## RunHistoryFilter (в адресе)
`period` = `24h|7d|30d` (по умолчанию `7d`), повторяемые `repo`, `wf`, `branch`, `event`, `result` (RunState), `mine=1`, `sort` = `started:desc|duration:desc`.

## RunHistoryCache (storage.local, ключ `runsHistory:<instanceId>:<sourceKey>`)
`{ fetchedAt: ISO, runs: Run[], nextPage: number, exhausted: boolean, oldestStartedAt?: ISO }`; `sourceKey` = `org:<org>` | `repo:<owner>/<name>` (+ `:branch=…:event=…` при серверных фильтрах). TTL 5 мин; > 2000 запусков на источник — хвост отбрасывается.

## RunStats (вычисляется)
`{ total, completed, failed, failureRate (0..1), avgDurationSec?, medianDurationSec?, byWorkflow: Array<{ workflow, total, failed, avgDurationSec? }> }`.

## UiState (расширение)
`lastPageSection?: 'repos'|'prs'|'builds'`, `prView?: 'groups'|'table'`, `buildsView?: 'groups'|'history'`.
