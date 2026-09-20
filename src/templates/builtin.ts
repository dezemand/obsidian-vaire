// Presets shipped with the plugin — the `'builtin'` side of the `templateSource` trade-off
// (see src/templates/pure.ts's `listTemplateOptions` doc comment and BRANCHES.md
// `feat/record-templates`). Useful for a package that hasn't curated its own
// `<templateFolder>/<type>.md` files; not curated by the package owner, unlike a package
// template. Written in the plugin's own `{{ }}` placeholder syntax (see pure.ts's module doc
// comment) since there's no existing package convention to match here.

export interface BuiltinTemplate {
  /** Also the key modal options / `listTemplateOptions` refer to it by. */
  key: string;
  label: string;
  /** Raw template text, `---`-fenced exactly like a package template file — fed to
   *  `parseTemplate`/`renderTemplate` the same way either source is. */
  text: string;
}

const RECORD: BuiltinTemplate = {
  key: 'record',
  label: 'Record (meeting / status note)',
  text: `---
id: {{date}}-{{id}}
type: {{type}}
name: {{name}}
date: {{date}}
participants: []
references: []
---
# {{name}}

## Participants

## Notes

## Decisions
`,
};

const DECISION: BuiltinTemplate = {
  key: 'decision',
  label: 'Decision',
  text: `---
id: {{date}}-{{id}}
type: {{type}}
name: {{name}}
status: proposed
date: {{date}}
---
# {{name}}

## Context

## Decision

## Consequences
`,
};

const GUIDE: BuiltinTemplate = {
  key: 'guide',
  label: 'Guide',
  text: `---
id: {{id}}
type: {{type}}
name: {{name}}
status: active
updated: {{date}}
---
# {{name}}

Task-oriented instructions — written so someone can follow it start to finish without prior
context.

## Steps

## Notes
`,
};

/** The generic fallback preset — offered for any type without a more specific preset or, in
 *  `'both'` mode, a package template. */
const ENTITY: BuiltinTemplate = {
  key: 'entity',
  label: 'Generic entity',
  text: `---
id: {{id}}
type: {{type}}
name: {{name}}
status: active
---
# {{name}}

## Description

## Relations
`,
};

export const BUILTIN_TEMPLATES: Record<string, BuiltinTemplate> = {
  record: RECORD,
  decision: DECISION,
  guide: GUIDE,
  entity: ENTITY,
};

/** Every preset, for iteration (e.g. tests, or a source-agnostic listing). */
export const ALL_BUILTIN_TEMPLATES: BuiltinTemplate[] = [RECORD, DECISION, GUIDE, ENTITY];

/** The preset for a given corpus type: an exact-name match (`record`/`decision`/`guide`) when
 *  one exists, else the generic `entity` preset — always returns something, since builtin
 *  presets are the "works for anything" fallback source (`listTemplateOptions` relies on
 *  that). */
export function builtinTemplateFor(type: string): BuiltinTemplate {
  return BUILTIN_TEMPLATES[type] ?? ENTITY;
}
