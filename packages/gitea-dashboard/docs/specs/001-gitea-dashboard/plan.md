# Implementation Plan: Gitea Dashboard

**Branch**: `001-gitea-dashboard` (git ещё без коммитов) | **Date**: 2026-09-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-gitea-dashboard/spec.md`

## Summary

Chrome-расширение MV3 без своего сервера: окно с тремя разделами (Репо / PR / Сборки), страница настроек, фоновый опрос в service worker, бейдж, системные уведомления, omnibox `gt`. Данные — только чтение Gitea API (≥ 1.25 для сборок) по личному токену. Ключевые решения (research.md): сборки по организациям одним запросом `/orgs/{org}/actions/runs` (доступно участнику), активные — одним запросом с повторяемым `status`; статус CI по `total_count`, а не `state`; head sha из списка PR репо; окно рендерит снимок из `storage.local` мгновенно, фон обновляет. Стек: TypeScript + WXT + Preact + Vitest.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 22 для сборки

**Primary Dependencies**: WXT 0.21 (сборка MV3, манифест, `_locales`, zip), **React 19 + `@wxt-dev/module-react`**, **Tailwind CSS v4 + shadcn/ui (канон, style new-york, base color neutral, CSS variables) + Radix + lucide-react + sonner**. (Rev.3 2026-09-28: Preact и самописный CSS заменены по решению владельца.) Никаких HTTP-клиентов и date-библиотек.

**Storage**: `chrome.storage.sync` (настройки, закреплённые), `chrome.storage.local` (токен, снимок, кэши, история уведомлений) — см. data-model.md

**Testing**: Vitest + `WxtVitest()` + `fakeBrowser`; фикстуры ответов Gitea (снятые с v1.27.3 по форме swagger) для клиента; `@testing-library/preact` для окна (выборочно); ручной e2e по quickstart.md

**Target Platform**: Chrome ≥ 120 (desktop; `alarms` ≥ 30 с), совместимые Chromium

**Project Type**: браузерное расширение (single project)

**Performance Goals**: окно показывает снимок < 100 мс (SC-002); первый полный цикл < 5 с (SC-001); ≤ 20 запросов/мин в org-режиме (SC-009)

**Constraints**: бандл окна ≤ 300 КБ (SC-010, ожидаемо 180–240 КБ с React + shadcn); ≤ 4 параллельных запроса; только GET; токен только в `storage.local`; без внешних URL кроме инстанса; CSP MV3 по умолчанию

**Scale/Scope**: 1 инстанс, 1–3 организации, до ~100 репо, до ~200 открытых PR, до ~200 запусков в окне 24 ч; 2 экрана + фон

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` — незаполненный шаблон: формальных ворот нет. Проверка по нефункциональным правилам ТЗ/спеки:

| Правило | Где соблюдено | Статус |
|---|---|---|
| Только чтение (FR-005) | contracts/gitea-api.md — только GET; клиент не экспортирует методы кроме `get` | PASS |
| Ноль внешнего трафика (FR-006) | зависимости бандлятся, нет CDN/аналитики; fetch только к `baseUrl` (проверка в клиенте) | PASS |
| Токен только local, не в логах (FR-003) | data-model: `token:<id>` в local; ошибки без заголовков; тест «токен не в sync/логах» | PASS |
| Минимальные права хоста (FR-004) | extension-surface: `host_permissions` пуст, запрос `origin/*` по клику | PASS |
| Деградация без сборок (FR-033) | `capabilities.actions` + независимые циклы PR и сборок | PASS |
| Тесты до кода | tasks.md будет test-first для клиента, маппинга, дедупа, бейджа | PASS (обязательство) |

Повторная проверка после Phase 1: нарушений нет, Complexity Tracking пуст. Рекомендация: зафиксировать эти правила в конституции (`/speckit-constitution`) до `/speckit-tasks`.

## Project Structure

### Documentation (this feature)

```text
specs/001-gitea-dashboard/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── gitea-api.md
│   └── extension-surface.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
wxt.config.ts            # манифест: permissions, optional_host_permissions, commands, omnibox, default_locale
package.json             # version → manifest.version (FR-075)
public/
├── _locales/ru/messages.json
├── _locales/en/messages.json   # заготовка
└── icon/*.png
src/
├── entrypoints/
│   ├── background.ts          # alarms, сообщения, omnibox, notifications.onClicked
│   ├── popup/                 # index.html, main.tsx, App.tsx, tabs/{Repos,Prs,Builds}.tsx
│   └── options/               # index.html, main.tsx, Options.tsx (подключение, настройки, охват)
├── api/
│   ├── client.ts              # fetch-обёртка: база, токен, таймаут, пул ≤4, ошибки → kind
│   ├── endpoints.ts           # A1–A14 из contracts/gitea-api.md (только GET)
│   └── types.ts               # сырые типы ответов Gitea (узкие, по используемым полям)
├── domain/
│   ├── runs.ts                # маппинг статусов, workflow из path, mine/group, длительность
│   ├── prs.ts                 # группировка review/mine/other, слияние head/ci
│   ├── ci.ts                  # combined status → CiStatus (total_count)
│   ├── badge.ts               # число и цвет по Settings/Snapshot
│   ├── notify.ts              # выбор событий, дедуп SeenEvents, окно, засев
│   └── scope.ts               # охват: организации, исключения, includeRepos, запасной режим
├── background/
│   ├── poller/index.ts        # цикл, мьютекс, бэкофф, пауза по 401, запись снимка (сохраняет прошлые данные при ошибке)
│   ├── poller/prs.ts          # PR → heads → статусы
│   ├── poller/runs.ts         # сборки org/repo, «мои», workflows
│   ├── poller/notes.ts        # notifications API
│   ├── poller/badge.ts        # badgeFor → action.setBadge*
│   ├── schedule.ts            # alarms base/fast, heartbeat окна
│   └── connection.ts          # проверка подключения → ConnectionReport
├── lib/
│   ├── storage.ts             # типизированные ключи sync/local, instanceId
│   ├── i18n.ts                # t(key, subs) над chrome.i18n
│   └── time.ts                # относительное время, длительность
└── ui/                        # общие компоненты окна: List, StatusIcon, Empty, ErrorState, theme.css
tests/
├── fixtures/                  # JSON-ответы Gitea v1.27.3
├── unit/                      # domain/*, api/client
└── integration/               # poller + fakeBrowser: снимок, бейдж, уведомления, деградация
.gitea/workflows/release.yml   # тег v* → test → zip → вложение в релиз (FR-075)
README.md                      # установка, права токена, оценка нагрузки (SC-009)
```

**Structure Decision**: один проект; чистая логика в `src/domain` без `chrome.*` (тестируется без браузера), побочные эффекты — в `background/` и `api/`. Опрос разбит на секции `src/background/poller/{index,prs,runs,notes,badge}.ts`, чтобы параллельные задачи не правили один файл. Окно и настройки общаются с фоном через `storage` + 4 сообщения (contracts/extension-surface.md). **Исключение**: поиск репозиториев в окне и omnibox вызывают клиент напрямую (интерактивный ввод, без очереди фона), читая токен из `storage.local` — только GET, тот же клиент.

## Поставка по этапам (ТЗ §7) и трудоёмкость

| Этап | Содержание | FR/US | Оценка |
|---|---|---|---|
| 0. Каркас | WXT+Preact+Vitest, манифест, `_locales`, CI-релиз | FR-073..075 | 0,5 дня |
| 1. MVP | клиент, подключение и диагностика, Репо (поиск, pin, клавиши, omnibox), PR (группы, статусы CI, конфликты), бейдж «ревью», снимок | US1–US3 | 2,5–3 дня |
| 2. Сборки | runs org/repo, группы «мои/остальные», тикающая длительность, фон base/fast, бэкофф, уведомления падение/успех/ревью, красный бейдж | US4–US5 | 2 дня |
| 3. Полировка | охват и исключения в настройках, notifications API (комментарии), тёмная тема, локализация всех строк, README с нагрузкой | US6, FR-060 комм., FR-073 | 1,5 дня |
| | **Итого** | | **≈ 6–6,5 дня** |

## Риски

| Риск | Вероятность | Митигирование |
|---|---|---|
| Живое поведение инстанса расходится с исходниками (права, индексатор) | средняя | первая задача — пробы личным токеном (research, остаточные риски) |
| Дубли/пропуски уведомлений при гонках alarm + heartbeat | средняя | один мьютекс цикла; ключ `seen` пишется до показа; интеграционные тесты |
| Service worker засыпает посреди цикла | низкая | цикл < 30 с, состояние только в storage, идемпотентность |
| Preact в WXT без официального модуля | низкая | preset-vite + алиасы, проверка на каркасе |
| Шум «Остальных» при массовых перезапусках | известен | свёрнутая группа, бейдж только по «моим» |
| Нет раннера/места для релизного workflow | средняя | ручной `pnpm zip` + загрузка релиза как запасной путь |

## Complexity Tracking

Нарушений нет.
