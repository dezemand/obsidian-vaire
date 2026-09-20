import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_BUILTIN_TEMPLATES, builtinTemplateFor } from '../src/templates/builtin';
import {
  defaultIdFor,
  listPackageTemplates,
  listTemplateOptions,
  parseTemplate,
  renderTemplate,
  templateIdLooksDated,
  type RenderVars,
} from '../src/templates/pure';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'template-decision.md');

describe('parseTemplate — a real-shaped templates/decision.md', () => {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const parsed = parseTemplate(raw);

  test('splits frontmatter from body', () => {
    expect(parsed.frontmatterText).toContain('type: decision');
    expect(parsed.body.trim()).toStartWith('# <Display Name>');
  });

  test('the name placeholder (<Display Name>) is not offered as a field', () => {
    expect(parsed.placeholders.some((p) => p.key === 'name')).toBe(false);
    expect(parsed.placeholders.some((p) => p.label === 'Display Name')).toBe(false);
  });

  test('<yyyy-mm-dd> in the date: field is recognized as the well-known date var, not prompted', () => {
    const date = parsed.placeholders.find((p) => p.key === 'date');
    expect(date).toBeDefined();
    expect(date!.kind).toBe('well-known');
  });

  test('<slug> inside a comment (deciders: []  # edges: [person:<slug>]) is not a placeholder', () => {
    expect(parsed.placeholders.some((p) => p.key.includes('deciders'))).toBe(false);
  });

  test('<slug> in the live proposal: field becomes a field-keyed prompt, not a bare "slug"', () => {
    const proposal = parsed.placeholders.find((p) => p.key === 'proposal:slug');
    expect(proposal).toBeDefined();
    expect(proposal!.kind).toBe('generic');
    expect(proposal!.label).toBe('Proposal');
  });

  test('id/type lines never produce placeholders', () => {
    expect(parsed.placeholders.some((p) => p.key === 'id')).toBe(false);
    expect(parsed.placeholders.some((p) => p.key === 'type')).toBe(false);
  });

  test('templateIdLooksDated is true (id: <yyyy-mm-dd>-<slug>)', () => {
    expect(templateIdLooksDated(parsed.frontmatterText)).toBe(true);
  });
});

describe('renderTemplate — the same decision.md', () => {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const parsed = parseTemplate(raw);

  const vars: RenderVars = {
    id: '2026-09-16-shard-by-broker-id',
    name: 'Shard by broker id',
    type: 'decision',
    date: '2026-09-16',
    today: '2026-09-16',
    fields: { 'proposal:slug': 'broker-sharding' },
  };

  test('rewrites id/type/name wholesale from vars, ignoring the template placeholder shape', () => {
    const out = renderTemplate(parsed, vars);
    expect(out).toContain('id: 2026-09-16-shard-by-broker-id');
    expect(out).toContain('type: decision');
    expect(out).toContain('name: Shard by broker id');
  });

  test('fills the proposal: field from the field value', () => {
    const out = renderTemplate(parsed, vars);
    expect(out).toContain('proposal: proposal:broker-sharding');
  });

  test('fills date: with vars.date', () => {
    const out = renderTemplate(parsed, vars);
    expect(out).toContain('date: 2026-09-16');
  });

  test('leaves the deciders: [] comment untouched (not corrupted by the unrelated <slug> field prompt)', () => {
    const out = renderTemplate(parsed, vars);
    expect(out).toContain('deciders: []                      # edges: [person:<slug>]');
  });

  test('the body H1 and prose use the resolved name, not the placeholder', () => {
    const out = renderTemplate(parsed, vars);
    expect(out).toContain('# Shard by broker id');
    expect(out).not.toContain('<Display Name>');
  });

  test('an unfilled generic field renders as empty rather than leaving the raw placeholder', () => {
    const out = renderTemplate(parsed, { ...vars, fields: {} });
    expect(out).toContain('proposal: proposal:         # edge');
    // The unrelated <slug> inside the deciders: [] comment is untouched either way — it was
    // never a fillable placeholder (see the "<slug> inside a comment" parseTemplate test).
    expect(out).toContain('deciders: []                      # edges: [person:<slug>]');
  });
});

describe('a template with two distinct fields sharing the same <slug> word (firewall-policy-shaped)', () => {
  const raw = `---
id: <slug>
type: firewall-policy
name: <Display Name>
from: network:<slug>              # edge
to: network:<slug>                # edge
status: active
---
# <Display Name>

Rules.
`;

  test('from: and to: are kept as separate prompts, not merged', () => {
    const parsed = parseTemplate(raw);
    const keys = parsed.placeholders.map((p) => p.key);
    expect(keys).toContain('from:slug');
    expect(keys).toContain('to:slug');
  });

  test('rendering fills each field independently', () => {
    const parsed = parseTemplate(raw);
    const out = renderTemplate(parsed, {
      id: 'egress-to-scada',
      name: 'Egress to SCADA',
      type: 'firewall-policy',
      date: '2026-09-16',
      today: '2026-09-16',
      fields: { 'from:slug': 'lab-it-vlan120', 'to:slug': 'ot-vlan10' },
    });
    expect(out).toContain('from: network:lab-it-vlan120');
    expect(out).toContain('to: network:ot-vlan10');
  });
});

describe('a bare <slug> in the body (no enclosing field) means "this node\'s own id"', () => {
  const raw = `---
id: <slug>
type: vm
name: <hostname>
status: active
---
# <hostname>

Applications on it are found via \`vaire backlinks vm:<slug>\`.
`;

  test('is recognized as the well-known id var, not a generic field', () => {
    const parsed = parseTemplate(raw);
    expect(parsed.placeholders.some((p) => p.kind === 'generic')).toBe(false);
  });

  test('renders as this node\'s own id', () => {
    const parsed = parseTemplate(raw);
    const out = renderTemplate(parsed, {
      id: 'lab-vm-07',
      name: 'lab-vm-07.acme.local',
      type: 'vm',
      date: '2026-09-16',
      today: '2026-09-16',
    });
    expect(out).toContain('vaire backlinks vm:lab-vm-07');
  });
});

describe('defaultIdFor', () => {
  test('dated type: {date}-{slug}', () => {
    expect(defaultIdFor('decision', 'Shard by broker id', '2026-09-16', ['decision'])).toBe(
      '2026-09-16-shard-by-broker-id',
    );
  });

  test('non-dated type: just the slug', () => {
    expect(defaultIdFor('server', 'lab-vm-07', '2026-09-16', ['decision'])).toBe('lab-vm-07');
  });

  test('empty datedTypes never dates the id', () => {
    expect(defaultIdFor('record', 'Broker sync', '2026-09-16', [])).toBe('broker-sync');
  });
});

describe('listPackageTemplates', () => {
  test('finds one-level-deep <type>.md files under the template folder', () => {
    const paths = ['templates/decision.md', 'templates/application.md', 'decisions/2026-01-01-x.md'];
    const found = listPackageTemplates(paths, 'templates');
    expect(found).toEqual(
      expect.arrayContaining([
        { type: 'decision', path: 'templates/decision.md' },
        { type: 'application', path: 'templates/application.md' },
      ]),
    );
    expect(found.length).toBe(2);
  });

  test('ignores a nested folder under the template folder', () => {
    const found = listPackageTemplates(['templates/archived/old.md'], 'templates');
    expect(found).toEqual([]);
  });

  test('a custom templateFolder is honored', () => {
    const found = listPackageTemplates(['_templates/site.md'], '_templates');
    expect(found).toEqual([{ type: 'site', path: '_templates/site.md' }]);
  });

  test('defaults to "templates"', () => {
    const found = listPackageTemplates(['templates/org.md']);
    expect(found).toEqual([{ type: 'org', path: 'templates/org.md' }]);
  });
});

describe('listTemplateOptions', () => {
  const types = ['decision', 'application', 'site'];
  const packageTemplates = [{ type: 'decision', path: 'templates/decision.md' }];
  const builtinFor = (type: string) => (type === 'decision' || type === 'application' || type === 'site' ? { key: type === 'decision' ? 'decision' : 'entity', label: type === 'decision' ? 'Decision' : 'Generic entity' } : undefined);

  test("'package': only types with a curated template file", () => {
    const options = listTemplateOptions(types, packageTemplates, 'package', builtinFor);
    expect(options.map((o) => o.type)).toEqual(['decision']);
    expect(options[0].source).toBe('package');
  });

  test("'builtin': every declared type, all builtin-sourced", () => {
    const options = listTemplateOptions(types, packageTemplates, 'builtin', builtinFor);
    expect(options.every((o) => o.source === 'builtin')).toBe(true);
    expect(options.map((o) => o.type).sort()).toEqual(['application', 'decision', 'site']);
  });

  test("'both': package template wins where curated, builtin fills the rest", () => {
    const options = listTemplateOptions(types, packageTemplates, 'both', builtinFor);
    const byType = new Map(options.map((o) => [o.type, o.source]));
    expect(byType.get('decision')).toBe('package');
    expect(byType.get('application')).toBe('builtin');
    expect(byType.get('site')).toBe('builtin');
  });
});

describe('builtin presets', () => {
  for (const preset of ALL_BUILTIN_TEMPLATES) {
    test(`${preset.key}: parses and renders with id/type/name (+ scope when given)`, () => {
      const parsed = parseTemplate(preset.text);
      const vars: RenderVars = {
        id: `${preset.key}-example`,
        name: `${preset.key} example`,
        type: preset.key === 'entity' ? 'concept' : preset.key,
        scope: 'project:atlas-2026-q2',
        date: '2026-09-16',
        today: '2026-09-16',
      };
      const out = renderTemplate(parsed, vars);
      expect(out).toContain(`id: ${vars.id}`);
      expect(out).toContain(`type: ${vars.type}`);
      expect(out).toContain(`name: ${vars.name}`);
      expect(out).toContain('scope: project:atlas-2026-q2');
      expect(out).toContain(`# ${vars.name}`);
    });
  }

  test('record and decision default ids look dated', () => {
    expect(templateIdLooksDated(parseTemplate(builtinTemplateFor('record').text).frontmatterText)).toBe(true);
    expect(templateIdLooksDated(parseTemplate(builtinTemplateFor('decision').text).frontmatterText)).toBe(true);
  });

  test('guide and the generic entity fallback default ids are not dated', () => {
    expect(templateIdLooksDated(parseTemplate(builtinTemplateFor('guide').text).frontmatterText)).toBe(false);
    expect(templateIdLooksDated(parseTemplate(builtinTemplateFor('some-unknown-type').text).frontmatterText)).toBe(
      false,
    );
  });

  test('decision preset ships status: proposed', () => {
    expect(builtinTemplateFor('decision').text).toContain('status: proposed');
  });

  test('builtinTemplateFor falls back to the generic entity preset for an unknown type', () => {
    expect(builtinTemplateFor('server').key).toBe('entity');
  });
});
