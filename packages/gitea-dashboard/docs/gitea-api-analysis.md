# Анализ Gitea API для Gitea Dashboard

> **Обновлено 2026-09-26**: пункты ⚠ проверены по исходникам v1.27.3 — итог в `specs/001-gitea-dashboard/research.md` (минимум **1.25**, org-runs доступны участнику, пустой статус = `pending`, ETag нет, `status` повторяемый).

**Дата**: 2026-09-26 · **Инстанс**: `https://git.sadmin.app` · **Версия** (по `swagger.v1.json`): **1.27.3**
Источник: `docs/swagger-1.27.3.json` (снят с инстанса анонимно). Живые запросы с токеном **не выполнялись** —
пункты с пометкой ⚠ проверить на этапе plan/реализации пробой с личным токеном.

## 1. Эндпоинты и параметры

| Задача | Эндпоинт | Параметры / ответ |
|---|---|---|
| Проверка сервера | `GET /api/v1/version` | Анонимно на нашем инстансе → 401 `Only signed in user is allowed to call APIs` (REQUIRE_SIGNIN). `version` работает только с токеном — диагностику «неверный URL» vs «неверный токен» строить по коду и телу ответа. |
| Проверка токена | `GET /api/v1/user` | `login`, `is_admin`, `id` |
| Поиск репо | `GET /api/v1/repos/search` | `q, uid, exclusive, private, archived, mode, sort=alpha\|created\|updated\|…, order, page, limit`. **Ответ обёрнут**: `{ ok, data: Repository[] }`. Итог — заголовок `X-Total-Count`. |
| Репо для пустого запроса | `repos/search?sort=updated&order=desc&limit=N` | `/user/repos` отдаёт только **собственные** репо пользователя (не организации) — не подходит. |
| Организации пользователя | `GET /api/v1/user/orgs` | нужно для org-уровня сборок |
| Поиск PR | `GET /api/v1/repos/issues/search?type=pulls&state=open` | Флаги — **boolean для текущего пользователя**: `review_requested`, `reviewed`, `created`, `assigned`, `mentioned`; ещё `owner`, `team`, `created_by`, `q`, `labels`, `since`, `before`, `page`, `limit`. |
| Head SHA / конфликт PR | `GET /repos/{o}/{r}/pulls?state=open&sort=recentupdate&limit=50` | `Issue.pull_request` из поиска содержит **только** `draft, html_url, merged, merged_at` — нет head sha и `mergeable`. Один список на репо даёт `head.sha`, `head.ref`, `mergeable`, `draft`, `requested_reviewers` для всех PR репо. |
| Статус CI | `GET /repos/{o}/{r}/commits/{ref}/status` | combined: `state ∈ pending\|success\|error\|failure\|warning\|skipped`, `total_count`, `statuses[]`. `total_count=0` → «нет проверок». |
| Сборки репо | `GET /repos/{o}/{r}/actions/runs` | `event, branch, status, actor, head_sha, exclude_pull_requests, page, limit` |
| **Сборки организации** | `GET /orgs/{org}/actions/runs` | те же фильтры. **Один запрос на всю организацию.** ⚠ права: владелец организации или достаточно членства — проверить; при 403/404 — откат на по-репозиторный опрос. |
| Сборки пользователя | `GET /user/actions/runs` | только репо, **принадлежащие** пользователю; для организаций бесполезно. |
| Jobs запуска | `GET /repos/{o}/{r}/actions/runs/{run}/jobs` | в MVP не нужен |
| Уведомления | `GET /api/v1/notifications` | `all, status-types, subject-type, since, before, page, limit`; `subject.type`, `subject.latest_comment_html_url` |

### Фильтр `status` сборок
Документированные значения: `pending, queued, in_progress, failure, success, skipped` (одно значение за запрос ⚠).

### Поля `ActionWorkflowRun`
`id, run_number, run_attempt, status, conclusion, event, head_branch, head_sha, display_title, path, actor, trigger_actor, repository, html_url, started_at, completed_at, pull_requests, previous_attempt_url`.
- **Нет имени workflow** — только `path` (ожидаемо вид `ci.yml@refs/heads/main` ⚠) и `display_title`.
- Нет длительности — считать `(completed_at || now) − started_at`.
- Статус в стиле GitHub: `status ∈ queued|waiting|in_progress|completed` + `conclusion ∈ success|failure|cancelled|skipped`. Маппинг в термины Gitea UI: Waiting→`queued`, Blocked→`waiting`, Running→`in_progress`, прочее → `completed`+conclusion ⚠ (по исходникам Gitea, проверить).

## 2. Минимальная версия и права токена

- REST-списки runs (repo/org/user) появились в **Gitea 1.24** ⚠ (по changelog; проверено только на 1.27.3). Минимум для полного функционала — **1.24**; ниже раздел сборок деградирует (FR-033), остальное работает.
- Права токена (названия из swagger 1.27.3): **`read:repository`** (репо, PR, статусы, сборки), **`read:issue`** (поиск PR), **`read:user`**, **`read:notification`**, **`read:organization`** (организации, org-runs).
- Отмены запуска **нет** (`/actions/runs/{id}/cancel` → 404, подтверждено ранее при LAB-263); есть `rerun`, `rerun-failed-jobs` — не используются.

## 3. ETag
Swagger не описывает `ETag`/`If-None-Match` для JSON API; по опыту Gitea JSON-ответы идут без ETag ⚠. Стратегия: клиент поддерживает ETag, если заголовок пришёл (304 → кэш), но нагрузка считается без него. Экономия — через `updated_at` PR и неизменность SHA.

## 4. Нагрузка и стратегия опроса

Базовый интервал 60 с, 30 отслеживаемых репо, 1 организация.

| Источник | org-режим | по-репозиторный режим |
|---|---|---|
| Сборки | 1–2 запроса | 30 |
| Поиск PR (моё ревью, мои, опц. все открытые) | 2–3 | 2–3 |
| Списки PR по репо (head sha) | только репо с изменившимися PR ≈ 0–5 | то же |
| Статусы CI | только новые sha или `pending` ≈ 0–10 | то же |
| **Итого, запросов/мин** | **≈ 5–20** | **≈ 35–45** |

Адаптивно (есть активные сборки): фон раз в 30 с (минимум `chrome.alarms`), при открытом окне — 15–20 с, учащаются только сборки. По-репозиторный режим при 30 репо и 20 с = 90/мин — отсюда лимит и предупреждение. Параллелизм ≤ 4. Бэкофф при 5xx/сети: 1→2→4… до 10 мин; при 401 — стоп до правки настроек.

## 5. Отличия от GitHub API (не переносить допущения)

1. `/repos/search` → `{ok, data}`, а не `{items, total_count}`; итоги — в `X-Total-Count`.
2. Поиск PR — boolean-флаги для текущего пользователя, а не синтаксис `q=review-requested:@me`.
3. Результат поиска PR не содержит head sha / mergeable — нужен список PR репо.
4. Combined status: есть `warning` и `skipped`; при отсутствии статусов — `total_count=0` (state может быть пустым ⚠).
5. Actions: нет имени workflow в run, нет `cancel`, нет check-runs/check-suites — CI в PR только через commit statuses.
6. Org-уровень runs есть (у GitHub только repo); user-уровень — только репо пользователя.
7. Анонимный доступ к API закрыт (REQUIRE_SIGNIN) — даже `/version`.
8. `pull_requests` в run может быть пустым ⚠ — связывать run с PR по `head_sha`/`head_branch`.
9. Статусы runs: GitHub-подобные `status/conclusion`, в UI Gitea — `waiting/blocked/running/…`; нужен явный маппинг.

## 6. Проверить живой пробой (⚠) до/во время plan
- Доступ к `/orgs/{org}/actions/runs` для не-владельца организации.
- Формат `path` у run, маппинг `status` для blocked/waiting.
- Наличие `ETag` на JSON-ответах.
- `state` combined status при нуле статусов.
- `pull_requests` у run по событию `pull_request`.

Пробы требуют личного токена владельца — боты CI (`simplx-ci-bot`) для этого не используются.
