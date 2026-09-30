# Implementation Plan: Страница Gitea Dashboard во вкладке

**Branch**: `002-fullpage-dashboard` (git без коммитов) | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-fullpage-dashboard/spec.md`

## Summary

Новая страница расширения `dashboard.html` (открывается кнопкой из окна, одна вкладка на браузер через `runtime.getContexts`), hash-маршруты Репо/PR/Сборки, те же данные из снимка фичи 001; таблица PR на каноническом shadcn data-table (TanStack Table) с фильтрами в адресе; история сборок — постраничное чтение runs API (фильтра по дате в Gitea нет) с кэшем 5 мин и клиентской статистикой. Только чтение, новых прав манифеста нет.

## Technical Context

**Language/Version**: TypeScript 5.9 strict, Node 22
**Primary Dependencies**: как в 001 (WXT 0.21, React 19, Tailwind v4, shadcn/ui канон, lucide, sonner) + `@tanstack/react-table`; новые shadcn-компоненты: table, dropdown-menu, popover, command, toggle-group
**Storage**: storage.local — кэш истории `runsHistory:*`, расширение `ui`
**Testing**: Vitest + fakeBrowser + @testing-library/react; скриншоты Playwright (`pnpm screenshots`)
**Target Platform**: Chrome ≥ 116 (`runtime.getContexts`)
**Project Type**: браузерное расширение (single project), новая точка входа
**Performance Goals**: данные на странице < 1 с после кнопки (SC-101); фильтр 200 PR < 0,2 с (SC-106); история 7 дн < 3 с (SC-107)
**Constraints**: только GET; история ≤ 20 запросов на первую загрузку; окно ≤ 400 КБ (страница — отдельный бандл, не должна раздуть окно); без новых permissions
**Scale/Scope**: до 200 PR, до ~2000 запусков на источник за 30 дн

## Constitution Check

Конституция — незаполненный шаблон; проверка по правилам 001 (plan 001 «Constitution Check»):

| Правило | Как соблюдено | Статус |
|---|---|---|
| Только чтение | история — только GET; новых действий нет (FR-108) | PASS |
| Ноль внешнего трафика | запросы только к инстансу; зависимости бандлятся | PASS |
| Токен только local | страница использует общий клиент/хранилище 001 | PASS |
| Минимальные права | права манифеста не добавляются (R1) | PASS |
| Тест до кода, проверка стыков | tasks.md test-first + интеграционный тест кнопка→вкладка, heartbeat окно+страница, скриншоты | PASS |
| Канон shadcn, русский | FR-107, data-table по канону | PASS |

## Project Structure

### Documentation (this feature)

```text
specs/002-fullpage-dashboard/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/page-surface.md
├── checklists/requirements.md
└── tasks.md   # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── entrypoints/
│   ├── dashboard/{index.html,main.tsx,App.tsx}   # новая страница: шапка, навигация (sidebar ≥1024px / tabs ниже), outlet
│   └── popup/App.tsx                              # + кнопка «Открыть во вкладке»
├── background/open-dashboard.ts                   # openDashboard(section) через getContexts (вызывается из окна напрямую)
├── features/                                      # тела разделов, общие для окна и страницы (density)
│   ├── repos/ReposSection.tsx
│   ├── prs/{PrsGroups.tsx,PrsTable.tsx,prs-columns.tsx,PrsFilters.tsx}
│   └── builds/{BuildsGroups.tsx,BuildsHistory.tsx,HistoryStats.tsx,HistoryFilters.tsx}
├── domain/
│   ├── route.ts            # parse/serialize hash ↔ PageRoute + фильтры
│   ├── pr-filter.ts        # фильтр/поиск/сортировка PR (чистые)
│   └── history.ts          # слияние страниц, отсечение по периоду, RunStats
├── background/…            # без изменений логики; heartbeat общий
├── api/endpoints.ts        # + apiSettings(), runs с page/limit/branch/event/actor
├── lib/storage.ts          # + runsHistory cache, ui.lastPageSection/prView/buildsView
└── components/ui/          # + table, dropdown-menu, popover, command, toggle-group (shadcn CLI, правило 15 брифа)
tests/unit/{route,pr-filter,history}.test.ts, tests/unit/{dashboard-app,prs-table,builds-history}.test.tsx, tests/integration/{open-dashboard,history-fetch}.test.ts
```

**Structure Decision**: тела разделов выносятся в `src/features/*` и используются окном (compact) и страницей (comfortable) — одна реализация, SC-103 гарантирован. Окно после выноса должно пройти все свои тесты без изменений утверждений.

## Этапы и оценка

| Этап | Содержание | Оценка |
|---|---|---|
| 1 | Вынос разделов в features/ (окно без изменений), точка входа dashboard, маршруты, кнопка + openDashboard, heartbeat страницы | 1 день |
| 2 | Таблица PR (data-table, фасетные фильтры, поиск, сортировка, адрес) | 1 день |
| 3 | История сборок (постраничная загрузка, кэш, статистика, фильтры, «показать ещё») | 1,5 дня |
| 4 | Скриншоты страницы, ревью стыков, README | 0,5 дня |

## Риски

| Риск | Митигирование |
|---|---|
| Вынос разделов ломает окно | вынос — отдельная задача, критерий: все тесты окна зелёные без изменения утверждений |
| Общий чанк раздует окно > 400 КБ | TanStack Table/Command импортируются только страницей; check-size на окно в каждой задаче |
| 30 дней не влезают в 20 запросов при активном CI | «показать ещё» + честная пометка «период покрыт до ДД.ММ» |
| `runtime.getContexts` недоступен (< Chrome 116) | фолбэк `tabs.create` без дедупликации |

## Complexity Tracking

Нарушений нет.
