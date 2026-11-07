import { type ReasoningEffort, trimTrailingSlashes } from '@mandate/llm';
import { z } from 'zod';
import type { ToolModel, ToolModelRequest, ToolModelResult } from './models.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The fields read from a Chat Completions response. Anything else in the body is ignored. */
const ResponseShape = z.object({
  usage: z.object({ prompt_tokens: z.int().nonnegative(), completion_tokens: z.int().nonnegative() }).optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          tool_calls: z
            .array(z.object({ type: z.string().optional(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
});

/**
 * Live tool-use model for baselines (a) and (b) over an OpenAI-compatible Chat Completions API (NVIDIA's
 * API catalog). Only packages/evals may give a model tools (ADR 0004). Plain fetch: the key comes from the
 * caller, nothing from the environment. Tool arguments are passed on as the model wrote them: arguments that
 * are not valid JSON reach the tool as a string and fail there, like any malformed call.
 */
export class OpenAICompatibleToolModel implements ToolModel {
  readonly model: string;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #maxTokens: number;
  readonly #reasoningEffort: ReasoningEffort | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: {
    baseUrl: string;
    model: string;
    apiKey: string;
    maxTokens?: number;
    reasoningEffort?: ReasoningEffort;
    timeoutMs?: number;
    fetch?: FetchLike;
  }) {
    if (!options.apiKey) throw new Error('OpenAICompatibleToolModel needs an API key');
    this.model = options.model;
    this.#endpoint = `${trimTrailingSlashes(options.baseUrl)}/chat/completions`;
    this.#apiKey = options.apiKey;
    this.#maxTokens = options.maxTokens ?? 8_192;
    this.#reasoningEffort = options.reasoningEffort;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async decide(request: ToolModelRequest): Promise<ToolModelResult> {
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.#maxTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
        tool_choice: 'auto',
        ...(this.#reasoningEffort === undefined ? {} : { reasoning_effort: this.#reasoningEffort }),
      }),
    });
    // Status only: an error body may echo the prompt.
    if (!response.ok) throw new Error(`Tool model call failed: HTTP ${response.status}`);
    const parsed = ResponseShape.parse(await response.json());
    const calls = (parsed.choices[0]?.message.tool_calls ?? []).map((call) => ({ name: call.function.name, input: parseArguments(call.function.arguments) }));
    return { calls, usage: { inputTokens: parsed.usage?.prompt_tokens ?? 0, outputTokens: parsed.usage?.completion_tokens ?? 0 } };
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
