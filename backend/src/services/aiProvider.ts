
import Anthropic from '@anthropic-ai/sdk';

export type AiProviderName = 'anthropic' | 'openai_compatible';

export interface NarrationRequest {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  model?: string;
}

export interface NarrationResult {
  text: string;
  model: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Narrator {
  narrate(request: NarrationRequest): Promise<NarrationResult>;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 2_000;

export class AiProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'AiProviderError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

type AiConfig =
  | { provider: 'anthropic'; model: string; baseUrl?: string; apiKey?: string }
  | { provider: 'openai_compatible'; model: string; baseUrl: string; apiKey: string };

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readConfig(): AiConfig {
  const provider = readEnv('AI_PROVIDER') ?? 'anthropic';
  const model = readEnv('AI_MODEL') ?? DEFAULT_MODEL;
  const baseUrl = readEnv('AI_BASE_URL');

  if (provider === 'anthropic') {
    return { provider, model, baseUrl, apiKey: readEnv('AI_API_KEY') ?? readEnv('ANTHROPIC_API_KEY') };
  }

  if (provider === 'openai_compatible') {
    const apiKey = readEnv('AI_API_KEY');
    if (!baseUrl) {
      throw new Error("AI_BASE_URL is required when AI_PROVIDER is 'openai_compatible'");
    }
    if (!apiKey) {
      throw new Error("AI_API_KEY is required when AI_PROVIDER is 'openai_compatible'");
    }
    return { provider, model, baseUrl, apiKey };
  }

  throw new Error(
    `AI_PROVIDER must be 'anthropic' or 'openai_compatible' (received '${provider}')`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptOnce<T>(
  run: (signal: AbortSignal) => Promise<T>,
  mapError: (err: unknown) => AiProviderError
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new AiProviderError(`AI request timed out after ${REQUEST_TIMEOUT_MS}ms`, {
        retryable: false,
      });
    }
    throw mapError(err);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runWithRetry<T>(
  run: (signal: AbortSignal) => Promise<T>,
  mapError: (err: unknown) => AiProviderError
): Promise<T> {
  try {
    return await attemptOnce(run, mapError);
  } catch (err) {
    if (!(err instanceof AiProviderError) || !err.retryable) throw err;
    await delay(RETRY_BACKOFF_MS);
    return attemptOnce(run, mapError);
  }
}

function logCall(result: NarrationResult, latencyMs: number): void {
  if (process.env.VITEST) return;
  console.info(
    JSON.stringify({
      event: 'ai_call',
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs,
    })
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

class AnthropicNarrator implements Narrator {
  private readonly client: Anthropic;

  constructor(private readonly config: Extract<AiConfig, { provider: 'anthropic' }>) {
    this.client = new Anthropic({
      maxRetries: 0,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async narrate(request: NarrationRequest): Promise<NarrationResult> {
    const model = request.model ?? this.config.model;
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const startedAt = Date.now();

    const response = await runWithRetry(
      (signal) =>
        this.client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: request.system,
            messages: request.messages,
          },
          { signal, maxRetries: 0 }
        ),
      mapAnthropicError
    );

    const block = response.content[0];
    const result: NarrationResult = {
      text: block && block.type === 'text' ? block.text : '',
      model,
      provider: 'anthropic',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
    logCall(result, Date.now() - startedAt);
    return result;
  }
}

function mapAnthropicError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  const status = typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
  const retryable = status === undefined || isRetryableStatus(status);
  const suffix = status === undefined ? '' : ` (status ${status})`;
  return new AiProviderError(`Anthropic request failed${suffix}: ${errorMessage(err)}`, {
    retryable,
    status,
  });
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

class OpenAICompatibleNarrator implements Narrator {
  private readonly endpoint: string;

  constructor(private readonly config: Extract<AiConfig, { provider: 'openai_compatible' }>) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async narrate(request: NarrationRequest): Promise<NarrationResult> {
    const model = request.model ?? this.config.model;
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const startedAt = Date.now();

    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
    });

    const payload = await runWithRetry(async (signal) => {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body,
        signal,
      });

      if (!response.ok) {
        throw new AiProviderError(
          `OpenAI-compatible provider at ${this.endpoint} returned HTTP ${response.status}`,
          { retryable: isRetryableStatus(response.status), status: response.status }
        );
      }

      return (await response.json()) as OpenAiChatResponse;
    }, mapOpenAiError);

    const result: NarrationResult = {
      text: payload.choices?.[0]?.message?.content ?? '',
      model,
      provider: 'openai_compatible',
      inputTokens: payload.usage?.prompt_tokens,
      outputTokens: payload.usage?.completion_tokens,
    };
    logCall(result, Date.now() - startedAt);
    return result;
  }
}

function mapOpenAiError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  return new AiProviderError(`OpenAI-compatible request failed: ${errorMessage(err)}`, {
    retryable: true,
  });
}

let cachedNarrator: Narrator | null = null;

export function activeProviderKind(): 'anthropic' | 'openai_compatible' {
  return readConfig().provider;
}

export function getNarrator(): Narrator {
  if (!cachedNarrator) {
    const config = readConfig();
    cachedNarrator =
      config.provider === 'openai_compatible'
        ? new OpenAICompatibleNarrator(config)
        : new AnthropicNarrator(config);
  }
  return cachedNarrator;
}

export function resetForTests(): void {
  cachedNarrator = null;
}
