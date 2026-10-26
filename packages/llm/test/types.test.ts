import { type Quarantined, quarantineText } from '@mandate/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PromptPart } from '../src/prompt.js';
import type { ProviderRequest } from '../src/provider.js';

// These assertions are checked by `pnpm typecheck` (tsc). An unused @ts-expect-error is itself a
// compile error, so each one fails the build if the line below it ever starts to compile.

describe('ProviderRequest type', () => {
  it('has no tool-calling or sampling fields', () => {
    expectTypeOf<ProviderRequest>().not.toHaveProperty('tools');
    expectTypeOf<ProviderRequest>().not.toHaveProperty('tool_choice');
    expectTypeOf<ProviderRequest>().not.toHaveProperty('functions');
    expectTypeOf<ProviderRequest>().not.toHaveProperty('temperature');
    expectTypeOf<ProviderRequest>().not.toHaveProperty('top_p');
    expectTypeOf<ProviderRequest>().not.toHaveProperty('top_k');
  });

  it('rejects a request literal that carries tools', () => {
    const request: ProviderRequest = {
      system: 's',
      userText: 'u',
      maxOutputTokens: 1,
      timeoutMs: 1,
      // @ts-expect-error -- ProviderRequest has no tools field
      tools: [],
    };
    expect(request.system).toBe('s');
  });
});

describe('Quarantined type', () => {
  it('rejects a plain string where quarantined text is required', () => {
    const takesQuarantined = (text: Quarantined<string>) => text.length;
    // @ts-expect-error -- a plain string is not Quarantined
    expect(takesQuarantined('raw retailer text')).toBe(17);
    expect(takesQuarantined(quarantineText('raw retailer text').text)).toBe(17);
  });

  it('rejects an untrusted prompt part built from a plain string', () => {
    // @ts-expect-error -- untrusted parts require quarantined text
    const bad: PromptPart = { kind: 'untrusted', label: 'title', text: 'raw' };
    const good: PromptPart = { kind: 'untrusted', label: 'title', text: quarantineText('raw').text };
    expect([bad.kind, good.kind]).toEqual(['untrusted', 'untrusted']);
  });

  it('still allows quarantined text wherever a string is expected', () => {
    expectTypeOf<Quarantined<string>>().toExtend<string>();
  });
});
