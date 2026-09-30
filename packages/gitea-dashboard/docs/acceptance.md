# Приёмка

## Аудит состояний (T058)

Аудит пустых/ошибочных/устаревших состояний `src/entrypoints/popup/App.tsx` и
`src/entrypoints/popup/tabs/{Repos,Prs,Builds}.tsx` против блока «Edge Cases»
`specs/001-gitea-dashboard/spec.md`, FR-042, FR-072. Для каждого пункта —
существующий тест (если уже был покрыт) либо новый тест в
`tests/unit/popup-states.test.tsx` (если был пробел), и был ли потребован
фикс в коде.

| Edge case (spec.md) | Покрытие | Фикс |
|---|---|---|
| Токен отозван/истёк → все разделы «токен недействителен» | Уже было: `popup-app.test.tsx` → «shows an auth ErrorState instead of tab content in every tab» | Нет |
| Gitea недоступен → показываются последние данные + «данные на ЧЧ:ММ, нет связи», а не пустые разделы | Частично было (`popup-app.test.tsx` → «renders Stale...»), пробел — что данные (не только баннер) остаются видны. Добавлено: `popup-states.test.tsx` → «keeps showing PR tab content ... alongside the Stale banner on a network error» | Нет, поведение уже верное |
| Токену не хватает одного права → деградирует только связанная функция, диагностика называет право | Право `notifications`/`missingScopes` — экрана в попапе для уведомлений нет (это фоновая функция, покрыта `options-scope.test.tsx`, `scope.test.ts`, `connection.test.ts`). Для попапа применимо к `capabilities.actions` (Сборки): добавлено `popup-states.test.tsx` → «shows a forbidden ErrorState only in Builds while Repos/PRs keep working» | Нет |
| Workflow без имени, запуск без ветки/по расписанию/тегу — элемент читаем | Пробел — не было теста на пустые `workflow`/`branch`. Добавлено: `popup-states.test.tsx` → «renders a manual/scheduled run with no branch as a dash» | Нет, `run.branch \|\| '—'` уже правильно обрабатывал случай |
| Перезапуск упавшей сборки — новая попытка даёт новое уведомление, повторный рестарт той же попытки — нет | Не относится к попапу (дедупликация уведомлений — фоновая логика, `tests/integration/*` уведомлений/schedule) | Нет (вне файлов этой задачи) |
| PR из форка, без проверок, черновик — статус CI «нет проверок», признак черновика | Черновик/конфликт по отдельности были в `prs-tab.test.tsx`; пробел — комбинация draft+`ci.state:'none'` вместе. Добавлено: `popup-states.test.tsx` → «shows a draft PR with no CI checks with both the draft badge and the "no checks" status» | Нет |
| Много PR/репозиториев — окно отзывчиво, списки скроллятся внутри раздела | Пробел — не было прямой проверки инлайн-скролла `List`. Добавлено: `popup-states.test.tsx` → «caps the visible list height and scrolls internally instead of growing unbounded» (50 запусков, `overflowY:auto`+`maxHeight`) | Нет, `ui/List.tsx` уже задаёт `maxHeight`/`overflowY` |
| Окно открыто долго — тикает длительность, обновляется, нет утечек/зависаний | Частично было (`builds-tab.test.tsx`: очистка тикающего интервала и heartbeat по unmount). Пробел — не было проверки на уровне `App` за длинный период (30 минут) и баланса подписчиков `storage.onChanged`. Добавлено: `popup-states.test.tsx` → «keeps the active timer count bounded over 30 minutes and returns to 0 after unmount; storage.onChanged listeners balance on unmount» | Нет, счётчик таймеров ограничен (≤2 одновременно: тик 1с + heartbeat 5с), после unmount = 0, `addListener`/`removeListener` сбалансированы |
| Браузер был закрыт несколько часов — при старте не должно быть уведомлений о давних событиях | Не относится к попапу (FR-062, фоновая логика окна «недавних» — `tests/integration/schedule.test.ts` и т.п.) | Нет (вне файлов этой задачи) |
| Смена адреса Gitea или токена — кэш/история уведомлений не смешиваются | Пробел на уровне попапа — не было теста, что при смене активного инстанса не подмешиваются старые данные. Добавлено: `popup-states.test.tsx` → «shows only the newly active instance's snapshot after the connection changes, never the previous one's» | Нет, `snapshot:<id>`/`getSnapshot(activeInstanceId)` уже изолированы по инстансу |
| (Ревью-заметка) `App.tsx` `configured` по умолчанию `true` (оптимистично) → разделы мигают до проверки «не настроено» | Пробел, реальный дефект. RED: `popup-states.test.tsx` → «renders no tabs and no "unconfigured" message while ... in flight» (оба сценария — настроенный и ненастроенный инстанс) — падали на `true`-заглушке, показывающей вкладки сразу | **Да** — `configured` переведён в три состояния `'loading' \| 'configured' \| 'unconfigured'`; пока `'loading'`, рендерится нейтральный `<div />` (ни вкладки, ни экран «не настроено») |

### Изменённые файлы

- `src/entrypoints/popup/App.tsx` — `configured` → tri-state, нейтральный рендер во время загрузки.
- `tests/unit/popup-states.test.tsx` — новый файл, 9 тестов (см. таблицу выше).

### Прогон

- `./node_modules/.bin/vitest run` — 33 файла, 367 тестов, всё зелено.
- `./node_modules/.bin/wxt prepare && ./node_modules/.bin/tsc --noEmit` — без ошибок.
- `./node_modules/.bin/wxt build` — сборка успешна, суммарный размер 123.18 kB (лимит SC-010 — 300 KB).
