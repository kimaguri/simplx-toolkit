# SimplX meta — how it is shaped and what each key does

Meta = JSON describing tenant applications: entities (CRUD or plugin), their fields, list/detail views, routes, quick actions. It lives in the platform DB (`entity_meta` per entity, `app_meta` per app, `meta_templates` for shared templates) and is edited through the `meta.*` tools. **A write is publication.** There are no TS files, no export, no push any more.

## Addressing

- `tenant` — tenant id (uuid), from `meta.list_apps` or the operator.
- `app` — app name inside the tenant (usually the tenant's slug: `intellhouse`, `helpdev`, `koreana`).
- `entity` — `entityName` (`contracts`, `contacts`, ...).
- `templateKey` — a system template (`contracts`, `contacts`, `deals`, ...), tenant-less.

## Entity config (what `meta.get_entity` returns as `raw`)

```jsonc
{
  "entityName": "contracts",
  "displayName": "Договор",            // singular, used as fallback for the menu label
  "displayNamePlural": "Договоры",
  "basedOn": "contracts",              // optional: inherit a template; then raw holds only overrides
  "fields": {
    "form": { "fields": [FieldConfig...], "markup": [["name"], ["type", "owner_id"]], "relationBindings": {...} },
    "table": [FieldConfig...],          // list columns
    "createVariants": [...], "titleResolvers": {...}
  },
  "constants": {
    "labels": { "singular": "Договор", "plural": "Договоры", "genitive": "договора", "accusative": "договор", "create": "Создать договор", "edit": "Редактировать договор" },
    "quickActions": [QuickAction...],
    "dropdownFilters": [...],
    "foreignTables": ["_employee_owner:owner_id"]
  },
  "views": {
    "list": { "type": "table_universal", "tableColumns": { "$ref": "#/fields/table" }, "modalFields": { "$ref": "#/fields/form/fields" }, "isSearchEnabled": true, "quickSearchFields": ["name"], "dropdownFilters": { "$ref": "#/constants/dropdownFilters" }, "initialSorter": { "created_at": "descend" }, "pageSize": 20 },
    "detail": { "layout": "classic", "sections": [ISectionMeta...] },
    "quickActions": { "$ref": "#/constants/quickActions" }
  },
  "routeConfig": { "path": "/contracts", "icon": "FileText", "navKey": "nav.contracts", "sortOrder": 9, "hideInMenu": false },
  "search": { "enabled": true },
  "plugin": PluginEntityConfig          // instead of fields/views: a plugin screen replaces the CRUD
}
```

**Sidebar rule.** An entity appears in the sidebar when it has `fields`+`views` (CRUD) **or** a `plugin` block, and `routeConfig.hideInMenu` is not true. The label is `t(routeConfig.navKey)` when that translation exists, otherwise `displayName`. `hidden` / `hideFromNav` are dead keys — the renderer ignores them.

**Names on screen.** `displayName` — record/tab titles and the menu fallback; `constants.labels.plural` — list heading; `labels.create/edit` — modal titles; `labels.genitive/accusative` — sentences ("удалить договор").

## Templates and inheritance (`basedOn` + overrides)

- `basedOn: "<templateKey>"` — the entity inherits the template's whole config. Its own `raw` keeps only what differs; `resolved` is template + overrides.
- Overrides **change and add** keys. They cannot **delete** an inherited key (`null` stores `null`); an entity that must not have a template field should not inherit that template.
- Objects merge key by key; **arrays replace wholesale** (`fields.table`, `sections`, `quickActions` — send the full array).
- Editing a template changes every dependent entity in every tenant: `meta.template_dependents` first, pass the count as `acknowledgedDependents`.
- `unresolvedOverrides` in a write answer = an override path that matched nothing in the template. It is stored but has no effect — usually a typo.

## `$ref` — reuse inside and across entities

- Local: `{ "$ref": "#/fields/table" }`, `#/fields/form/fields`, `#/fields/form/markup`, `#/constants/quickActions`, `#/constants/dropdownFilters`.
- Cross-entity: `{ "$ref": "contacts.fields.table" }`, `activities.fields.form.fields`, `contacts.constants.dropdownFilters`.
- With overrides: `{ "$ref": "activities.fields.form.fields", "overrides": { "[dataIndex=lead_id]": { "preDefault": { "type": "parentId" } } } }` — `[key=value]` addresses an array element.
- `$ref` lives where content is consumed (`views.*`, `sections[]`, `modalFields`), never inside `fields`/`constants` themselves. Cycles are refused (max depth 10).

## Fields (FieldConfig, short)

`dataIndex` (column or `["_alias", "col"]` for a joined table), `title`, `valueType`, `required`, `hidden` (`true | "form" | "table" | "all"`), `width`, `rules`, `fieldProps` (`disabled`, `format`, `min`, `precision`, `placeholder`...), `preDefault`, `conditions` + `dependencies`, `sorter`, `searchable`, `drilldownResource`/`drilldownPath`.

Data sources by valueType: `dictionary` → `dictionaryName`; `select` → `resource` + `labelField`/`valueField`; `relation` → `relation: { name, resource, role? }` + `selection`; `funnel` → `action: { code: "funnel.move", params: { entity_type } }`; `tags` → `fieldProps.tokenSeparators`.

Joined data: `foreignTables: ["_employee_owner:owner_id"]` on the section/list, then `dataIndex: ["_employee_owner", "full_name"]`.

Conditions: `dependencies: ["type"]` + `conditions: { hidden: { field: "type", notEquals: "legal_entity" }, required: {...}, disabled: {...}, label: { default, when, then } }`. Condition forms: `equals, notEquals, in, notIn, isEmpty, isNotEmpty, greaterThan, lessThan, matches, contains, and, or, not`.

Defaults: `preDefault: { type: "parentId" | "currentDate" | "userId" | "employeeId" | "staticValue" (value) | "configParameter" (value) | "record" (targetField) | "select" (by, equals, operator?) }`.

## Зависимые поля: три механизма

Три разных инструмента, не взаимозаменяемые — не путать их между собой.

1. **`dependsOn`** — каскад для `select`/`dictionary`: сужает варианты дочернего поля по значению родительского (пример: `city` зависит от `country`). Работает только на выбор опций, не трогает `hidden`/`required`/`label`.
2. **`dependencies` + `conditions`** — реактивное поведение поля от значений других полей формы: `hidden`, `required`, `disabled`, `label`, `fieldProps` меняются по условию (`Condition`: `equals`, `notEquals`, `in`, `and`, `or`, `not`, ...). `dependencies: ["type"]` регистрирует, какие поля форма должна отслеживать — без него условие не пересчитается при изменении driving-поля.
3. **`ValueSource`** — новый источник значения `{ valueFrom, dict?, pick? }`. Принимается только в `conditions.label` и как значение первого уровня `conditions.fieldProps.*` (т.е. один ключ `fieldProps` может быть объектом `{ valueFrom, ... }`; вложенные объекты внутри значения не проверяются и ValueSource'ом не считаются). **Не** принимается в `conditions.title`, в `then`/`default` условного значения, в `cases[].then`. Причина: платформа валидирует Ajv по сгенерированной JSON Schema (бюджет 500 КБ, `$refStrategy: none`) — правила структурные, расширять их на каждое поле было бы слишком дорого. Колоночный `format` (таблицы) — отдельный DSL, который уже принимал `valueFrom` как строку (в т.ч. `parent.currency`) и это не меняется.

```ts
/** Значение свойства берётся из другого поля той же формы (или строки таблицы). */
interface ValueSource {
  /** Имя поля; путь через точку для подгруженных связей (`_client.full_name`);
   *  префикс `parent.` — поле родительской записи вложенной таблицы. Непустая строка. */
  valueFrom: string
  /** Имя словаря (`_s_dictionary.dictionary_name`), через который прогнать значение. */
  dict?: string
  /** Атрибут элемента словаря (`symbol`, `label`, `short`…). Только вместе с `dict`. */
  pick?: string
}
```

**Где резолвятся пути через точку.** Для строк таблицы (`foreignTables`) и колонок (`format`) доступны и подгруженные связи (`_client.full_name`), и `parent.<field>` — поле родительской записи вложенной секции. **В значениях формы** связи недоступны — только имена полей самой формы и `parent.*` (родительская запись передаётся модалке вложенной секции). Источник, который не резолвится (поле не найдено), даёт `undefined` — свойство просто не выставляется, ошибок нет.

Примеры (полный контракт — `meta-contract.md`):

```ts
// Сумма договора — валюта из соседнего поля формы
{ dataIndex: 'amount', valueType: 'money',
  dependencies: ['currency'],
  conditions: { fieldProps: { currency: { valueFrom: 'currency' } } } }

// Цена позиции в спецификации — валюта берётся у родительского договора
// (поля currency в форме позиции нет — доступ только через parent.)
{ dataIndex: 'unit_price', valueType: 'money',
  conditions: { fieldProps: { currency: { valueFrom: 'parent.currency' } } } }

// Колонка вложенной таблицы (спецификации) — символ валюты из родителя, через словарь
{ dataIndex: 'line_total', valueType: 'money',
  format: [{ valueFrom: 'line_total', as: 'number', digits: 2 }, ' ',
           { valueFrom: 'parent.currency', dict: 'currency', pick: 'symbol' }] }

// Подпись с единицей измерения — dict + pick без parent.
{ dataIndex: 'quantity', valueType: 'number',
  dependencies: ['unit'],
  conditions: { label: { valueFrom: 'unit', dict: 'units', pick: 'short' } } }
```

## Денежное поле (`valueType: 'money'`)

Форма:

```ts
fieldProps: {
  currency?: string | ValueSource   // код ISO; константа или источник (в т.ч. parent.)
  precision?: number                // по умолчанию 2
  min?: number
}
```

Таблица без `format`: `fieldProps.currencyField?: string` — имя колонки строки, где лежит код валюты. Если задан `format`, он имеет приоритет над `currency`/`currencyField`.

Порядок выбора валюты: явная (`currency` / `currencyField`) → валюта организации по умолчанию (`_s_settings general/currency`) → без символа, просто число. Символ валюты — атрибут `symbol` элемента словаря `currency` по коду; захардкоженного символа нет нигде.

## Detail sections (ISectionMeta, short)

`type` (see types resource), `title`, `area` (`left|center|right|top|bottom`), tables: `resource`, `appResource`, `tableColumns`, `modalFields`, `foreignTables`, `initialFilter`, `initialSorter`, `pageSize`; detail panels: `groups: [{ id, fields: { "$ref": ... } }]`, `editMode`; tabs container: `type: "tabs"`, `items: [...]`; custom: `type: "custom"`, `componentName`.

**Junction tab (M:N)** — `type: "table_universal"` with `meta.relation: { name: "<junction table>", resource }` is MANDATORY; without it the tab is empty. Writing the relation from a form: `fields.form.relationBindings: { assignees: { name: "activities_employees", resource: "employee" } }`.

## Quick actions

`{ type, label, icon, hotkey?, config? }` with `type` ∈ `attachment | note | delete | child_activity | relation | entity_relation | conversion | reminder`, plus `type: "custom"` which mounts a named component: `{ "type": "custom", "component": "RenewContractAction", "key": "renew", "label": "...", "icon": "..." }`. `label` and `icon` are required for every type.

## Plugin entities

```jsonc
"plugin": { "id": "timesheet", "source": "core", "config": {...},
  "views": [{ "key": "weekly", "label": "Неделя", "component": "TimeSheetApp", "appResource": "timesheet", "props": {...} }] }
```
Replaces the CRUD screen entirely. `component` names are registered by the plugin at runtime; the component list check does not cover them.

## Components you may reference

`componentName` (in a `custom` section) and quick-action `component` must name a component that exists in core-ui or a tenant plugin (`intellhouse/FinReportEditor`). `meta.validate` warns (`unknownComponents`) about a plain name it does not know; tenant-scoped names (`tenant/Name`) are never checked. You cannot create components through meta.

## App config (`meta.get_app` / `meta.write_app`)

`plugins: ["calendar"]`, `pluginConfigs: { calendar: {...} }`, `settings`, `notifications`, `menu: { items: [{ key, label, icon, children: [{ key, label, path }] }] }`. `menu` groups sidebar items into sections; the items themselves come from each entity's `routeConfig`.

## History and undo

Every write, delete and rollback records who (human id or `agent:mcp`), when, from which source (`mcp`, `admin_ui`, `promote`, `rollback`), the reason, and both configs. `meta.versions` lists it (newest first, `isSchemeBoundary` marks the old app-level numbering). `meta.rollback(targetVersionId, expectedVersion = current)` restores that content as a new version.

## Environments

The `test` profile has read and write tools; the `prod` profile has read tools only — production changes come from promoting test to prod, either by a human in the admin UI or, on the test profile, via `meta.promote_preview` / `meta.promote`. `meta.inventory` scans every active row of every tenant against the rules; read `tenantViolationCount`.

## Promotion (test profile only)

`meta.promote_preview` then `meta.promote` move one app, one entity, or one template from test to prod (`target`, default `"prod"`) — never available on the prod profile, and only on the tenant owner's explicit instruction. Address with EXACTLY one of two shapes: `tenantSlug` (not the tenant id other tools use) + `app`, optionally adding `entity` to promote just that entity instead of the whole app; OR `templateKey` alone — templates are cross-tenant, so `tenantSlug`/`app`/`entity` must all be absent when `templateKey` is given, never combined with it. Preview first: read `diff`, and confirm `templateStale` is `false` (`true` or `"missing"` means a dependency template needs promoting first — before any entity `basedOn` it). Then call `meta.promote` with `expectedTargetVersion` set to the preview's `targetVersion` exactly, `null` included (meaning no row exists on the target yet); a `version_conflict` means the target moved since the preview — re-preview, never retry blindly. There is no `acknowledgedDependents` field here — unlike `meta.write_template`, the platform recounts a template's dependents on the target itself as part of the promote call.

## Common mistakes

| Symptom | Cause |
|---|---|
| Entity missing from the sidebar | no `fields`+`views` and no `plugin`; or `hideInMenu: true` |
| Renamed, but the menu still shows the old name | `routeConfig.navKey` has a translation; change `navKey` or accept |
| Write refused: `labels` must have `singular` | partial `labels` object — send the whole object |
| Write refused: version_conflict | someone wrote in between — re-read, re-apply, write with the new version |
| Junction tab empty | `meta.relation.name` missing |
| Conditional field never hides | `dependencies` missing or the driving field is not in the form |
| Joined column empty | `foreignTables: ["_alias:fk"]` missing on the section |
| `$ref` unresolved | wrong path (`#/fields/table` local, `entity.fields.table` cross) or a cycle |
| `unresolvedOverrides` on a basedOn write | override path matches nothing in the template (typo) |
