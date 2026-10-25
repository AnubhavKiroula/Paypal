import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/client.js';
import type { ProviderAdapter, ProviderResponse } from '../src/provider.js';

// Real timers and a real garbage collector: a settled call must not keep its response reachable.

function isCallable(value: unknown): value is () => void {
  return typeof value === 'function';
}

function exposeGc(): () => void {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (!isCallable(gc)) throw new Error('gc is not available');
  return gc;
}

it('does not keep any response reachable after its call settles', async () => {
  const gc = exposeGc();
  const responses: WeakRef<ProviderResponse>[] = [];
  const adapter: ProviderAdapter = {
    provider: 'stub',
    model: 'stub-model',
    complete: () => {
      const response: ProviderResponse = {
        text: JSON.stringify({ answer: 1, pad: 'x'.repeat(10_000) }),
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'stub-model',
        stopReason: 'end',
      };
      responses.push(new WeakRef(response));
      return Promise.resolve(response);
    },
  };
  const client = new LlmClient({ adapter, timeoutMs: 60_000, maxOutputTokens: 1_000 });
  const schema = z.strictObject({ answer: z.int(), pad: z.string() });

  for (let call = 0; call < 10; call++) {
    await client.generateStructured({ schemaName: 'memory', schema, system: 'S', parts: [{ kind: 'trusted', text: 'T' }] });
  }
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }

  expect(responses).toHaveLength(10);
  expect(responses.filter((ref) => ref.deref() !== undefined).length).toBeLessThanOrEqual(1);
});
