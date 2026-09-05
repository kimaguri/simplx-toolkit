# SimplX Meta — Полный Type Reference

> **LAB-257:** мета живёт в БД и правится через инструменты `meta.*` этого сервера. типы ниже описывают ФОРМУ
> конфига — она не изменилась. Примеры кода, ссылающиеся на `apps/{tenant}/entities/`,
> `config.tsx`, `tabs.tsx` — это legacy source, больше не питающий БД тенанта; та же форма
> сегодня — это `raw`/`resolved` из `meta.get_entity` (MCP) или JSON в редакторе админки.

Источники истины (file:line):
- Zod-схемы: `simplx-apps/packages/meta/src/schemas/`
- Runtime-типы: `simplx-core/core-ui/src/app/app-meta-renderer/`
- Resolver: `simplx-apps/packages/meta/src/resolver/`

---

## AppMeta

`packages/meta/src/schemas/app-meta.schema.ts:96-100`
`simplx-core/core-ui/src/app/app-meta-renderer/types.ts:441-456`

```ts
interface AppMeta {
  name: string
  title: string
  description?: string | null
  version?: string | number
  entities: EntityMetadata[]
  customRoutes?: CustomRouteMeta[]
  menu?: AppMenuConfig
  plugins?: string[]
  pluginConfigs?: Record<string, unknown>
  theme?: 'light' | 'dark' | 'system'
  defaultLocale?: string
  supportedLocales?: string[]
  settings?: Record<string, unknown>
  [key: string]: unknown
}
```

---

## EntityMetadata (runtime, после резолва $ref)

Это runtime-форма, которую видит фронт после export+resolve. **В исходниках `apps/{tenant}/entities/{e}/config.tsx` пишем `RefEnabledEntityConfig`** (см. ниже), а не EntityMetadata.

`packages/meta/src/schemas/entity-meta.schema.ts:100-170`

```ts
interface EntityMetadata {
  entityName: string
  displayName: string
  displayNamePlural?: string | null
  description?: string | null

  fields?: {
    form?: { fields: unknown[]; markup?: unknown[] }
    table?: unknown[]
    base?: unknown[]
    modal?: unknown[]
    [key: string]: unknown
  }

  views?: EntityViews
  constants?: {
    quickActions?: unknown[]
    dropdownFilters?: unknown[]
    labels?: EntityLabelsConfig
    foreignTables?: string[]
    [key: string]: unknown
  }

  routeConfig?: EntityRouteConfig
  search?: { enabled?: boolean; searchType?: string; [k: string]: unknown }
  plugin?: PluginEntityConfig

  primaryKey?: string
  displayField?: string
  softDelete?: boolean
  enableAudit?: boolean
  meta?: Record<string, unknown>
}
```

---

## RefEnabledEntityConfig (build-time, для config.tsx)

`simplx-core/core-ui/src/app/app-meta-renderer/unified-ref-resolver/types.ts:408-432`

```ts
interface RefEnabledEntityConfig {
  entityName: string
  displayName: string
  displayNamePlural?: string
  description?: string

  fields?: EntityFieldsConfig
  constants?: EntityConstantsConfig
  views?: RefEntityViewsConfig
  routeConfig?: RefRouteConfig
  meta?: Record<string, unknown>
}

interface EntityFieldsConfig {
  base?: unknown[]
  modal?: unknown[]
  table?: unknown[]
  modalMarkup?: unknown[]
  createVariants?: unknown[]
  titleResolvers?: Record<string, unknown> | unknown[]
  form?: { fields: FieldConfig[]; markup?: unknown[][]; relationBindings?: Record<string, RelationBinding> }
  [key: string]: unknown
}

interface EntityConstantsConfig {
  quickActions?: QuickActionMeta[]
  dropdownFilters?: DropdownFilter[]
  labels?: EntityLabelsConfig
  foreignTables?: string[]
  [key: string]: unknown
}

interface EntityLabelsConfig {
  singular: string
  plural: string
  genitive?: string
  accusative?: string
  create?: string
  edit?: string
}

interface RefRouteConfig {
  path: string
  icon?: string                    // optional, lucide-react name (Users, Clock, FolderOpen, ...)
  navKey?: string
  order?: number
}
```

---

## FieldConfig

`packages/meta/src/schemas/field-config.schema.ts:86-154`

```ts
interface FieldConfig {
  // identity
  title?: string
  dataIndex?: string | string[]
  name?: string
  label?: string
  type?: string

  // value type & display
  valueType?: ValueType
  titleI18nKey?: string
  width?: number
  hidden?: boolean | 'form' | 'table' | 'all'

  // validation
  required?: boolean
  rules?: ValidationRuleSchema[]

  // data sources
  resource?: string
  dictionaryName?: string
  relation?: { name: string; resource: string; role?: string }
  selection?: 'single' | 'multiple'
  labelField?: string
  valueField?: string
  options?: { label: string; value: unknown }[]
  foreignTables?: string[]

  // defaults
  preDefault?: PreDefaultConfig

  // conditional logic
  conditions?: FieldConditions
  dependencies?: string[]

  // props & actions
  fieldProps?: Record<string, unknown>
  formItemProps?: Record<string, unknown>
  createAction?: CreateActionConfigSchema
  action?: string | { code: string; params?: Record<string, unknown> }

  // table-specific
  sorter?: boolean
  searchable?: boolean
  search?: boolean | Record<string, unknown>
  drilldownResource?: string
  drilldownPath?: string
  drilldownIdField?: string
  displayValuePath?: string[]

  [key: string]: unknown
}
```

### fieldProps — частые ключи

```
disabled, readonly
format             // 'YYYY-MM-DD', 'DD.MM.YYYY HH:mm'
showTime           // for datetime
allowedChars       // regex
min, max
precision
tokenSeparators    // for tags
placeholder
maxLength, minLength
multiple
```

### `money` — fieldProps (LAB-273)

Форма (`valueType: 'money'`):

```ts
fieldProps: {
  currency?: string | ValueSource   // код ISO; константа или источник (в т.ч. parent.<field>)
  precision?: number                // default 2
  min?: number
}
```

Таблица (`valueType: 'money'`, без `format`): `fieldProps.currencyField?: string` — колонка строки с кодом валюты. Заданный `format` имеет приоритет над `currency`/`currencyField`.

Порядок выбора валюты: явная (`currency`/`currencyField`) → валюта организации по умолчанию (`_s_settings general/currency`) → без символа (число). Символ — `symbol` элемента словаря `currency` по коду; захардкоженного символа нет.

---

## ValueType

`packages/meta/src/schemas/value-type.schema.ts:10-53`

```ts
type ValueType =
  // text
  | 'text' | 'textarea' | 'email' | 'url' | 'password' | 'phone'
  // numeric
  | 'digit' | 'money' | 'percent'
  // date/time
  | 'date' | 'datetime' | 'dateRange' | 'time'
  // selection
  | 'select' | 'dictionary' | 'relation' | 'funnel'
  | 'multiSelect' | 'tags' | 'multipleFree' | 'radio' | 'checkbox'
  // boolean
  | 'boolean' | 'switch'
  // data
  | 'jsonCode'
  // special
  | 'drilldownPage' | 'indexBorder'
  | string                          // custom valueTypes (entityLabel, comment, money — через .or(z.string()))
```

---

## ISectionMeta (view section)

`packages/meta/src/schemas/section-meta.schema.ts:145-227`

```ts
interface ISectionMeta {
  type: SectionType
  resource?: string
  appResource?: string
  area?: 'left' | 'center' | 'right' | 'top' | 'bottom'

  title?: string
  titleSource?: string
  titleFromDictionary?: string

  // table
  columns?: FieldConfig[]
  tableColumns?: { $ref: string } | unknown[]
  pageSize?: number
  initialFilter?: Record<string, unknown>
  initialSorter?: Record<string, 'ascend' | 'descend'>
  groupBy?: string[]
  parentField?: string
  foreignTables?: string[] | { $ref: string }

  // modal & search
  modalFields?: ModalFieldsConfig | FieldConfig[]
  searchModalFields?: unknown
  isSearchEnabled?: boolean
  quickSearchFields?: string[]
  dropdownFilters?: unknown[] | { $ref: string }

  // junction
  meta?: {
    relation?: { name: string; resource?: string }
    tableSettings?: SectionSettingsConfig
  }

  // detail
  mode?: string
  orientation?: 'horizontal' | 'vertical'
  editMode?: string
  groups?: Array<{ id: string; fields: { $ref: string } | unknown[] }>

  // tabs container
  items?: ISectionMeta[]

  // custom
  componentName?: string

  // service endpoints
  isServiceEndpoint?: boolean
  serviceEndpointConfig?: { basePath: string; list?: string; create?: string }

  // actions
  disableCreate?: boolean
  disableDelete?: boolean
  customActions?: unknown[]
  deleteRecord?: DeleteRecordConfig
  settings?: SectionSettingsConfig

  // rich text
  richTextEditorConfig?: RichTextEditorConfig

  // calendar
  calendarView?: 'month' | 'week' | 'day' | 'list'

  [key: string]: unknown
}
```

### SectionType

```ts
type SectionType =
  // table
  | 'table' | 'table_universal' | 'editable_table' | 'data_table'
  // detail
  | 'record_detail_panel' | 'description' | 'editable_description'
  // rich text
  | 'rich_text' | 'rich-text-editor'
  // container
  | 'tabs'
  // relations
  | 'intersection_transfer'
  // attachments
  | 'attachments' | 'attachmentFolders'
  // timeline
  | 'activity_timeline' | 'audit_log'
  // calendar
  | 'calendar'
  // editor
  | 'json_editor'
  // custom
  | 'custom'
  // tab item shortcuts
  | 'history' | 'notes' | 'contacts' | 'activities' | 'leads' | 'projects' | 'requests'
```

---

## QuickActionMeta

`simplx-core/core-ui/src/app/app-meta-renderer/types.ts:15-191`

```ts
interface QuickActionMetaBase {
  label: string
  icon: string
  hotkey?: string
}

// 8 дискриминированных интерфейсов в коде:
// AttachmentQuickActionMeta, NoteQuickActionMeta, DeleteQuickActionMeta,
// ChildActivityQuickActionMeta, RelationQuickActionMeta, EntityRelationQuickActionMeta,
// ConversionQuickActionMeta, ReminderQuickActionMeta

type QuickActionMeta =
  | QuickActionMetaBase & { type: 'attachment'; config?: { accept?: string; multiple?: boolean } }
  | QuickActionMetaBase & { type: 'note' }
  | QuickActionMetaBase & { type: 'delete'; config?: { confirmMessage?: string } }
  | QuickActionMetaBase & { type: 'child_activity'; config: { resource: string; parentField?: string; addExisting?: { intersectionResource: string; resource: string; labelField?: string; valueField?: string; searchField?: string; filters?: Record<string, unknown> } } }
  | QuickActionMetaBase & { type: 'relation'; config: { intersectionResource: string; sourceField: string; targetField: string; picker: { resource: string; labelField?: string; valueField?: string; searchField?: string } } }
  | QuickActionMetaBase & { type: 'entity_relation'; config: { entityTypes: string[]; withComments?: boolean; maxCommentLength?: number } }
  | QuickActionMetaBase & { type: 'conversion'; config: { targetEntity: string; executorField?: string; executorPicker?: { resource: string; labelField?: string; valueField?: string }; confirmMessage?: string } }
  | QuickActionMetaBase & { type: 'reminder' }
```

⚠️ Это сжатая форма. Полные `config` shapes — `simplx-core/core-ui/src/app/app-meta-renderer/types.ts:15-191`. При использовании сложных конфигов (`child_activity.config.addExisting`, `relation.config.picker`) сверяться с источником.

---

## DropdownFilter

```ts
interface DropdownFilter {
  key: string                       // 'my_requests'
  label: string                     // 'Мои заявки'
  filters: Array<{
    field: string
    operator: 'eq' | 'ne' | 'in' | 'notIn' | 'gt' | 'lt' | 'ilike'
    value: unknown                  // '{{current_user_id}}' | constant | array
  }>
  // composite:
  // filters can also be: { and: [...] } | { or: [...] }
}
```

Шаблонные переменные: `{{current_user_id}}`, `{{current_employee_id}}`, `{{current_tenant_id}}`.

---

## Conditions DSL

`packages/meta/src/schemas/conditions.schema.ts:18-194`
`packages/meta/src/conditions/types.ts:35-307`

```ts
type Condition =
  | { field: string; equals: unknown }
  | { field: string; notEquals: unknown }
  | { field: string; in: unknown[] }
  | { field: string; notIn: unknown[] }
  | { field: string; isEmpty: true }
  | { field: string; isNotEmpty: true }
  | { field: string; greaterThan: number }
  | { field: string; lessThan: number }
  | { field: string; matches: string }       // regex
  | { field: string; contains: string }
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }

interface ConditionalValueConfig<T> {
  default: T
  when: Condition
  then: T
}

/** LAB-273 (структурные правила сужены задачей T008a — платформа валидирует
 * Ajv по сгенерированной JSON Schema, бюджет 500 КБ, `$refStrategy: none`,
 * поэтому вместо «везде, где допустим ConditionalValue» — точечный список
 * мест). Объект с ключом `valueFrom` трактуется как ValueSource ТОЛЬКО в
 * `conditions.label` и как значение первого уровня `conditions.fieldProps`
 * (один ключ fieldProps может быть ValueSource; объекты, вложенные глубже,
 * не проверяются и ValueSource не считаются). НЕ принимается в
 * `conditions.title`, в `then`/`default` ConditionalValueConfig, ни в
 * `cases[].then` MultiConditionalValue. Колоночный `format` (таблицы) —
 * отдельный DSL, уже принимавший `valueFrom` как строку (в т.ч.
 * `parent.currency`) до этой задачи; это не тот же ValueSource. */
interface ValueSource {
  /** Имя поля; путь через точку для подгруженных связей (`_client.full_name`,
   *  только там, где связь уже подгружена — строки таблиц/`foreignTables`);
   *  префикс `parent.` — поле родительской записи вложенной секции (работает
   *  и в значениях формы, и в `format` колонок). min(1). */
  valueFrom: string
  /** Имя словаря (`_s_dictionary.dictionary_name`), через который прогнать значение. */
  dict?: string
  /** Атрибут элемента словаря (`symbol`, `label`, `short`…). Требует `dict`
   *  (иначе ошибка валидации `pick_requires_dict`). */
  pick?: string
}

type ConditionalValue<T> = T | ConditionalValueConfig<T>

interface FieldConditions {
  hidden?: boolean | Condition
  label?: ConditionalValue<string> | ValueSource
  title?: ConditionalValue<string>
  required?: boolean | Condition
  disabled?: boolean | Condition
  readOnly?: boolean | Condition
  fieldProps?: ConditionalValue<Record<string, unknown | ValueSource>>   // ValueSource допустим только на первом уровне значений объекта
}
```

`ValueSource` резолвится в `lib/conditions/value-source.ts`: значение поля → если задан `dict`, найти элемент словаря по `value === code` и вернуть `pick` (или `label`, если `pick` не задан) → иначе вернуть сырое значение. Источник не найден (поле отсутствует/не резолвится) → `undefined`, свойство не выставляется, ошибок нет (в dev — `console.warn`). В значениях **формы** доступны только поля самой формы и `parent.<field>` — связи там не подгружены; в **таблицах** (`foreignTables`, `format` колонок) доступны и подгруженные связи, и `parent.`.

Пример (`money` с валютой соседнего поля и с валютой родителя):

```ts
{ dataIndex: 'amount', valueType: 'money',
  dependencies: ['currency'],
  conditions: { fieldProps: { currency: { valueFrom: 'currency' } } } }

{ dataIndex: 'unit_price', valueType: 'money',
  conditions: { fieldProps: { currency: { valueFrom: 'parent.currency' } } } }
```

Применение в FieldConfig:

```ts
{
  dataIndex: 'decision_maker',
  valueType: 'text',
  dependencies: ['subject_type'],
  conditions: {
    hidden: { field: 'subject_type', notEquals: 'legal_entity' }
  }
}
```

---

## PreDefaultConfig

`packages/meta/src/schemas/pre-default.schema.ts:10-64`

```ts
type PreDefaultConfig =
  | { type: 'parentId' }
  | { type: 'currentDate' }
  | { type: 'userId' }
  | { type: 'employeeId' }
  | { type: 'staticValue'; value: unknown }
  | { type: 'configParameter'; value: string }
  | { type: 'record'; targetField: string }
  | { type: 'select'; by: string; equals: string | number | boolean; operator?: 'eq' | 'ilike' }
  | { type: 'custom'; value?: Function }      // не сериализуется
```

---

## RefNode / FnNode

`packages/meta/src/schemas/ref.schema.ts:7-12`

```ts
interface RefNode {
  $ref: string
  overrides?: Record<string, unknown>
}

interface FnNode {
  $fn: 'lookup' | 'template' | 'condition' | 'ref'
  [key: string]: unknown
}
```

### $ref пути

```
#/fields/form/fields            // local: внутри текущего entity
#/fields/table
#/fields/form/markup
#/constants/quickActions
#/constants/dropdownFilters

activities.fields.table         // cross-entity
activities.fields.form.fields
contacts.constants.dropdownFilters
contacts.views.list

reference/entities/projects     // cross-tenant template (через import, не $ref)
```

### Резолвер

`packages/meta/src/resolver/`
- Локальные `#/...` — внутри текущего entity
- Cross-entity `entityName.path` — из реестра entities
- Циклы детектируются (max depth 10)
- `overrides` мерджится после резолва, поддерживает array selector `[key=value]`

### Правила использования

- `$ref` живёт **в местах потребления** (views.list/detail, sections, modalFields, dropdownFilters)
- НЕ должен быть в основной структуре fields/constants
- Глубокие цепочки $ref — антипаттерн
- При $ref на другую сущность последняя должна быть в registry (то же app или reference/)

### $fn

```ts
// lookup — динамический mapping
{ $fn: 'lookup', source: 'type', map: { type_task: 'Создать задачу', ... } }
```

---

## RelationBinding (junction)

```ts
interface RelationBinding {
  name: string                      // 'activities_employees' (junction table)
  resource: string                  // 'employee'
  role?: string                     // опц., если несколько ролей
}

// в form:
relationBindings: {
  assignees: { name: 'activities_employees', resource: 'employee' },
  contacts:  { name: 'activities_contacts',  resource: 'contacts' },
}
```

---

## PluginEntityConfig

```ts
interface PluginEntityConfig {
  id: string                        // 'timesheet'
  source: 'core' | 'remote'
  config?: Record<string, unknown>  // plugin-specific
  views?: Array<{
    key: string                     // 'weekly'
    label: string                   // 'Неделя'
    component: string               // 'TimeSheetApp'
    appResource?: string
    props?: Record<string, unknown>
  }>
}
```

---

## Список field types в реальном коде (helpdev/intellhouse)

Часто используемые с примерами:

| valueType | Пример use case |
|-----------|-----------------|
| `text` | name, full_name, address |
| `textarea` | comments, description |
| `email`, `phone` | primary_email, primary_phone |
| `digit` | amount |
| `money` | pay_sum |
| `date` | start_date, due_date |
| `datetime` | created_at, updated_at |
| `dictionary` | type, status, priority, source (с `dictionaryName`) |
| `select` | owner_id, project_id (с `resource` + `labelField`/`valueField`) |
| `relation` | product_ids, executors (с `relation.name`/`resource`/`role`, `selection`) |
| `funnel` | funnel_state (с `action: { code: 'funnel.move' }`) |
| `tags` | cadastre_number, oks_cadastre_number (с `tokenSeparators`) |
| `drilldownPage` | name (главный кликабельный столбец table) |
| `entityLabel` | computed display label |
| `comment` | в `quickActions[entity_relation]` |

---

## Markup (раскладка формы)

```ts
markup: [
  ['name'],                                 // ряд 1: 1 поле full width
  ['type', 'subject_type'],                 // ряд 2: 2 поля 50/50
  ['primary_phone', 'primary_email'],
  ['client_since'],
]
```

Двумерный массив имён полей. Длина внутреннего массива = колонок в этом ряду.

---

## Foreign tables (JOIN)

```ts
// в section / views.list:
foreignTables: [
  '_employee_owner:owner_id',     // alias _employee_owner, FK = owner_id
  '_author:created_by',
  '_projects:project_id',
  '_work_months:reporting_month_id',
]

// доступ:
{ dataIndex: ['_employee_owner', 'full_name'], title: 'Владелец' }
```

---

## Service endpoint sections

Aggregated relations (FK + extensions + entity_relations единым запросом):

```ts
{
  type: 'table_universal',
  isServiceEndpoint: true,
  serviceEndpointConfig: {
    basePath: 'data-processing/relations',
    list: 'related',
  },
  // ...
}
```

---

## CreateVariants + titleResolvers (variant-driven create)

```ts
fields: {
  ...,
  createVariants: [
    {
      key: 'task',
      label: 'Задача',
      icon: 'CheckSquare',
      initialValues: { type: 'type_task' },
      addExisting: {
        resource: 'activities',
        intersectionResource: 'activities_contacts',
        filters: { type: 'type_task' },
        labelField: 'name',
        valueField: 'id',
      },
    },
    // ...
  ],
  titleResolvers: {
    create: { $fn: 'lookup', source: 'type',
              map: { type_task: 'Создать задачу', type_meeting: 'Создать встречу' } },
    edit:   { $fn: 'lookup', source: 'type',
              map: { type_task: 'Редактировать задачу' } },
  },
}
```

---

## Validation rules (rules)

```ts
{
  dataIndex: 'primary_email',
  valueType: 'email',
  rules: [
    { required: true, message: 'Обязательное поле' },
    { type: 'email', message: 'Неверный email' },
    { pattern: '^[a-z0-9._%+-]+@', message: 'Только латиница' },
  ],
}
```

---

## Tabs structure (detail)

```ts
// apps/{tenant}/entities/{e}/tabs.tsx
export const detailTabs: ISectionMeta[] = [
  // 1. Activity timeline
  {
    type: 'activity_timeline',
    title: 'История',
    sectionMeta: {
      query: '...',
      autoBindParentId: true,
      listHeight: 600,
      filters: { subject_type: 'contacts' },
    },
  },

  // 2. Custom component (NotesTab, StorageAttachments, etc.)
  {
    type: 'custom',
    title: 'Заметки',
    componentName: 'NotesTab',
    parentField: 'subject_id',
  },

  // 3. Junction table
  {
    type: 'table_universal',
    title: 'Контакты',
    resource: 'contacts',
    appResource: 'contacts',
    meta: {
      relation: { name: 'contacts_leads', resource: 'contacts' },  // ОБЯЗАТЕЛЬНО
    },
    tableColumns: { $ref: 'contacts.fields.table' },
    modalFields: { $ref: 'contacts.fields.form.fields' },
    initialFilter: {},
    foreignTables: { $ref: 'contacts.constants.foreignTables' },
  },

  // 4. Audit log
  {
    type: 'audit_log',
    title: 'Лог',
    sectionMeta: { filters: { subject_type: 'contacts' } },
  },
]
```

---




## Источники по файлам (canonical)

```
packages/meta/src/schemas/app-meta.schema.ts:96-100         AppMeta (Zod)
packages/meta/src/schemas/entity-meta.schema.ts:100-170     EntityMetadata (Zod)
packages/meta/src/schemas/field-config.schema.ts:86-154     FieldConfig (Zod)
packages/meta/src/schemas/section-meta.schema.ts:145-227    ISectionMeta (Zod)
packages/meta/src/schemas/section-meta.schema.ts:17-64      SectionType enum
packages/meta/src/schemas/conditions.schema.ts:18-194       Conditions (Zod)
packages/meta/src/schemas/value-type.schema.ts:10-53        ValueType enum
packages/meta/src/schemas/pre-default.schema.ts:10-64       PreDefaultConfig
packages/meta/src/schemas/ref.schema.ts:7-12                RefNode, FnNode

packages/meta/src/resolver/resolver.ts:50-224               $ref resolver API
packages/meta/src/resolver/types.ts:12-106                  Resolver types
packages/meta/src/resolver/utils.ts:24-97                   Utils

packages/meta/src/serializer/index.ts:22-351                JSX → JSON
packages/meta/src/conditions/types.ts:35-307                Conditions TS
packages/meta/src/conditions/interpreter.ts:189-351         Interpreter

simplx-core/core-ui/src/app/app-meta-renderer/types.ts:15-191       QuickActionMeta
simplx-core/core-ui/src/app/app-meta-renderer/types.ts:441-456      Runtime AppMeta
simplx-core/core-ui/src/app/app-meta-renderer/unified-ref-resolver/types.ts:408-432   RefEnabledEntityConfig
```
