import { BadRequestError } from '@anthropic-ai/sdk';
import { type TestContext, afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicAdapter, createAnthropicClient } from '../src/adapters/anthropic.js';
import { LlmClient } from '../src/client.js';
import { type LlmConfig, LlmConfigError, loadLlmConfig } from '../src/config.js';

// One real, tiny structured call plus one sampling-parameter probe. Never runs in CI.
// Without a key it prints SKIPPED and every test reports as skipped, never as passed.

function resolveConfig(): { config?: LlmConfig; skipReason?: string } {
  if (process.env['CI']) return { skipReason: 'CI is set; the live smoke never runs in CI' };
  try {
    return { config: loadLlmConfig(process.env) };
  } catch (error) {
    if (error instanceof LlmConfigError && error.variables.length === 1 && error.variables[0] === 'ANTHROPIC_API_KEY') {
      return { skipReason: 'ANTHROPIC_API_KEY is not set' };
    }
    throw error;
  }
}

const { config, skipReason } = resolveConfig();

// Vitest hides module-level output when a whole file is skipped, so each test announces the skip
// itself and records a visible note. A skip is reported as skipped, never as passed.
function skipLive(context: TestContext): never {
  console.warn(`SKIPPED: live smoke not run (${skipReason ?? 'no configuration'}).`);
  return context.skip(`SKIPPED: ${skipReason ?? 'no configuration'}`);
}

const Sum = z.strictObject({ answer: z.int().min(0).max(100) });
const evidence: string[] = [];

describe('live smoke (real provider)', () => {
  afterAll(() => {
    if (evidence.length > 0) console.info(`LIVE SMOKE EVIDENCE: ${evidence.join(' | ')}`);
  });

  it('makes one schema-valid structured call with usage and latency recorded', async (context) => {
    if (config === undefined) skipLive(context);
    const client = new LlmClient({
      adapter: AnthropicAdapter.fromConfig(config),
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
    });

    const result = await client.generateStructured({
      schemaName: 'smoke_sum',
      schema: Sum,
      system: 'You answer arithmetic questions. Reply only with JSON matching the schema.',
      parts: [{ kind: 'trusted', text: 'What is 2 + 3? Put the number in "answer".' }],
    });

    expect(Sum.safeParse(result.data).success).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThan(0);
    evidence.push(
      `structured call: model=${result.model} attempts=${result.attempts} latencyMs=${result.latencyMs} ` +
        `inputTokens=${result.usage.inputTokens} outputTokens=${result.usage.outputTokens} answer=${result.data.answer}`,
    );
  });

  it('confirms the API rejects sampling parameters (why the adapter never sends temperature)', async (context) => {
    if (config === undefined) skipLive(context);
    const client = createAnthropicClient(config.apiKey);
    // A non-literal object, so the extra field type-checks; the SDK types have no temperature field.
    const params = {
      model: config.model,
      max_tokens: 16,
      messages: [{ role: 'user' as const, content: 'Say hi.' }],
      temperature: 0.5,
    };

    const outcome = await client.messages.create(params).then(
      () => 'accepted',
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(BadRequestError);
    evidence.push(`sampling probe: temperature=0.5 rejected with status ${(outcome as BadRequestError).status}`);
  });
});
