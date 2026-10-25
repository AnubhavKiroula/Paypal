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

describe('renderUserText', () => {
  it('renders trusted text as-is, untrusted text wrapped, then the appendix', () => {
    const text = renderUserText([{ kind: 'trusted', text: 'Choose one.' }, part('Blue mug')], fixed(0x01), 'Fix the JSON.');
    expect(text).toBe(
      `Choose one.\n\n<untrusted_data id="${hexOf(0x01)}" label="product_title">\nBlue mug\n</untrusted_data id="${hexOf(0x01)}">\n\nFix the JSON.`,
    );
  });
});
