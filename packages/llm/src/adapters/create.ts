import type { LlmConfig } from '../config.js';
import type { ProviderAdapter } from '../provider.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

/** The production adapter for a loaded config. The one place that maps LLM_PROVIDER to an adapter. */
export function createAdapter(config: LlmConfig): ProviderAdapter {
  return config.provider === 'anthropic' ? AnthropicAdapter.fromConfig(config) : OpenAICompatibleAdapter.fromConfig(config);
}
