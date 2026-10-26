import { quarantineText } from '@mandate/shared';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_NONCE_ATTEMPTS,
  NONCE_BYTES,
  NonceExhaustedError,
  type NonceSource,
  type UntrustedPart,
  renderUntrustedBlock,
  renderUserText,
} from '../src/prompt.js';

const fixed = (byte: number): NonceSource => (length) => new Uint8Array(length).fill(byte);
const hexOf = (byte: number) => byte.toString(16).padStart(2, '0').repeat(NONCE_BYTES);
const part = (raw: string, label = 'product_title'): UntrustedPart => ({ kind: 'untrusted', label, text: quarantineText(raw).text });
const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
/** A part whose brand was forged with an object cast, which the lint guard cannot see. */
const forged = (text: string) => ({ kind: 'untrusted', label: 'product_title', text }) as UntrustedPart;

// Characters that stress normalization at a truncation cut: Hangul jamo, Oriya vowel parts,
// combining marks, ligatures, surrogates, and the brackets and controls quarantine rewrites.
const tricky = fc.constantFrom(
  ...[0x1100, 0x1161, 0x11a8, 0xac00, 0x0b47, 0x0b3e, 0x0b56, 0x65, 0x301, 0x323, 0xfb01, 0xd800, 0xdc00, 0x1f600, 0x3c, 0x3e, 0xff1c, 0x202e, 0x200d, 0xa0, 0x0a, 0x20].map((c) => cp(c)),
);
const trickyText = fc.string({ unit: fc.oneof({ arbitrary: tricky, weight: 3 }, { arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }), weight: 2 }), maxLength: 300 });

describe('renderUntrustedBlock', () => {
  it('wraps quarantined text in nonce-tagged delimiters', () => {
    expect(renderUntrustedBlock(part('Blue mug'), fixed(0xab))).toBe(
      `<untrusted_data id="${hexOf(0xab)}" label="product_title">\nBlue mug\n</untrusted_data id="${hexOf(0xab)}">`,
    );
  });

  it('draws a new nonce when the text already contains one, in either case', () => {
    const source = vi.fn<NonceSource>().mockImplementationOnce(fixed(0xab)).mockImplementationOnce(fixed(0xcd));
    const rendered = renderUntrustedBlock(part(`token ${hexOf(0xab).toUpperCase()}`), source);
    expect(source).toHaveBeenCalledTimes(2);
    expect(rendered).toContain(`id="${hexOf(0xcd)}"`);
  });

  it('throws NonceExhaustedError after a bounded number of collisions', () => {
    const source = vi.fn<NonceSource>(fixed(0x11));
    expect(() => renderUntrustedBlock(part(`collide ${hexOf(0x11)}`), source)).toThrow(NonceExhaustedError);
    expect(source).toHaveBeenCalledTimes(MAX_NONCE_ATTEMPTS);
  });

  it('rejects a nonce source that returns too few bytes', () => {
    expect(() => renderUntrustedBlock(part('x'), () => new Uint8Array(4))).toThrow(RangeError);
  });

  it.each(['Product', 'has space', 'a"b', '', 'x'.repeat(33)])('rejects the label %j', (label) => {
    expect(() => renderUntrustedBlock(part('x', label), fixed(1))).toThrow(RangeError);
  });

  it('never lets the nonce appear inside the wrapped text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.uint8Array({ minLength: NONCE_BYTES, maxLength: NONCE_BYTES }), (raw, bytes) => {
        const untrusted = part(`${raw} ${Buffer.from(bytes).toString('hex')}`);
        let calls = 0;
        const source: NonceSource = (length) => (calls++ === 0 ? bytes : new Uint8Array(length).fill(calls));
        const rendered = renderUntrustedBlock(untrusted, source);
        const nonce = /id="([0-9a-f]{32})"/.exec(rendered)?.[1] ?? '';
        expect(nonce).toHaveLength(32);
        expect(untrusted.text.toLowerCase()).not.toContain(nonce);
      }),
      { numRuns: 500 },
    );
  });
});

describe('renderUntrustedBlock runtime quarantine check', () => {
  it('accepts every quarantineText output, at every limit', () => {
    fc.assert(
      fc.property(trickyText, fc.integer({ min: 13, max: 400 }), (raw, maxCodePoints) => {
        const text = quarantineText(raw, { maxCodePoints }).text;
        expect(() => renderUntrustedBlock({ kind: 'untrusted', label: 'title', text }, fixed(0xab))).not.toThrow();
      }),
      { numRuns: 2_000 },
    );
  });

  it.each([
    ['a bidi override', `Cable ${cp(0x202e)}gnp.exe`],
    ['a tag character', `Cable${cp(0xe0049)}`],
    ['raw HTML', 'Cable <b>sale</b>'],
    ['untrimmed text', ' Cable '],
    ['a fullwidth letter NFKC would fold', `Cable ${cp(0xff21)}`],
    ['a zero-width space', `Ca${cp(0x200b)}ble`],
  ])('rejects a forged part carrying %s, with a message free of the text', (_label, text) => {
    expect(() => renderUntrustedBlock(forged(text), fixed(0xab))).toThrow(
      new TypeError('Untrusted part text was not produced by quarantineText'),
    );
  });
});

describe('renderUserText', () => {
  it('renders trusted text as-is, untrusted text wrapped, then the appendix', () => {
    const text = renderUserText([{ kind: 'trusted', text: 'Choose one.' }, part('Blue mug')], fixed(0x01), 'Fix the JSON.');
    expect(text).toBe(
      `Choose one.\n\n<untrusted_data id="${hexOf(0x01)}" label="product_title">\nBlue mug\n</untrusted_data id="${hexOf(0x01)}">\n\nFix the JSON.`,
    );
  });
});
