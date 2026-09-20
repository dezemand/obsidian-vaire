import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUILTIN_FAMILY_COLORS,
  FAMILY_ORDER,
  colorFor,
  familyOf,
  familyOfHash,
  fnv1a32,
  hashHue,
  parseRendererToml,
  type RendererFamilyConfig,
} from '../src/theme/families';

const HEX_RE = /^#[0-9a-f]{6}$/i;

// The real, committed config the `vaire` package's badges are meant to match on the published
// site (see renderer-conventions.md §4 and BRANCHES.md `feat/type-colors`). Set VAIRE_TEST_REPO
// to the absolute path of that package's checkout (a directory with `vaire-renderer.toml`) to
// run this describe block; it is skipped otherwise. See README.md "Running the tests".
const VAIRE_TEST_REPO = process.env.VAIRE_TEST_REPO;

// `describe.skipIf` still evaluates the describe body eagerly (to collect its tests), so the
// real `fs.readFileSync` must not run at all when VAIRE_TEST_REPO is unset — guard with a plain
// `if` instead of relying on skipIf to short-circuit it.
if (VAIRE_TEST_REPO) {
  const REAL_CONFIG_PATH = path.join(VAIRE_TEST_REPO, 'vaire-renderer.toml');

  describe('parseRendererToml — the real vaire-renderer.toml (VAIRE_TEST_REPO)', () => {
    const raw = fs.readFileSync(REAL_CONFIG_PATH, 'utf8');
    const config = parseRendererToml(raw);

    test('declares [families] with the expected type -> family assignments', () => {
      expect(config.families.why).toContain('decision');
      expect(config.families.what).toContain('cli');
    });

    test('familyOf resolves those assignments (configured wins over built-in/hash)', () => {
      expect(familyOf('decision', config)).toBe('why');
      expect(familyOf('cli', config)).toBe('what');
    });

    test('declares no [family_colors] (per renderer-conventions.md §4: "None uses [family_colors]")', () => {
      expect(config.familyColors).toEqual({});
    });
  });
}

describe('familyOf — built-in table (matches vaire-renderer/src/frontend/mod.rs::BUILTIN_TYPES, unconfigured)', () => {
  // Mirrors the Rust test `defaults_match_the_built_in_design` (mod.rs).
  test.each([
    ['person', 'who'],
    ['application', 'what'],
    ['method', 'how'],
    ['record', 'when'],
    ['decision', 'why'],
    ['project', 'where'],
  ])('%s -> %s', (type, family) => {
    expect(familyOf(type)).toBe(family);
  });
});

describe('familyOf — configured [families] override the built-in table', () => {
  // Mirrors the Rust test `config_reassigns_a_type_to_another_family` (mod.rs).
  test('a brand-new type lands in the family it is configured for', () => {
    const config: RendererFamilyConfig = { families: { what: ['helm-chart'] }, familyColors: {} };
    expect(familyOf('helm-chart', config)).toBe('what');
  });

  test('a built-in type is reassigned when the config says so', () => {
    const config: RendererFamilyConfig = { families: { what: ['person'] }, familyColors: {} };
    expect(familyOf('person', config)).toBe('what');
    // Everything else is untouched.
    expect(familyOf('record', config)).toBe('when');
  });
});

describe('FNV-1a 32-bit hash fallback — ported from FamilyMap::family_of (mod.rs:206-216)', () => {
  // Rust:
  //   let mut h: u32 = 2166136261;             // offset basis, 0x811c9dc5
  //   for b in node_type.bytes() {
  //       h ^= b as u32;
  //       h = h.wrapping_mul(16777619);        // FNV prime
  //   }
  //   &self.families[(h as usize) % BUILTIN_FAMILIES.len()]   // len() == 6, FAMILY_ORDER here
  //
  // Hand-computed for the single byte "a" (0x61 = 97), FAMILY_ORDER = [who, what, how, when, why, where]:
  //   h0            = 2166136261  (0x811c9dc5)
  //   h0 ^ 97       = 2166136228  (0x811c9da4)
  //   * 16777619    = 3826002220  (mod 2^32)    -> h1
  //   h1 % 6        = 4                          -> FAMILY_ORDER[4] = "why"
  test('fnv1a32("a") is the hand-computed value, and lands on family index 4 ("why")', () => {
    expect(fnv1a32('a')).toBe(3826002220);
    expect(3826002220 % FAMILY_ORDER.length).toBe(4);
    expect(FAMILY_ORDER[4]).toBe('why');
    expect(familyOfHash('a')).toBe('why');
  });

  // Hand-computed for two bytes "ab" (0x61 then 0x62), continuing from h1 = 3826002220 (0xe40c292c) above:
  //   h1 ^ 98       = 3826002254  (0xe40c292c ^ 0x62 = 0xe40c294e)
  //   * 16777619    = 1294271946  (mod 2^32)    -> h2
  //   h2 % 6        = 0                          -> FAMILY_ORDER[0] = "who"
  test('fnv1a32("ab") is the hand-computed value, and lands on family index 0 ("who")', () => {
    expect(fnv1a32('ab')).toBe(1294271946);
    expect(1294271946 % FAMILY_ORDER.length).toBe(0);
    expect(FAMILY_ORDER[0]).toBe('who');
    expect(familyOfHash('ab')).toBe('who');
  });

  test('is stable: the same unconfigured type always lands in the same family', () => {
    expect(familyOf('made-up-thing')).toBe(familyOf('made-up-thing'));
    expect(familyOfHash('gap')).toBe(familyOfHash('gap'));
  });

  test('an unconfigured type still gets a real built-in family name, not undefined/empty', () => {
    expect(FAMILY_ORDER).toContain(familyOf('some-type-nobody-declared') as (typeof FAMILY_ORDER)[number]);
  });
});

describe('parseRendererToml — tolerant of missing/partial/malformed input', () => {
  test('empty text', () => {
    expect(parseRendererToml('')).toEqual({ families: {}, familyColors: {} });
  });

  test('only [families], no [family_colors]', () => {
    const config = parseRendererToml('[families]\nwhat = ["cli", "concept"]\n');
    expect(config.families.what).toEqual(['cli', 'concept']);
    expect(config.familyColors).toEqual({});
  });

  test('only [family_colors], no [families]', () => {
    const config = parseRendererToml('[family_colors]\nwhat = { light = "#111111", dark = "#eeeeee" }\n');
    expect(config.families).toEqual({});
    expect(config.familyColors.what).toEqual({ light: '#111111', dark: '#eeeeee' });
  });

  test('unrelated keys (package/output/title/diagrams) are ignored, not errors', () => {
    const config = parseRendererToml('package = "."\noutput = "public"\ntitle = "Vairë"\n[diagrams]\nplantuml = "plantuml -tsvg -pipe"\n');
    expect(config).toEqual({ families: {}, familyColors: {} });
  });

  test('a malformed [family_colors] entry (bad hex, wrong shape) is dropped rather than thrown', () => {
    const config = parseRendererToml('[family_colors]\nwhat = { light = "teal", dark = "#52b4c2" }\nbroken = "not a table"\n');
    expect(config.familyColors).toEqual({});
  });

  test('syntactically invalid TOML degrades to an empty config instead of throwing', () => {
    expect(() => parseRendererToml('this is not [ valid toml')).not.toThrow();
    expect(parseRendererToml('this is not [ valid toml')).toEqual({ families: {}, familyColors: {} });
  });
});

describe('colorFor', () => {
  test('always returns a #rrggbb hex color, for every source', () => {
    expect(colorFor('decision', { source: 'renderer' }, 'light')).toMatch(HEX_RE);
    expect(colorFor('decision', { source: 'renderer' }, 'dark')).toMatch(HEX_RE);
    expect(colorFor('decision', { source: 'hash' }, 'light')).toMatch(HEX_RE);
    expect(colorFor('decision', { source: 'off' }, 'light')).toMatch(HEX_RE);
  });

  test('renderer source, unconfigured type: the built-in family color, verbatim', () => {
    expect(colorFor('decision', { source: 'renderer' }, 'light')).toBe(BUILTIN_FAMILY_COLORS.why.light);
    expect(colorFor('decision', { source: 'renderer' }, 'dark')).toBe(BUILTIN_FAMILY_COLORS.why.dark);
  });

  test('renderer source, a package [family_colors] override wins over the built-in color', () => {
    // Mirrors the Rust test `config_overrides_a_family_colour_and_can_define_a_new_family`.
    const renderer: RendererFamilyConfig = {
      families: { risky: ['gap'] },
      familyColors: { what: { light: '#111111', dark: '#eeeeee' }, risky: { light: '#abc123', dark: '#def456' } },
    };
    expect(colorFor('system', { source: 'renderer', renderer }, 'light')).toBe('#111111');
    expect(colorFor('system', { source: 'renderer', renderer }, 'dark')).toBe('#eeeeee');
    // A brand-new family defined purely by [family_colors] (not one of the 6 built-ins).
    expect(colorFor('gap', { source: 'renderer', renderer }, 'light')).toBe('#abc123');
  });

  test('hash source needs no config and is stable', () => {
    const a = colorFor('cli', { source: 'hash' }, 'light');
    const b = colorFor('cli', { source: 'hash' }, 'light');
    expect(a).toBe(b);
  });

  test('hash source: light and dark differ (readable in both themes, not the same value)', () => {
    expect(colorFor('cli', { source: 'hash' }, 'light')).not.toBe(colorFor('cli', { source: 'hash' }, 'dark'));
  });
});

describe('hashHue', () => {
  test('always in [0, 360)', () => {
    for (const type of ['decision', 'cli', 'a', 'b', 'record', 'made-up-thing']) {
      const hue = hashHue(type);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  test('deterministic', () => {
    expect(hashHue('decision')).toBe(hashHue('decision'));
  });
});
