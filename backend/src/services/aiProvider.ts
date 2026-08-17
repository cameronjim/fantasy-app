// protocol-level adapters for the text-generation provider. every AI feature
// funnels through a Narrator, so swapping Anthropic for an OpenAI-compatible
// endpoint (Kimi, vLLM, a local gateway) is an env change, not a code change.

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

/**
 * A provider failure normalized across protocols. `retryable` is decided by
 * the adapter that produced it, so the shared retry loop stays protocol-blind.
 */
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

// discriminated so the openai-compatible branch carries a proven base url and
// key instead of forcing a non-null assertion at construction.
type AiConfig =
  | { provider: 'anthropic'; model: string; baseUrl?: string; apiKey?: string }
  | { provider: 'openai_compatible'; model: string; baseUrl: string; apiKey: string };

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Reads and validates the AI provider configuration. Called lazily on the
 * first narration rather than at import time so the server still boots (and
 * every non-AI route still serves) when the AI vars are absent.
 */
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

/** one attempt, bounded by the request deadline */
async function attemptOnce<T>(
  run: (signal: AbortSignal) => Promise<T>,
  mapError: (err: unknown) => AiProviderError
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (err) {
    // our own deadline fired. a retry would stack another 30s onto a request
    // that already blew its budget, so this is terminal.
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

/** at most one retry, for rate limits, upstream 5xx, and transport failures */
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
  // one structured line per call for CloudWatch; silenced under vitest so the
  // test run stays clean (AGENTS.md bans log/warn/error — this is ops output).
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
      // retries live in runWithRetry so the 30s deadline stays meaningful.
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
  // no status means the request never reached the api (dns, socket, tls).
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
        // gateways routinely echo the request (auth header included) back in
        // the error body, so only the status crosses this boundary.
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
  // fetch only rejects on transport failure, which is worth one retry.
  return new AiProviderError(`OpenAI-compatible request failed: ${errorMessage(err)}`, {
    retryable: true,
  });
}

let cachedNarrator: Narrator | null = null;

/**
 * The process-wide narrator. Config is read on first use and reused after
 * that — env doesn't change under a running Lambda, and re-reading it per
 * request would rebuild the SDK client (and its connection pool) every call.
 */
/**
 * Which protocol the current env selects, without constructing a narrator.
 * Callers use this to drop provider-specific model overrides (e.g. a Claude
 * model id must not be forwarded to an OpenAI-compatible gateway).
 */
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

/** drops the cached narrator so a test can re-read a different env */
export function resetForTests(): void {
  cachedNarrator = null;
}
