import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { messagesCreate, anthropicConstructed } = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  anthropicConstructed: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
    constructor(options: Record<string, unknown>) {
      anthropicConstructed(options);
    }
  },
}));

const { getNarrator, resetForTests } = await import('../../src/services/aiProvider.js');
const { callClaude } = await import('../../src/services/ai.js');

const SYSTEM = 'you are a fantasy nba analyst';
const MESSAGES: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'rate my roster' },
];

const anthropicReply = {
  content: [{ type: 'text', text: 'looks deep at guard' }],
  usage: { input_tokens: 120, output_tokens: 45 },
};

const openAiReply = {
  choices: [{ message: { content: 'looks deep at guard' } }],
  usage: { prompt_tokens: 120, completion_tokens: 45 },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function useOpenAiEnv(): void {
  vi.stubEnv('AI_PROVIDER', 'openai_compatible');
  vi.stubEnv('AI_BASE_URL', 'https://gateway.example/v1');
  vi.stubEnv('AI_API_KEY', 'sk-test-key');
  vi.stubEnv('AI_MODEL', 'test-model-1');
}

beforeEach(() => {
  resetForTests();
  messagesCreate.mockReset();
  anthropicConstructed.mockReset();
  vi.stubEnv('AI_PROVIDER', '');
  vi.stubEnv('AI_MODEL', '');
  vi.stubEnv('AI_BASE_URL', '');
  vi.stubEnv('AI_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetForTests();
});

describe('getNarrator factory', () => {
  it('defaults to the anthropic provider when AI_PROVIDER is unset', async () => {
    messagesCreate.mockResolvedValue(anthropicReply);

    const result = await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it('selects the openai-compatible adapter when AI_PROVIDER says so', async () => {
    useOpenAiEnv();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, openAiReply));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    expect(result.provider).toBe('openai_compatible');
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unrecognized AI_PROVIDER', () => {
    vi.stubEnv('AI_PROVIDER', 'gemini');

    expect(() => getNarrator()).toThrow(/AI_PROVIDER must be/);
  });

  it('requires a base url for the openai-compatible provider', () => {
    vi.stubEnv('AI_PROVIDER', 'openai_compatible');
    vi.stubEnv('AI_API_KEY', 'sk-test-key');

    expect(() => getNarrator()).toThrow(/AI_BASE_URL is required/);
  });

  it('requires an api key for the openai-compatible provider', () => {
    vi.stubEnv('AI_PROVIDER', 'openai_compatible');
    vi.stubEnv('AI_BASE_URL', 'https://gateway.example/v1');

    expect(() => getNarrator()).toThrow(/AI_API_KEY is required/);
  });

  it('reads env once per process and re-reads only after resetForTests', () => {
    const first = getNarrator();

    const cached = getNarrator();
    useOpenAiEnv();
    const stillCached = getNarrator();
    resetForTests();
    const rebuilt = getNarrator();

    expect(cached).toBe(first);
    expect(stillCached).toBe(first);
    expect(rebuilt).not.toBe(first);
  });
});

describe('AnthropicNarrator', () => {
  it('passes model, max_tokens, system, and messages to the sdk', async () => {
    messagesCreate.mockResolvedValue(anthropicReply);

    await getNarrator().narrate({
      system: SYSTEM,
      messages: MESSAGES,
      model: 'claude-sonnet-4-6',
      maxTokens: 2048,
    });

    const [body] = messagesCreate.mock.calls[0];
    expect(body).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM,
      messages: MESSAGES,
    });
  });

  it('defaults max_tokens to 1024 and the model to AI_MODEL', async () => {
    vi.stubEnv('AI_MODEL', 'claude-opus-4-6');
    messagesCreate.mockResolvedValue(anthropicReply);

    const result = await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    const [body] = messagesCreate.mock.calls[0];
    expect(body.model).toBe('claude-opus-4-6');
    expect(body.max_tokens).toBe(1024);
    expect(result.model).toBe('claude-opus-4-6');
  });

  it('forwards AI_BASE_URL to the sdk as baseURL', async () => {
    vi.stubEnv('AI_BASE_URL', 'https://anthropic-proxy.example');
    vi.stubEnv('AI_API_KEY', 'sk-override');
    messagesCreate.mockResolvedValue(anthropicReply);

    await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    expect(anthropicConstructed).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://anthropic-proxy.example', apiKey: 'sk-override' })
    );
  });

  it('falls back to ANTHROPIC_API_KEY and omits baseURL when unset', async () => {
    messagesCreate.mockResolvedValue(anthropicReply);

    await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    const [options] = anthropicConstructed.mock.calls[0];
    expect(options.apiKey).toBe('test-anthropic-key');
    expect(options).not.toHaveProperty('baseURL');
  });

  it('extracts text and usage tokens from the response', async () => {
    messagesCreate.mockResolvedValue(anthropicReply);

    const result = await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    expect(result).toEqual({
      text: 'looks deep at guard',
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it('returns empty text when the first block is not text', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const result = await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    expect(result.text).toBe('');
  });
});

describe('OpenAICompatibleNarrator', () => {
  it('posts an openai chat-completions request with the system message first', async () => {
    useOpenAiEnv();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, openAiReply));
    vi.stubGlobal('fetch', fetchMock);

    await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES, maxTokens: 3072 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'test-model-1',
      max_tokens: 3072,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'rate my roster' },
      ],
    });
  });

  it('parses the reply text and usage tokens', async () => {
    useOpenAiEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, openAiReply)));

    const result = await getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    expect(result).toEqual({
      text: 'looks deep at guard',
      model: 'test-model-1',
      provider: 'openai_compatible',
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it('reports the status on a non-2xx without echoing the response body', async () => {
    useOpenAiEnv();
    const leakyBody = { error: 'bad auth for Bearer sk-test-key' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, leakyBody)));

    const narrate = getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });

    await expect(narrate).rejects.toThrow(/HTTP 401/);
    await expect(narrate).rejects.not.toThrow(/sk-test-key/);
  });

  it('does not retry a non-retryable status', async () => {
    useOpenAiEnv();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getNarrator().narrate({ system: SYSTEM, messages: MESSAGES })).rejects.toThrow(
      /HTTP 400/
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retry and timeout', () => {
  it('retries once after a 429 and returns the second response', async () => {
    useOpenAiEnv();
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, openAiReply));
    vi.stubGlobal('fetch', fetchMock);

    const narrate = getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await narrate;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('looks deep at guard');
  });

  it('retries once after a transport failure', async () => {
    useOpenAiEnv();
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, openAiReply));
    vi.stubGlobal('fetch', fetchMock);

    const narrate = getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await narrate;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('looks deep at guard');
  });

  it('gives up after a single retry', async () => {
    useOpenAiEnv();
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    vi.stubGlobal('fetch', fetchMock);

    const narrate = getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });
    const assertion = expect(narrate).rejects.toThrow(/HTTP 503/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts the request after 30 seconds and does not retry', async () => {
    useOpenAiEnv();
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const narrate = getNarrator().narrate({ system: SYSTEM, messages: MESSAGES });
    const assertion = expect(narrate).rejects.toThrow(/timed out after 30000ms/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('callClaude backward compatibility', () => {
  it('returns the reply as a plain string through the anthropic provider', async () => {
    messagesCreate.mockResolvedValue(anthropicReply);

    const reply = await callClaude(SYSTEM, [{ role: 'user', content: 'rate my roster' }]);

    expect(reply).toBe('looks deep at guard');
    expect(typeof reply).toBe('string');
  });

  it('forwards the model and maxTokens options unchanged', async () => {
    messagesCreate.mockResolvedValue(anthropicReply);

    await callClaude(SYSTEM, [{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-4-6',
      maxTokens: 3072,
    });

    const [body] = messagesCreate.mock.calls[0];
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(3072);
  });

  it('routes through whichever provider the env selects', async () => {
    useOpenAiEnv();
    resetForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, openAiReply)));

    const reply = await callClaude(SYSTEM, [{ role: 'user', content: 'rate my roster' }]);

    expect(reply).toBe('looks deep at guard');
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});
