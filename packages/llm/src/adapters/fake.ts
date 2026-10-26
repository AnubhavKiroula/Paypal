import { ProviderError, type ProviderErrorCode } from '../errors.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, StopReason, Usage } from '../provider.js';
import { AbortedError, type Sleep, defaultSleep } from '../time.js';

export type FakeStep =
  | { kind: 'reply'; text: string; stopReason?: StopReason; usage?: Usage; model?: string; delayMs?: number }
  | { kind: 'error'; code: ProviderErrorCode; retryAfterMs?: number; delayMs?: number };

export const DEFAULT_FAKE_USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

/** Scripted ProviderAdapter with fault injection. Records every request it receives. */
export class FakeProvider implements ProviderAdapter {
  readonly provider = 'fake';
  readonly model: string;
  readonly requests: ProviderRequest[] = [];
  private readonly steps: FakeStep[];
  private readonly sleep: Sleep;

  constructor(steps: readonly FakeStep[], options: { model?: string; sleep?: Sleep } = {}) {
    this.steps = [...steps];
    this.model = options.model ?? 'fake-model';
    this.sleep = options.sleep ?? defaultSleep;
  }

  static json(value: unknown, extra: Partial<Extract<FakeStep, { kind: 'reply' }>> = {}): FakeStep {
    return { kind: 'reply', text: JSON.stringify(value), ...extra };
  }

  get remainingSteps(): number {
    return this.steps.length;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error('FakeProvider: no scripted step left');
    }
    if (step.delayMs !== undefined) {
      try {
        await this.sleep(Math.min(step.delayMs, request.timeoutMs), request.signal);
      } catch (error) {
        if (error instanceof AbortedError) throw new ProviderError('ABORTED');
        throw error;
      }
      if (step.delayMs > request.timeoutMs) throw new ProviderError('PROVIDER_TIMEOUT');
    }
    if (step.kind === 'error') {
      throw new ProviderError(step.code, step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs });
    }
    return {
      text: step.text,
      usage: step.usage ?? DEFAULT_FAKE_USAGE,
      model: step.model ?? this.model,
      stopReason: step.stopReason ?? 'end',
    };
  }
}
