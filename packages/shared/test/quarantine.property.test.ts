import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { quarantineText } from '../src/quarantine.js';

// Defined independently of the implementation so the tests do not share its regexes.
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;
const ANGLE = /[<>]/;

const interesting = fc.constantFrom(
  '<', '>', '\uFF1C', '\uFF1E', '\uFE64', '\uFE65', '<!--', '-->', '<b>', '</b>',
  '\u202E', '\u2066', '\u061C', '\u200B', '\u200D', '\uFEFF', '\u00AD', '\u180E',
  '\u0000', '\u001B', '\u007F', '\u0085', '\r', '\n', '\t', '\u2028', '\u2029',
  '\u{E0041}', '\u{E007F}', 'e', '\u0301', '\uD800', '\uDC00', '\u{1F600}', '\uFB01', ' ', '\u00A0', '\u3000',
);
// Any code point, including lone surrogates (String.fromCodePoint accepts them).
const anyCodePoint = fc.integer({ min: 0, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp));
const text = fc.string({
  unit: fc.oneof({ arbitrary: interesting, weight: 3 }, { arbitrary: anyCodePoint, weight: 2 }),
  maxLength: 300,
});
const limit = fc.integer({ min: 13, max: 400 });
const RUNS = { numRuns: 1_000 };

describe('quarantineText properties', () => {
  it('never throws, on any value', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        quarantineText(raw);
      }),
      RUNS,
    );
  });

  it('emits no forbidden code point or angle bracket, even after NFKC', () => {
    fc.assert(
      fc.property(text, limit, (raw, maxCodePoints) => {
        const out = quarantineText(raw, { maxCodePoints }).text;
        for (const candidate of [out, out.normalize('NFKC')]) {
          expect(candidate).not.toMatch(FORBIDDEN);
          expect(candidate).not.toMatch(ANGLE);
        }
        expect(out.isWellFormed()).toBe(true);
      }),
      RUNS,
    );
  });

  it('stays within the code-point limit', () => {
    fc.assert(
      fc.property(text, limit, (raw, maxCodePoints) => {
        expect([...quarantineText(raw, { maxCodePoints }).text].length).toBeLessThanOrEqual(maxCodePoints);
      }),
      RUNS,
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(text, limit, (raw, maxCodePoints) => {
        const once = quarantineText(raw, { maxCodePoints }).text;
        expect(quarantineText(once, { maxCodePoints }).text).toBe(once);
      }),
      RUNS,
    );
  });
});
