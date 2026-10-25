import { type Server, type ServerResponse, createServer } from 'node:http';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_BASE_URL,
  AnthropicAdapter,
  type CreateMessage,
  createAnthropicClient,
  parseRetryAfterMs,
  toProviderError,
} from '../src/adapters/anthropic.js';
import { Secret } from '../src/config.js';
import { ProviderError } from '../src/errors.js';
import type { ProviderRequest } from '../src/provider.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const baseRequest: ProviderRequest = { system: 'sys', userText: 'user', maxOutputTokens: 512, timeoutMs: 1_234 };

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '{"answer":1}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
    ...overrides,
  } as Message;
}

function setup(reply: Message | Error = message()) {
  const createMessage = vi.fn<CreateMessage>();
  if (reply instanceof Error) createMessage.mockRejectedValue(reply);
  else createMessage.mockResolvedValue(reply);
  const adapter = new AnthropicAdapter({ model: 'claude-opus-5-5', createMessage, clock: { now: () => NOW } });
  return { adapter, createMessage };
}

const sentParams = (createMessage: ReturnType<typeof setup>['createMessage']) => createMessage.mock.calls[0]?.[0];
const sentOptions = (createMessage: ReturnType<typeof setup>['createMessage']) => createMessage.mock.calls[0]?.[1];

describe('AnthropicAdapter request', () => {
  it('sends exactly model, max_tokens, system and one user message', async () => {
    const { adapter, createMessage } = setup();
    await adapter.complete(baseRequest);
    expect(sentParams(createMessage)).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 512,
      system: 'sys',
      messages: [{ role: 'user', content: 'user' }],
    });
  });

  it('passes the deadline and signal through and disables SDK retries per request', async () => {
    const { adapter, createMessage } = setup();
    const signal = new AbortController().signal;
    await adapter.complete({ ...baseRequest, signal });
    expect(sentOptions(createMessage)).toEqual({ timeout: 1_234, maxRetries: 0, signal });
  });

  it('sends a native structured-output format, not a tool', async () => {
    const { adapter, createMessage } = setup();
    const schema = {
      type: 'object',
      properties: { answer: { type: 'integer', minimum: 0, maximum: 9 } },
      required: ['answer'],
      additionalProperties: false,
    };
    await adapter.complete({ ...baseRequest, responseJsonSchema: schema });
    const params = sentParams(createMessage);
    expect(params?.output_config?.format).toMatchObject({ type: 'json_schema', schema: { type: 'object' } });
    expect(params).not.toHaveProperty('tools');
  });

  it('never forwards tool or sampling fields, even if a caller smuggles them in at runtime', async () => {
    const { adapter, createMessage } = setup();
    const smuggled = {
      ...baseRequest,
      tools: [{ name: 'pay', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
      functions: [],
      temperature: 0.2,
      top_p: 0.9,
      top_k: 5,
    };
    await adapter.complete(smuggled);
    const keys = Object.keys(sentParams(createMessage) ?? {});
    for (const forbidden of ['tools', 'tool_choice', 'functions', 'temperature', 'top_p', 'top_k']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('AnthropicAdapter response', () => {
  it('joins text blocks, ignores thinking blocks, and maps usage and model', async () => {
    const { adapter } = setup(
      message({
        model: 'claude-opus-5-5',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '{"a":', citations: null },
          { type: 'text', text: '1}', citations: null },
        ] as Message['content'],
      }),
    );
    await expect(adapter.complete(baseRequest)).resolves.toEqual({
      text: '{"a":1}',
      usage: { inputTokens: 11, outputTokens: 7 },
      model: 'claude-opus-5-5',
      stopReason: 'end',
    });
  });

  it.each([
    ['end_turn', 'end'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['model_context_window_exceeded', 'context_window_exceeded'],
    ['tool_use', 'other'],
    ['pause_turn', 'other'],
    [null, 'other'],
  ] as const)('maps stop_reason %s to %s', async (stopReason, expected) => {
    const { adapter } = setup(message({ stop_reason: stopReason }));
    await expect(adapter.complete(baseRequest)).resolves.toMatchObject({ stopReason: expected });
  });
});

describe('AnthropicAdapter error mapping (real SDK error classes)', () => {
  const headers = (entries: Record<string, string> = {}) => new Headers({ 'request-id': 'req_123', ...entries });
  // The SDK builds APIError.message from the response body, so test text must live in the body.
  const apiBody = (message: string) => ({ type: 'error', error: { type: 'invalid_request_error', message } });
  const body = apiBody('x');

  it.each([
    ['401 authentication', new AuthenticationError(401, body, 'bad key', headers()), 'PROVIDER_AUTH'],
    ['403 permission', new PermissionDeniedError(403, body, 'denied', headers()), 'PROVIDER_AUTH'],
    ['429 rate limit', new RateLimitError(429, body, 'slow down', headers()), 'PROVIDER_RATE_LIMITED'],
    ['500 server error', new InternalServerError(500, body, 'oops', headers()), 'PROVIDER_UNAVAILABLE'],
    ['529 overloaded', new InternalServerError(529, body, 'overloaded', headers()), 'PROVIDER_UNAVAILABLE'],
    ['408 request timeout', new APIError(408, body, 'timeout', headers()), 'PROVIDER_TIMEOUT'],
    ['409 conflict', new APIError(409, body, 'conflict', headers()), 'PROVIDER_UNAVAILABLE'],
    ['413 too large', new APIError(413, body, 'too large', headers()), 'CONTEXT_TOO_LARGE'],
    [
      '400 prompt too long',
      new BadRequestError(400, apiBody('prompt is too long: 250000 tokens > 200000 maximum'), undefined, headers()),
      'CONTEXT_TOO_LARGE',
    ],
    ['400 other', new BadRequestError(400, body, 'invalid model', headers()), 'PROVIDER_BAD_REQUEST'],
    ['404 not found', new NotFoundError(404, body, 'no model', headers()), 'PROVIDER_BAD_REQUEST'],
    ['connection error', new APIConnectionError({ message: 'reset' }), 'PROVIDER_UNAVAILABLE'],
    ['connection timeout', new APIConnectionTimeoutError(), 'PROVIDER_TIMEOUT'],
    ['user abort', new APIUserAbortError(), 'ABORTED'],
  ])('maps %s to %s', async (_label, error, code) => {
    const { adapter } = setup(error);
    const rejection = await adapter.complete(baseRequest).catch((caught: unknown) => caught);
    expect(rejection).toBeInstanceOf(ProviderError);
    expect(rejection).toMatchObject({ code });
  });

  it('keeps status and request id, but never the provider message', async () => {
    const leaky = new BadRequestError(400, apiBody('invalid: SECRET_PROMPT_TEXT'), undefined, headers());
    expect(leaky.message).toContain('SECRET_PROMPT_TEXT');
    const rejection = await setup(leaky).adapter.complete(baseRequest).catch((caught: unknown) => caught);
    expect(rejection).toMatchObject({ details: { status: 400, requestId: 'req_123' } });
    expect((rejection as Error).message).not.toContain('SECRET_PROMPT_TEXT');
  });

  it('carries Retry-After on a 429', async () => {
    const limited = new RateLimitError(429, body, 'slow down', headers({ 'retry-after': '2' }));
    const rejection = await setup(limited).adapter.complete(baseRequest).catch((caught: unknown) => caught);
    expect(rejection).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', details: { retryAfterMs: 2_000 } });
  });

  it.each([
    ['a body-read failure', Object.assign(new TypeError('terminated'), { cause: new Error('other side closed') }), 'PROVIDER_UNAVAILABLE'],
    ['a body parse failure', new SyntaxError('Unexpected token B, "BODY_CANARY" is not valid JSON'), 'PROVIDER_UNAVAILABLE'],
    ['an SDK refusal before sending', new AnthropicError('Streaming is required'), 'PROVIDER_BAD_REQUEST'],
  ])('maps %s to a fixed-message ProviderError', async (_label, error, code) => {
    const rejection = await setup(error).adapter.complete(baseRequest).catch((caught: unknown) => caught);
    expect(rejection).toBeInstanceOf(ProviderError);
    expect(rejection).toMatchObject({ code });
    expect(toProviderError(error, NOW).code).toBe(code);
    expect(`${String(rejection)} ${JSON.stringify(rejection)}`).not.toContain('CANARY');
  });

  it('reports ABORTED for any rejection once the caller signal has aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = { ...baseRequest, signal: controller.signal };
    const rejection = await setup(new TypeError('terminated')).adapter.complete(request).catch((caught: unknown) => caught);
    expect(rejection).toMatchObject({ code: 'ABORTED' });
  });

  it.each([
    ['a string body', 'gateway page'],
    ['null', null],
    ['content that is not an array', { ...message(), content: 'x' }],
    ['missing usage', { ...message(), usage: undefined }],
    ['a fractional token count', { ...message(), usage: { input_tokens: 1.5, output_tokens: 1 } }],
    ['a text block without text', { ...message(), content: [{ type: 'text' }] }],
  ])('maps a 200 body with %s to PROVIDER_UNAVAILABLE', async (_label, body) => {
    const createMessage = vi.fn<CreateMessage>().mockResolvedValue(body as Message);
    const adapter = new AnthropicAdapter({ model: 'claude-opus-5-5', createMessage });
    await expect(adapter.complete(baseRequest)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('parseRetryAfterMs', () => {
  it.each([
    ['retry-after-ms', { 'retry-after-ms': '1500' }, 1_500],
    ['retry-after seconds', { 'retry-after': '3' }, 3_000],
    ['retry-after HTTP date', { 'retry-after': new Date(NOW + 5_000).toUTCString() }, 5_000],
    ['a date in the past', { 'retry-after': new Date(NOW - 5_000).toUTCString() }, 0],
    ['garbage', { 'retry-after': 'soon' }, undefined],
    ['a negative value', { 'retry-after': '-1' }, undefined],
    ['no header', {}, undefined],
  ])('handles %s', (_label, entries, expected) => {
    expect(parseRetryAfterMs(new Headers(entries), NOW)).toBe(expected);
  });

  it('handles missing headers', () => {
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
  });
});

describe('createAnthropicClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores every SDK environment default that could change auth, routing, retries or logging', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key-must-not-be-used');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token-must-not-be-used');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://attacker.example');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_WEBHOOK_SIGNING_KEY', 'whsec-env-must-not-be-read');

    const client = createAnthropicClient(new Secret('config-key'));
    expect(client.apiKey).toBe('config-key');
    expect(client.authToken).toBeNull();
    expect(client.webhookKey).toBeNull();
    expect(client.baseURL).toBe(ANTHROPIC_BASE_URL);
    expect(client.maxRetries).toBe(0);
    expect(client.logLevel).toBe('off');
  });
});

describe('AnthropicAdapter over the real SDK and a loopback server', () => {
  let server: Server;
  let baseURL = '';
  let respond: (response: ServerResponse) => void = (response) => response.end();

  beforeAll(async () => {
    server = createServer((_request, response) => respond(response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each<[string, (response: ServerResponse) => void]>([
    [
      'a connection reset mid-body',
      (response) => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
        response.flushHeaders();
        // Destroy only after the headers and part of the body reached the client, so fetch has resolved.
        response.write('{"id":"msg_1","content":[{"type":"text","text":"BODY_CANARY', () => {
          setTimeout(() => response.socket?.destroy(), 20);
        });
      },
    ],
    [
      'a 200 gateway page',
      (response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html>BODY_CANARY</html>');
      },
    ],
    [
      'a 200 with a body that is not JSON',
      (response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('BODY_CANARY');
      },
    ],
  ])('maps %s to a retryable PROVIDER_UNAVAILABLE that carries none of the body', async (_label, handler) => {
    respond = handler;
    const client = createAnthropicClient(new Secret('loopback-key'), baseURL);
    const adapter = new AnthropicAdapter({
      model: 'claude-opus-5-5',
      createMessage: (params, options) => client.messages.create(params, options),
    });

    const rejection = await adapter.complete(baseRequest).catch((caught: unknown) => caught);

    expect(rejection).toBeInstanceOf(ProviderError);
    expect(rejection).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(`${String(rejection)} ${JSON.stringify(rejection)}`).not.toContain('CANARY');
  });
});
