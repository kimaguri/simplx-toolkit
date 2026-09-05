/**
 * LAB-257 T259 — the server's own operating rules, delivered to every
 * client at `initialize` (`instructions`). Clients such as Claude Code
 * merge this into the agent's system context, so the knowledge travels
 * WITH the server and is versioned with it — no client-side skill file
 * needed for the rules that matter. Kept short on purpose: these are
 * rules, the reference lives in the `simplx://meta/guide` and
 * `simplx://meta/types` resources and the `meta_*` prompts.
 *
 * Every hard rule here is ALSO enforced by the platform (mandatory
 * expectedVersion, version conflict, server-side validation, prod
 * profile without write tools) — the text helps the agent act well, the
 * API guarantees it cannot act badly.
 */
export const SERVER_INSTRUCTIONS = `SimplX meta server (meta.*). Tenant UI metadata lives in the platform DB; a write IS publication — the screen picks it up on next load. Rules live in code (published JSON Schema), meta lives in the DB, you edit through these tools only.

TENANT: this one server instance serves every tenant of its platform. \`tenant\` is a parameter you pass on EACH tool call (meta.list_apps, meta.get_entity, meta.write_entity, ...), not a property of the server. The SIMPLX_AUTH_TENANT_SLUG environment variable (legacy alias SIMPLX_TENANT_SLUG) is unrelated to which tenant you operate on — it is only the value the platform expects in the X-Tenant-Slug header for service-to-service authorization, and any valid slug works there. There is one server per environment: the test profile exposes write tools, the prod profile is read-only.

READ FIRST: resource simplx://meta/guide (how meta is shaped and what each key does on screen) and simplx://meta/types (field/section/action types). meta.get_schema gives the machine-readable rules; validate against them with meta.validate, never with your own schema reading.

WRITE CYCLE, always in this order:
1. meta.list_apps(tenant) -> entity names + current versions.
2. meta.get_entity -> edit \`raw\` (what is stored), use \`resolved\` only to see the assembled result of a basedOn entity. Note \`version\`.
3. meta.validate(config) -> must be valid. \`unknownComponents\` and \`unresolvedOverrides\` are WARNINGS (nothing is refused) — mention them, do not "fix" them by deleting keys.
4. meta.diff(proposedConfig) -> confirm only the intended paths change.
5. meta.write_entity with expectedVersion = the version you read. A version_conflict answer (details.params.currentVersion) means someone wrote in between: re-read, re-apply your change, write again — never retry blindly with the new number.
6. Verify: meta.get_entity again, then say what the screen will show and where.
Undo = meta.rollback with targetVersionId from meta.versions and the CURRENT version as expectedVersion; it creates a new version, history is never erased.

WHAT CHANGES WHAT ON SCREEN:
- Sidebar label = translation of routeConfig.navKey when that key has a translation, else displayName. Renaming displayName alone does NOT change the menu item while navKey resolves; renaming labels.plural changes list headings.
- constants.labels is a WHOLE object (singular, plural, ... ) — send all keys you want kept, partial objects are refused.
- A basedOn entity inherits everything from its template; its raw config holds only overrides. Overrides change and add keys, they cannot delete inherited ones (null stores null). Arrays replace wholesale. Template edits reach every dependent tenant — meta.template_dependents first, acknowledge the count.
- componentName / plugin.component reference code in core-ui; you can only point at names that exist, you cannot create components here.
- routeConfig.hideInMenu hides an entity from the sidebar (hidden / hideFromNav are dead keys).

NEVER: write without expectedVersion on an existing entity; write to production (the prod profile has no write tools and the platform refuses the automatic author there); flatten a basedOn entity into a full copy to "fix" an override; mutate a tenant other than the one asked for.

PROMOTION (test profile only): meta.promote_preview and meta.promote move an app, one entity, or one template from test to prod — never available on the prod profile. Address with tenantSlug+app (add entity for one entity, omit it for the whole app) OR templateKey alone — never mixed, templates are cross-tenant. Cycle: meta.promote_preview -> read diff and confirm templateStale is false (true or "missing" means a dependency template needs promoting first) -> meta.promote with expectedTargetVersion = the preview's targetVersion, null included. A version_conflict answer means the target moved since your preview: re-preview, never retry blindly. There is no acknowledgedDependents field on meta.promote — the platform recounts template dependents on the target itself. These tools address the tenant by tenantSlug, not the tenant id every other meta.* tool uses. Only promote on the tenant owner's explicit instruction.

Tenant ids come from meta.list_apps / the operator; app name is usually the tenant's slug. Prefer changeReason on every write — it is what humans read in history.`;
