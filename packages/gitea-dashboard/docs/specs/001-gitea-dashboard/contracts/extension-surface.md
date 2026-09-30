# Contract: поверхность расширения

## Manifest (MV3)

| Ключ | Значение | Требование |
|---|---|---|
| `permissions` | `storage`, `alarms`, `notifications` | FR-040, FR-060 |
| `host_permissions` | — (пусто) | FR-004 |
| `optional_host_permissions` | `https://*/*`, `http://*/*` | запрашивается ровно `<origin>/*` инстанса при сохранении настроек |
| `action` | popup `popup.html`, `default_title` из `_locales` | |
| `commands` | `_execute_action`: `Alt+G` (mac: `Alt+G`) | FR-074 |
| `omnibox.keyword` | `gt` | FR-015 |
| `options_ui` | `options.html`, `open_in_tab: true` | |
| `default_locale` | `ru` | FR-073 |
| `content_security_policy` | по умолчанию MV3 (без `unsafe-eval`) | FR-006 |

Никаких `content_scripts`, `web_accessible_resources`, `externally_connectable`.

## Сообщения окно/настройки → фон (`runtime.sendMessage`)

| `type` | payload | ответ | Назначение |
|---|---|---|---|
| `refresh` | `{ reason: 'popup-open' \| 'manual' }` | `{ ok: true }` | внеочередной опрос; ответ сразу, данные придут через `storage.onChanged` |
| `popup-heartbeat` | `{}` | `{ fastSec: 15..20 }` | пока окно открыто, фон держит сборки в режиме 15–20 с |
| `check-connection` | `{ baseUrl, token }` | `ConnectionReport` | FR-001; токен в ответе не возвращается |
| `settings-changed` | `{}` | `{ ok: true }` | перепланировать alarms, пересчитать бейдж |

`ConnectionReport = { ok, kind?: 'bad-url' | 'unreachable' | 'auth' | 'scope' | 'not-gitea', login?, version?, actions: Capabilities['actions'], missingScopes: string[], messageKey }`
(`messageKey` — ключ `_locales` для текста диагностики).

Окно данные читает **из storage** (`snapshot:*`), а не из ответа на сообщение — поэтому показ < 100 мс не зависит от фона.

**Исключение**: поиск репозиториев (окно, omnibox) вызывает клиент напрямую — только A4 (GET), токен из `storage.local`.

## Словарь ошибок

| Слой | Значения | Маппинг |
|---|---|---|
| `ApiError.kind` (клиент) | `unreachable, auth, forbidden, not-found, server, not-json` | — |
| `Snapshot.error.kind` | `network, auth, forbidden, server` | `unreachable→network`, `not-json→server`, `not-found→server` |
| `ConnectionReport.kind` | `bad-url, unreachable, auth, scope, not-gitea` | невалидный URL до запроса → `bad-url`; `forbidden→scope`; `not-json→not-gitea`; `not-found→not-gitea` (адрес ведёт не на API Gitea); `server→unreachable`; `unreachable`, `auth` без изменений |

## Alarms

| Имя | Период | Что делает |
|---|---|---|
| `poll` | `pollIntervalSec/60` мин (≥ 0.5) | полный цикл: PR, сборки, статусы, бейдж, уведомления |
| `poll-fast` | 0.5 мин, только в режиме `fast` | только сборки |

## Уведомления

`notificationId` = ключ события из `SeenEvents` (`fail:…`, `ok:…`, `review:…`, `note:…`). По `notifications.onClicked` фон берёт URL из `storage.local` (`notifUrl:<id>`, TTL 24 ч), открывает вкладку и закрывает уведомление (FR-063).

## Omnibox

`gt <запрос>` → до 6 подсказок `owner/name` (закреплённые + поиск, дебаунс 200 мс). Enter по подсказке → репозиторий; Enter по сырому тексту → первая подсказка, иначе страница поиска Gitea `/explore/repos?q=`.

## Клавиатура окна (раздел «Репо»)

`↑/↓` — выделение; `Enter` — репо; `Ctrl/Cmd+Enter` — `/pulls`; `Shift+Enter` — `/actions`; `Ctrl/Cmd+P` на выделенном — закрепить/открепить. Табы разделов: `Alt+1..3`.
