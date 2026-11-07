import { describe, expect, it } from 'vitest';
import { liveModels } from '../src/cli.js';
import { type FetchLike, OpenAICompatibleToolModel } from '../src/openai-tools.js';
import type { ToolSpec } from '../src/models.js';
import { ALL_SCENARIOS } from '../src/scenarios/index.js';

const KEY = 'nvapi-test-PLACEHOLDER-not-a-real-key';
const BASE = 'https://integrate.api.nvidia.com/v1';
const TOOLS: ToolSpec[] = [{ name: 'pay', description: 'Pay for a cart', inputSchema: { type: 'object', properties: { amountMinor: { type: 'integer' } } } }];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function model(reply: Response) {
  const calls: { url: string; body: Record<string, unknown>; headers: unknown }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown>, headers: init.headers });
    return Promise.resolve(reply);
  };
  return { calls, tm: new OpenAICompatibleToolModel({ baseUrl: `${BASE}/`, model: 'm', apiKey: KEY, maxTokens: 900, reasoningEffort: 'low', fetch }) };
}

describe('OpenAICompatibleToolModel', () => {
  it('sends the tools as functions and returns the calls the model made', async () => {
    const { calls, tm } = model(
      json(200, {
        choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'pay', arguments: '{"amountMinor":1999}' } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
    const result = await tm.decide({ system: 'sys', user: 'buy', tools: TOOLS });
    expect(result).toEqual({ calls: [{ name: 'pay', input: { amountMinor: 1999 } }], usage: { inputTokens: 100, outputTokens: 20 } });
    expect(calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(calls[0]?.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(calls[0]?.body).toEqual({
      model: 'm',
      max_tokens: 900,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'buy' },
      ],
      tools: [{ type: 'function', function: { name: 'pay', description: 'Pay for a cart', parameters: TOOLS[0]?.inputSchema } }],
      tool_choice: 'auto',
      reasoning_effort: 'low',
    });
  });

  it('passes malformed arguments through as a string, and no calls when the model answered in text', async () => {
    const bad = model(json(200, { choices: [{ message: { tool_calls: [{ function: { name: 'pay', arguments: '{amount: 5' } }] } }] }));
    expect((await bad.tm.decide({ system: 's', user: 'u', tools: TOOLS })).calls).toEqual([{ name: 'pay', input: '{amount: 5' }]);
    const text = model(json(200, { choices: [{ message: { content: 'I will not buy that.', tool_calls: null } }] }));
    expect(await text.tm.decide({ system: 's', user: 'u', tools: TOOLS })).toEqual({ calls: [], usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('reports an HTTP failure by status only, never the body or the key', async () => {
    const { tm } = model(json(429, { detail: `prompt echo ${KEY}` }));
    const error = await tm.decide({ system: 's', user: 'u', tools: TOOLS }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Tool model call failed: HTTP 429');
  });

  it('needs a key', () => {
    expect(() => new OpenAICompatibleToolModel({ baseUrl: BASE, model: 'm', apiKey: '' })).toThrow('needs an API key');
  });

  it('liveModels picks the OpenAI-compatible tool model and adapter from LLM_PROVIDER, sharing one adapter', () => {
    const models = liveModels({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: BASE, LLM_MODEL: 'mistralai/m', LLM_API_KEY: KEY });
    const scenario = ALL_SCENARIOS[0];
    if (!scenario) throw new Error('no scenarios');
    expect(models.toolModel(scenario, 'naive')).toBeInstanceOf(OpenAICompatibleToolModel);
    expect(models.provider(scenario)).toBe(models.provider(scenario));
    expect(models.provider(scenario).provider).toBe('openai-compatible');
  });
});
