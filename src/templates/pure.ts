// Pure helpers for the "New Vairë node from template" feature — no `obsidian` import, so these
// stay unit-testable in plain `bun test`. See DESIGN.md-style conventions in
// ../authoring/pure.ts, which this module reuses `slugify` from for id defaults.
//
// Placeholder syntax, inferred from the real templates in a corpus package (e.g.
// acme-platform/templates/*.md — none of them use `{{ }}` or `TODO`, all of them use a
// bare `<placeholder>` convention, sometimes as a whole frontmatter value (`name: <Display
// Name>`), sometimes inline (`id: <yyyy-mm-dd>-<slug>`, `proposal: proposal:<slug>`), and
// sometimes only inside a trailing `# comment` describing the shape of an edge list — which we
// deliberately do NOT treat as a fillable placeholder):
//
//  - `<yyyy-mm-dd>` always means "today's date" (well-known `date`).
//  - the placeholder used as the whole `name:` value (`<Display Name>`, `<Full Name>`,
//    `<alias>`, `<cn>`, …) is that template's stand-in for the node's display name — wherever
//    that exact token reappears elsewhere in the document (typically the body's `# <...>`
//    heading), it also means `name`.
//  - a bare `<slug>` with no enclosing frontmatter field (i.e. in the body, not a `key: value`
//    line) means "this node's own id".
//  - any other `<placeholder>` inside a live (non-comment) frontmatter field value is a free
//    prompt for that field, keyed by the field name so two different fields that happen to
//    reuse the same word (`from: network:<slug>` / `to: network:<slug>`) don't collide.
//
// On top of that bare-angle-bracket convention, this module also recognizes the plugin's own
// `{{ }}` syntax for the well-defined variables (`{{id}}`, `{{name}}`, `{{type}}`, `{{scope}}`,
// `{{date}}`, `{{today}}`, `{{package}}`, `{{descriptor}}`) and free labeled prompts
// (`{{field:Label}}`) — used by the builtin presets (builtin.ts) and available to a package
// template author who wants an explicit label instead of relying on the field-name inference
// above.

import { slugify } from '../authoring/pure';

// ---- token scanning ------------------------------------------------------------------------

interface RawToken {
  index: number;
  raw: string;
  curly: boolean;
  /** curly token's var/field name, e.g. "date" or "field". */
  name?: string;
  /** curly `{{field:Label}}` form's label, undefined for a bare `{{name}}`. */
  label?: string;
  /** angle token's inner text, e.g. "yyyy-mm-dd" or "Display Name". */
  angleText?: string;
}

const CURLY_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?::\s*([^{}]+?)\s*)?\}\}/g;
const ANGLE_RE = /<([A-Za-z][^<>]*)>/g;

function scanTokens(text: string): RawToken[] {
  const tokens: RawToken[] = [];
  CURLY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CURLY_RE.exec(text))) {
    tokens.push({ index: m.index, raw: m[0], curly: true, name: m[1], label: m[2] });
  }
  ANGLE_RE.lastIndex = 0;
  while ((m = ANGLE_RE.exec(text))) {
    tokens.push({ index: m.index, raw: m[0], curly: false, angleText: m[1] });
  }
  tokens.sort((a, b) => a.index - b.index);
  return tokens;
}

/** `value.trim()` when it is *exactly* one token (nothing else on either side), else null. */
function matchWholeToken(value: string): RawToken | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const tokens = scanTokens(trimmed);
  return tokens.length === 1 && tokens[0].raw === trimmed ? tokens[0] : null;
}

/** Cuts a line at its first ` #` (the comment convention every real template uses — at least
 *  one space before the `#`, so `#` inside a real value like a URL is left alone). */
function stripInlineComment(line: string): string {
  return line.replace(/\s+#.*$/, '');
}

const KV_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

function prettify(text: string): string {
  const words = text
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ---- parseTemplate --------------------------------------------------------------------------

export type TemplatePlaceholderKind = 'well-known' | 'field' | 'generic';

export interface TemplatePlaceholder {
  kind: TemplatePlaceholderKind;
  /** Substitution key into `RenderVars` (well-known) or `RenderVars.fields` (field/generic). */
  key: string;
  /** Human label for a modal input. Set for 'field' and 'generic' only — 'well-known'
   *  placeholders never get their own input (id/name/type/scope come from the shared
   *  New-node-style fields; date/today/package/descriptor are computed, not prompted). */
  label?: string;
}

export interface ParsedTemplate {
  /** Raw text between the `---` fences, exactly as authored (including comments). */
  frontmatterText: string;
  /** Everything after the closing `---` fence. */
  body: string;
  /** Distinct placeholders found, in first-seen order (frontmatter, then body). */
  placeholders: TemplatePlaceholder[];
}

const WELL_KNOWN_VARS = new Set(['id', 'name', 'type', 'scope', 'date', 'today', 'package', 'descriptor']);
/** Frontmatter keys always driven by the shared New-node-style fields, never scanned for
 *  placeholders and always overwritten wholesale by `renderTemplate` — see its doc comment. */
const BOOKKEEPING_KEYS = new Set(['id', 'type', 'name', 'scope']);

class PlaceholderCollector {
  private readonly seen = new Set<string>();
  readonly placeholders: TemplatePlaceholder[] = [];

  add(kind: TemplatePlaceholderKind, key: string, label?: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.placeholders.push({ kind, key, label });
  }

  classify(tok: RawToken, fieldKey: string | undefined): void {
    if (tok.curly) {
      if (tok.label !== undefined) {
        this.add('field', `field:${slugify(tok.label)}`, tok.label.trim());
        return;
      }
      const name = tok.name!.toLowerCase();
      if (WELL_KNOWN_VARS.has(name)) this.add('well-known', name);
      else this.add('generic', name, prettify(name));
      return;
    }
    const normalized = tok.angleText!.trim().toLowerCase();
    if (normalized === 'yyyy-mm-dd') {
      this.add('well-known', 'date');
      return;
    }
    if (normalized === 'slug' && !fieldKey) {
      this.add('well-known', 'id');
      return;
    }
    const key = fieldKey ? `${fieldKey.toLowerCase()}:${normalized}` : normalized;
    const label = fieldKey ? prettify(fieldKey) : prettify(tok.angleText!);
    this.add('generic', key, label);
  }
}

/** Finds the token used as the whole `name:` value, if any — see the module doc comment. */
function findNameToken(frontmatterText: string): string | null {
  for (const raw of frontmatterText.split('\n')) {
    const value = stripInlineComment(raw);
    const trimmed = value.trim();
    const kv = KV_RE.exec(trimmed);
    if (!kv || kv[1].toLowerCase() !== 'name') continue;
    const sole = matchWholeToken(kv[2]);
    return sole ? sole.raw : null;
  }
  return null;
}

/**
 * Splits a template file into frontmatter text + body, and collects every distinct fillable
 * placeholder (see the module doc comment for the syntax). The bookkeeping `id`/`type`/`name`/
 * `scope` frontmatter lines are never scanned — they're always driven by the shared New-node
 * fields (type picker, name, id, scope), like `../authoring/new-node-modal.ts`.
 */
export function parseTemplate(text: string): ParsedTemplate {
  const lines = text.split('\n');
  let frontmatterText = '';
  let body = text;
  if (lines[0]?.trim() === '---') {
    const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (closeIdx > 0) {
      frontmatterText = lines.slice(1, closeIdx).join('\n');
      body = lines
        .slice(closeIdx + 1)
        .join('\n')
        .replace(/^\n+/, '');
    }
  }

  const collector = new PlaceholderCollector();
  for (const raw of frontmatterText.split('\n')) {
    const value = stripInlineComment(raw);
    const trimmed = value.trim();
    const kv = KV_RE.exec(trimmed);
    if (!kv) continue;
    const lowerKey = kv[1].toLowerCase();
    if (BOOKKEEPING_KEYS.has(lowerKey)) continue;
    for (const tok of scanTokens(kv[2])) collector.classify(tok, kv[1]);
  }

  const nameToken = findNameToken(frontmatterText);
  const bodyForScan = nameToken ? body.split(nameToken).join('') : body;
  for (const tok of scanTokens(bodyForScan)) collector.classify(tok, undefined);

  return { frontmatterText, body, placeholders: collector.placeholders };
}

// ---- renderTemplate -------------------------------------------------------------------------

export interface RenderVars {
  id: string;
  name: string;
  type: string;
  scope?: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Usually the same value as `date` — kept distinct because `{{today}}` and `{{date}}` are
   *  both well-known variables a template may use independently. */
  today: string;
  package?: string;
  /** The loose end's original descriptor, when created via "Create entity from loose end". */
  descriptor?: string;
  /** Values for every 'field'/'generic' placeholder, keyed by `TemplatePlaceholder.key`. */
  fields?: Record<string, string>;
}

const YAML_SPECIAL_LEADING_RE = /^[!&*?|>%@`"'\-[\]{},:]/;
const YAML_RESERVED_WORD_RE = /^(true|false|null|yes|no|~)$/i;

function needsYamlQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (/^\s|\s$/.test(value)) return true;
  if (value.includes(': ') || value.endsWith(':')) return true;
  if (value.includes(' #')) return true;
  if (YAML_SPECIAL_LEADING_RE.test(value)) return true;
  if (YAML_RESERVED_WORD_RE.test(value)) return true;
  return false;
}

function yamlScalar(value: string): string {
  if (!needsYamlQuoting(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function resolveWellKnown(name: string, vars: RenderVars): string {
  switch (name) {
    case 'id':
      return vars.id;
    case 'name':
      return vars.name;
    case 'type':
      return vars.type;
    case 'scope':
      return vars.scope ?? '';
    case 'date':
      return vars.date;
    case 'today':
      return vars.today;
    case 'package':
      return vars.package ?? '';
    case 'descriptor':
      return vars.descriptor ?? '';
    default:
      return '';
  }
}

/** Substitutes every token found in `text` (via `scanTokens`) — `fieldKey` is the enclosing
 *  frontmatter field name (undefined for the body, or for a full-line comment), matching how
 *  `parseTemplate`/`PlaceholderCollector.classify` keyed that same token when scanning. */
function substitute(text: string, fieldKey: string | undefined, vars: RenderVars): string {
  const tokens = scanTokens(text);
  if (tokens.length === 0) return text;
  const fields = vars.fields ?? {};
  let result = '';
  let cursor = 0;
  for (const tok of tokens) {
    result += text.slice(cursor, tok.index);
    if (tok.curly) {
      if (tok.label !== undefined) {
        result += fields[`field:${slugify(tok.label)}`] ?? '';
      } else {
        const name = tok.name!.toLowerCase();
        result += WELL_KNOWN_VARS.has(name) ? resolveWellKnown(name, vars) : (fields[name] ?? '');
      }
    } else {
      const normalized = tok.angleText!.trim().toLowerCase();
      if (normalized === 'yyyy-mm-dd') {
        result += vars.date;
      } else if (normalized === 'slug' && !fieldKey) {
        result += vars.id;
      } else {
        const key = fieldKey ? `${fieldKey.toLowerCase()}:${normalized}` : normalized;
        result += fields[key] ?? '';
      }
    }
    cursor = tok.index + tok.raw.length;
  }
  result += text.slice(cursor);
  return result;
}

/** Splits a line at its first ` #comment`, returning `[value, comment]` (`comment` includes the
 *  leading whitespace + `#`, or `''`). Substitution only ever touches `value` — an occurrence of
 *  a placeholder-shaped word inside a comment (e.g. `# edges: [person:<slug>]`, documenting the
 *  shape of an edge list the modal doesn't prompt for) is left completely untouched, mirroring
 *  `parseTemplate`, which never scans comments in the first place. */
function valueAndComment(line: string): [string, string] {
  const value = stripInlineComment(line);
  return [value, line.slice(value.length)];
}

/**
 * Renders a parsed template: the `id`/`type`/`name`/`scope` frontmatter lines are always
 * rewritten wholesale from `vars` (whatever the template's own `id:`/`name:`/… line looked
 * like — same shape as `../authoring/pure.ts`'s `buildNodeFile`), every other frontmatter line
 * and the body get their placeholders substituted in place, and comments are never touched.
 */
export function renderTemplate(template: ParsedTemplate, vars: RenderVars): string {
  const nameToken = findNameToken(template.frontmatterText);

  const outLines: string[] = [`id: ${vars.id}`, `type: ${vars.type}`, `name: ${yamlScalar(vars.name)}`];
  if (vars.scope) outLines.push(`scope: ${vars.scope}`);

  for (const raw of template.frontmatterText.split('\n')) {
    const [value, comment] = valueAndComment(raw);
    const kv = KV_RE.exec(value.trim());
    const fieldKey = kv?.[1];
    if (fieldKey && BOOKKEEPING_KEYS.has(fieldKey.toLowerCase())) continue;
    const withName = nameToken ? value.split(nameToken).join(vars.name) : value;
    outLines.push(substitute(withName, fieldKey, vars) + comment);
  }

  const bodyWithName = nameToken ? template.body.split(nameToken).join(vars.name) : template.body;
  const body = substitute(bodyWithName, undefined, vars);

  return `---\n${outLines.join('\n')}\n---\n${body}`;
}

// ---- id defaults -----------------------------------------------------------------------------

/** Record ids for dated types default to `{date}-{slug(name)}`; everything else just
 *  `slug(name)`, matching `../authoring/pure.ts`'s plain (undated) `NewNodeModal` behavior. */
export function defaultIdFor(type: string, name: string, date: string, datedTypes: string[]): string {
  const slug = slugify(name);
  return datedTypes.includes(type) ? `${date}-${slug}` : slug;
}

/** Whether a template's own `id:` line looks date-prefixed (`<yyyy-mm-dd>-…` or
 *  `{{date}}-…`/`{{today}}-…`) — used to decide whether `defaultIdFor` should treat this
 *  template's type as a dated type, without maintaining a hardcoded type list. */
export function templateIdLooksDated(frontmatterText: string): boolean {
  for (const raw of frontmatterText.split('\n')) {
    const value = stripInlineComment(raw).trim();
    const kv = KV_RE.exec(value);
    if (!kv || kv[1].toLowerCase() !== 'id') continue;
    return /^(<yyyy-mm-dd>|\{\{\s*date\s*\}\}|\{\{\s*today\s*\}\})-/i.test(kv[2].trim());
  }
  return false;
}

// ---- package template discovery ---------------------------------------------------------------

export interface PackageTemplateFile {
  type: string;
  /** Vault-relative path (relative to the vault root, i.e. including the package's own dir). */
  path: string;
}

/**
 * Finds `<templateFolder>/<type>.md` files among `paths` (already package-root-relative, i.e.
 * with the package's own directory prefix stripped by the caller) — one level deep only, so a
 * nested folder under the template folder is ignored rather than misread as a type name.
 */
export function listPackageTemplates(paths: string[], templateFolder = 'templates'): PackageTemplateFile[] {
  const folder = templateFolder.replace(/^\/+|\/+$/g, '');
  const prefix = folder ? `${folder}/` : '';
  const out: PackageTemplateFile[] = [];
  for (const p of paths) {
    if (!p.endsWith('.md')) continue;
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = prefix ? p.slice(prefix.length) : p;
    if (rest.includes('/')) continue;
    const type = rest.slice(0, -3);
    if (!type) continue;
    out.push({ type, path: p });
  }
  return out;
}

// ---- template picker options ------------------------------------------------------------------

export type TemplateSourceSetting = 'package' | 'builtin' | 'both';

export interface TemplateOption {
  type: string;
  source: 'package' | 'builtin';
  label: string;
  /** Vault-relative path to read, when `source === 'package'`. */
  path?: string;
  /** Key into `BUILTIN_TEMPLATES` (builtin.ts), when `source === 'builtin'`. */
  builtinKey?: string;
}

/**
 * The trade-off this whole feature is built around (see BRANCHES.md `feat/record-templates`):
 * `'package'` only offers a type that has a curated `<templateFolder>/<type>.md` file;
 * `'builtin'` offers every one of the package's declared types from the shipped presets
 * (`builtinFor` always returns one — see builtin.ts's generic "entity" fallback); `'both'`
 * (default) prefers the package template per type, falling back to a builtin preset for a type
 * the package hasn't curated one for, and labels each option with its source either way.
 */
export function listTemplateOptions(
  types: string[],
  packageTemplates: PackageTemplateFile[],
  source: TemplateSourceSetting,
  builtinFor: (type: string) => { key: string; label: string } | undefined,
): TemplateOption[] {
  const byType = new Map(packageTemplates.map((t) => [t.type, t] as const));
  const allTypes = new Set<string>([...types, ...byType.keys()]);
  const options: TemplateOption[] = [];

  for (const type of allTypes) {
    const pkgTpl = byType.get(type);
    if (source === 'package') {
      if (pkgTpl) options.push({ type, source: 'package', label: `${type} (package template)`, path: pkgTpl.path });
      continue;
    }
    if (source === 'builtin') {
      const b = builtinFor(type);
      if (b) options.push({ type, source: 'builtin', label: `${type} (builtin: ${b.label})`, builtinKey: b.key });
      continue;
    }
    if (pkgTpl) {
      options.push({ type, source: 'package', label: `${type} (package template)`, path: pkgTpl.path });
    } else {
      const b = builtinFor(type);
      if (b) options.push({ type, source: 'builtin', label: `${type} (builtin: ${b.label})`, builtinKey: b.key });
    }
  }

  return options.sort((a, b) => a.type.localeCompare(b.type));
}
