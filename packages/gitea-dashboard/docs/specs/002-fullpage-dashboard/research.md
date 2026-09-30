# Research: 002 — страница дашборда во вкладке

Опирается на research фичи 001 (Gitea 1.27.3, исходники + swagger `docs/swagger-1.27.3.json`).

## R1. Одна вкладка дашборда без дублей
- **Decision**: `chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [getURL('/dashboard.html')] })` (Chrome ≥ 116) → если есть контекст, `tabs.update(tabId, {active:true})` + `windows.update(windowId, {focused:true})`; иначе `tabs.create({ url: getURL('/dashboard.html#/prs') })`. Сравнение по URL без hash. Окно закрывается `window.close()`.
- **Rationale**: не нужны права `tabs` и host на `chrome-extension://`; работает для всех окон браузера.
- **Alternatives**: `tabs.query({url})` — требует permission `tabs` для URL расширения; хранить tabId в storage — ломается при перезапуске/закрытии.

## R2. Маршрутизация страницы
- **Decision**: hash-маршруты `#/repos`, `#/prs?view=table&repo=a/b&author=x&ci=failure&draft=only&sort=updated:desc&q=...`, `#/builds?view=history&period=7d&wf=ci.yml&branch=main&...` — свой маленький парсер/сериализатор на `URLSearchParams`, без роутер-библиотеки.
- **Rationale**: 3 раздела + состояние фильтров; hash не требует настроек сервера (страница из `chrome-extension://`), работают «назад», обновление, закладки.
- **Alternatives**: TanStack Router / react-router — лишний вес и API ради 3 маршрутов.

## R3. Таблицы
- **Decision**: канонический shadcn data-table: `@tanstack/react-table` + shadcn `table`, `dropdown-menu`, `popover`, `command`, `toggle-group`, `input` (фасетные фильтры как в примере shadcn «Tasks»).
- **Rationale**: канон shadcn для таблиц (требование FR-107), сортировка/фильтрация клиентская — 200 PR фильтруются < 1 мс.
- **Alternatives**: свой `<table>` — хуже канона; AG Grid — тяжело и не shadcn.

## R4. Данные таблицы PR
- **Decision**: из уже существующего снимка `snapshot.prs` (фича 001: группа, CI, черновик, конфликт, автор, updatedAt). Новых запросов нет.
- **Ограничение**: снимок хранит до 50 PR на группу (`prTotals` > показанных → строка «показаны N из M, остальное в Gitea»).

## R5. История сборок за 24 ч / 7 дн / 30 дн
- **Факты API** (swagger 1.27.3): `/orgs/{org}/actions/runs` и `/repos/{o}/{r}/actions/runs` — фильтры `event, branch, status, actor, head_sha, page, limit`; **фильтра по дате нет**; порядок `id DESC`; `limit` ограничен `max_response_items` (по умолчанию 50, читается `GET /settings/api`).
- **Decision**: для каждого источника охвата (организации из capabilities + закреплённые/добавленные репо вне организаций, по правилам `src/domain/scope.ts`) читать страницы по `limit=max_response_items` от новых к старым, пока `started_at` последнего запуска на странице не станет старше начала периода или не исчерпан бюджет. Бюджет первой загрузки: **≤ 20 запросов** (FR-112); если период не покрыт — «показать ещё» догружает следующие страницы (по 5 запросов). Серверные фильтры `branch`/`event`/`actor` передаются, когда выбран ровно один вариант (уменьшает объём); остальные фильтры — на клиенте.
- **Кэш**: `storage.local` `runsHistory:<instanceId>:<sourceKey>` = `{fetchedAt, runs[], oldestPage, exhausted}`; TTL 5 минут; повторное открытие периода в TTL — ноль запросов; периоды пересекаются — 30 дн переиспользует страницы 7 дн.
- **Rationale**: единственный путь в API; клиентская агрегация дешёвая.
- **Alternatives**: `/admin/actions/runs` — только админ; webhook/свой сервер — против «без бэкенда».

## R6. Статистика
- **Decision**: чистые функции в `src/domain/history.ts`: число, доля `failure` среди завершённых (success+failure+cancelled; skipped исключаются), средняя и медианная длительность завершённых (`completedAt − startedAt`, отбрасывая пустые/нулевые времена), разбивка по workflow. Мои = правило `mine` из 001.

## R7. Живое обновление на странице
- **Decision**: страница шлёт то же сообщение `popup-heartbeat` каждые 5 с, пока видима (`document.visibilityState === 'visible'`); фоновый heartbeat-цикл общий → окно + страница не удваивают запросы (один таймер в фоне).
- **Rationale**: SC-104 без нового механизма.

## R8. Переиспользование UI
- **Decision**: вынести из `src/entrypoints/popup/tabs/*` тела разделов в `src/features/{repos,prs,builds}/*` с пропом `density: 'compact' | 'comfortable'`; окно использует `compact`, страница — `comfortable`. Поведение и тесты окна не меняются.
- **Alternatives**: копировать компоненты — рассинхрон окна и страницы (нарушает SC-103).

## R9. Этап сборки (rev.2)
- **Факты API** (swagger 1.27.3): `GET /repos/{o}/{r}/actions/runs/{run}/jobs` → jobs `{id, name, status, conclusion, started_at, completed_at, steps[{number, name, status, conclusion, started_at, completed_at}]}` (+ `page, limit`).
- **Decision**: загрузчик `src/features/builds/run-jobs.ts`: для видимых выполняющихся запусков (не более 10, приоритет — мои) раз в цикл сердцебиения страницы; кэш в памяти страницы по `runId:attempt` (завершённые не перезапрашиваются). Текущий шаг = первый job/шаг со статусом in_progress, иначе первый queued/waiting. Раскрытие строки — shadcn Collapsible внутри таблицы (строка-деталь на всю ширину). Окно расширения не затрагивается.
- **Alternatives**: логи шагов — вне объёма (FR «логи» отложены); фоновая загрузка шагов для всех запусков — лишняя нагрузка.

## R10. Теги (rev.2)
- **Decision**: `src/domain/labels.ts`: `repoLabel(fullName, allRepoNames)` (имя без владельца, владелец только при коллизии), `repoColor(fullName)` — индекс палитры по стабильному хэшу (8 цветов Tailwind с парами light/dark, по канону Badge variant="outline" + цветной фон 10%), `branchTone(branch)` — main/master → blue, test → amber, иначе neutral.

## R11. Сворачиваемая панель (rev.2)
- **Decision**: канонический shadcn `sidebar` (collapsible="icon", SidebarProvider/SidebarTrigger/SidebarRail, подсказки на иконках), состояние — в `ui.sidebarOpen` (storage) вместо cookie shadcn.
