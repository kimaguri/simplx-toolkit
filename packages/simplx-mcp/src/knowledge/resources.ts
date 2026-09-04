import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { META_GUIDE, META_TYPES_REFERENCE } from "./embedded.js";

/**
 * LAB-257 T259 — the reference half of the server's built-in knowledge.
 *
 * `instructions` (instructions.ts) carries the RULES every client sees at
 * initialize; this module carries the REFERENCE the agent pulls on demand:
 * two resources (the guide and the type reference) and three prompts for
 * the typical jobs. The server stays thin and stateless — these are static
 * strings embedded at build time (scripts/embed-knowledge.mjs), nothing is
 * fetched from the platform to serve them.
 */
export const KNOWLEDGE_RESOURCES = [
  {
    name: "meta-guide",
    uri: "simplx://meta/guide",
    title: "SimplX meta guide",
    description:
      "How tenant meta is shaped and what each key does on screen: addressing, entity config, sidebar/name rules, templates and overrides, $ref, fields, sections, quick actions, plugins, history, common mistakes. Read before the first write.",
    text: META_GUIDE,
  },
  {
    name: "meta-types",
    uri: "simplx://meta/types",
    title: "SimplX meta type reference",
    description:
      "Full shapes: AppMeta, entity config, FieldConfig, ValueType, ISectionMeta/SectionType, QuickActionMeta, DropdownFilter, conditions DSL, PreDefaultConfig, $ref/$fn nodes, RelationBinding, PluginEntityConfig.",
    text: META_TYPES_REFERENCE,
  },
] as const;

const promptText = (lines: string[]): string => lines.join("\n");

export const KNOWLEDGE_PROMPTS = [
  {
    name: "meta_add_field",
    title: "Add a field to an entity",
    description: "Step-by-step: add one field to an entity's form and/or table through the meta.* tools, with version check and verification.",
    argsSchema: {
      tenant: z.string().describe("Tenant id (from meta.list_apps or the operator)."),
      app: z.string().describe("App name inside the tenant."),
      entity: z.string().describe("entityName to change."),
      field: z.string().describe("What the field is: name (dataIndex), type, where it goes (form/table/both), any data source."),
    },
    build: (a: { tenant: string; app: string; entity: string; field: string }) =>
      promptText([
        `Add a field to entity "${a.entity}" of app "${a.app}" (tenant ${a.tenant}): ${a.field}.`,
        "",
        "Follow the write cycle from the server instructions:",
        "1. meta.get_entity — read `raw` and `version`. If the entity has `basedOn`, you edit overrides: send the whole `fields.form.fields` / `fields.table` array you want (arrays replace wholesale).",
        "2. Build the FieldConfig (see simplx://meta/types): `dataIndex`, `title`, `valueType`, and the data-source keys the type needs (`dictionaryName`, `resource`+`labelField`/`valueField`, `relation`...). Add it to `fields.form.fields` and to `fields.form.markup` (a new row or an existing one) for the form, to `fields.table` for the list.",
        "3. meta.validate the full config; treat `unknownComponents` as a warning only.",
        "4. meta.diff — only the intended paths may change.",
        "5. meta.write_entity with `expectedVersion` = the version read in step 1 and a `changeReason`.",
        "6. meta.get_entity again and report: where the field appears (form row / list column), and anything the schema forced you to change.",
      ]),
  },
  {
    name: "meta_new_entity_from_template",
    title: "Create an entity from a template",
    description: "Create a tenant entity that inherits a system template (basedOn) with the tenant's own labels and route.",
    argsSchema: {
      tenant: z.string().describe("Tenant id."),
      app: z.string().describe("App name inside the tenant."),
      templateKey: z.string().describe("Template to inherit (from meta.list_templates)."),
      overrides: z.string().describe("What the tenant changes: labels, route path/icon, hidden fields, extra fields."),
    },
    build: (a: { tenant: string; app: string; templateKey: string; overrides: string }) =>
      promptText([
        `Create an entity in app "${a.app}" (tenant ${a.tenant}) based on template "${a.templateKey}". Tenant-specific changes: ${a.overrides}.`,
        "",
        "1. meta.get_template to see what the template provides (labels, route, fields, sections).",
        "2. Build the raw config: `entityName` (usually = templateKey), `basedOn: \"" + a.templateKey + "\"`, then ONLY the keys that differ — `constants.labels` as a WHOLE object, `routeConfig` (path, icon, navKey or none, sortOrder, hideInMenu), overridden arrays in full. Do not copy the template's content into the entity.",
        "3. meta.validate; then meta.write_entity WITHOUT expectedVersion (it does not exist yet). If the platform answers meta_expected_version_not_allowed / an existing row, re-read and update instead.",
        "4. meta.get_entity — check `resolved` shows template + your overrides and `unresolvedOverrides` is empty.",
        "5. Report the sidebar effect: the label comes from `routeConfig.navKey` when it has a translation, else `displayName`.",
      ]),
  },
  {
    name: "meta_rename_entity",
    title: "Rename an entity on screen",
    description: "Change how an entity is called in the sidebar, list heading and modals — with the navKey caveat handled.",
    argsSchema: {
      tenant: z.string().describe("Tenant id."),
      app: z.string().describe("App name inside the tenant."),
      entity: z.string().describe("entityName to rename."),
      newName: z.string().describe("New name (singular and plural if they differ)."),
    },
    build: (a: { tenant: string; app: string; entity: string; newName: string }) =>
      promptText([
        `Rename entity "${a.entity}" of app "${a.app}" (tenant ${a.tenant}) to: ${a.newName}.`,
        "",
        "1. meta.get_entity — note `version`, `resolved.constants.labels` and `resolved.routeConfig.navKey`.",
        "2. Set `displayName`, `displayNamePlural` and the WHOLE `constants.labels` object (singular, plural, genitive, accusative, create, edit) — partial labels are refused.",
        "3. Sidebar: if `routeConfig.navKey` is set and has a translation, the menu keeps showing the translation. Either remove/replace `navKey` in `routeConfig` (send the whole routeConfig) so `displayName` is used, or tell the operator the menu label is translation-driven and needs an i18n change.",
        "4. meta.validate → meta.diff → meta.write_entity with `expectedVersion` and a `changeReason`.",
        "5. Verify with meta.get_entity and state exactly which screen texts changed (menu, list heading, modal titles).",
      ]),
  },
] as const;

export const registerKnowledge = (server: McpServer): void => {
  for (const r of KNOWLEDGE_RESOURCES) {
    server.registerResource(
      r.name,
      r.uri,
      { title: r.title, description: r.description, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: r.text }] }),
    );
  }
  for (const p of KNOWLEDGE_PROMPTS) {
    // Each prompt's argsSchema is a plain string shape; the union over the
    // three prompts is erased here so one loop registers them all.
    const argsSchema = p.argsSchema as z.ZodRawShape;
    const build = p.build as (a: Record<string, string>) => string;
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema },
      async (args: Record<string, string>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: build(args) } }],
      }),
    );
  }
};
