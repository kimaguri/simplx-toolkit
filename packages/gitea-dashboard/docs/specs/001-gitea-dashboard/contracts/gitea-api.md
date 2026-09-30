# Contract: потребляемый Gitea API (v1.27.3, минимум 1.25 для сборок)

Все запросы: `GET`, база `<baseUrl>/api/v1`, заголовки `Authorization: token <PAT>`, `Accept: application/json`. Мутирующих запросов нет (FR-005).

| # | Запрос | Используемые поля ответа | Когда |
|---|---|---|---|
| A1 | `/version` | `version` | проверка подключения |
| A2 | `/user` | `id, login` | проверка подключения, раз в сутки |
| A3 | `/user/orgs?limit=50` | `username` | проверка + раз в час |
| A4 | `/repos/search?q=&sort=updated&order=desc&limit=20` | **`{ok, data[]}`**: `full_name, owner.login, name, private, updated_at, html_url` | ввод в поиске (дебаунс 200 мс), omnibox |
| A5 | `/repos/issues/search?type=pulls&state=open&review_requested=true&limit=50` | `id, number, title, user.login, updated_at, html_url, repository.full_name, pull_request.draft` | каждый цикл |
| A6 | то же с `created=true` | то же | каждый цикл |
| A7 | то же с `owner=<org>` и `owner=<login>` | то же | каждый цикл, если `showOtherPrs`; для `includeRepos` — A8 (`/pulls` репо даёт `title, user, updated_at, html_url`) |
| A8 | `/repos/{o}/{r}/pulls?state=open&sort=recentupdate&limit=50` | `number, head.sha, head.ref, mergeable, draft` | только если в репо изменился `updated_at` какого-то PR |
| A9 | `/repos/{o}/{r}/commits/{sha}/status` | `state, total_count` (**`total_count=0` ⇒ none**) | новый sha или предыдущий `pending` |
| A10 | `/orgs/{org}/actions/runs?status=queued&status=waiting&status=in_progress&limit=50` | см. Run | каждый цикл (и fast) |
| A11 | `/orgs/{org}/actions/runs?limit=50` | см. Run | каждый цикл базового режима |
| A12 | `/repos/{o}/{r}/actions/runs?limit=10` (запасной режим: `limit=20`) | см. Run | запасной режим; закреплённые; `includeRepos`; собственные репо пользователя |
| A15 | `/orgs/{org}/actions/runs?actor=<login>&limit=30` | см. Run | каждый цикл: «мои» не вытесняются чужими перезапусками |
| A13 | `/repos/{o}/{r}/actions/workflows` | `id` (= файл), `name` | кэш 24 ч, только репо из списка |
| A14 | `/notifications?since=<iso>&limit=50` | `id, updated_at, subject.{type,title,html_url,latest_comment_html_url}, repository.full_name` | этап полировки |

**Run** (A10–A12, `{total_count, workflow_runs[]}`): `id, run_attempt, run_number, status, conclusion?, event, head_branch, head_sha, display_title, path ("<file>@<ref>"), actor.login, trigger_actor.login, repository.full_name, html_url, started_at, completed_at, pull_requests[].number`.

## Коды ответа → диагностика

| Ситуация | Признак | `kind` |
|---|---|---|
| Сеть/DNS/TLS | `fetch` бросает | `unreachable` |
| Не Gitea | 200 без JSON или без `version` | `not-gitea` |
| Токен неверен | 401 на A2 | `auth` |
| Нет права | 403 на пробе (A3/A10/A14/A5) | `scope` + имя права |
| Сборки не поддерживаются | 404 на A10 и A12 | `actions='unsupported'` |
| 5xx | ≥ 500 | бэкофф |

Пагинация: `X-Total-Count`, `Link`; в MVP читаем только первую страницу (limit 50) и показываем «ещё N» ссылкой в Gitea.
