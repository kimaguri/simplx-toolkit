# Contract: страница дашборда

## Манифест / сборка
- Новая точка входа WXT `src/entrypoints/dashboard/index.html` → `dashboard.html` (unlisted page). Права манифеста **не добавляются** (`runtime.getContexts` без permissions).

## Кнопка в окне
- Шапка окна: ghost icon Button (lucide `ExternalLink`/`PanelTopOpen`), aria-label «Открыть во вкладке», рядом с кнопкой настроек → `openDashboard(section = текущая вкладка окна)` (R1) → `window.close()`.

## Маршруты
| Hash | Раздел / вид |
|---|---|
| `#/repos` | Репо (поиск, закреплённые — как в окне) |
| `#/prs` | PR, вид из `view` (`groups` по умолчанию, `table`) |
| `#/builds` | Сборки, вид `groups` (как в окне) или `history` |

## Сообщения
- Переиспользуются `refresh` (при открытии) и `popup-heartbeat` (каждые 5 с, пока страница видима). Новых сообщений нет.

## Запросы к Gitea (только GET, только история сборок)
- `GET /settings/api` → `max_response_items` (кэш 24 ч).
- A11/A12 из контракта 001 с `page`, `limit=max_response_items`, опц. `branch`, `event`, `actor`.

## Клавиатура
- Alt+1..3 — разделы; в таблицах ↑/↓ по строкам, Enter — открыть в Gitea; `/` — фокус в поиск.
