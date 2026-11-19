import { describe, it, expect } from 'vitest';
import { chatEndpoint, probeHttp } from './providerTester.js';

describe('chatEndpoint', () => {
  it('appends the protocol path after an explicit /v1', () => {
    expect(chatEndpoint('https://api.anthropic.com/v1', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(chatEndpoint('https://api.openai.com/v1/', 'openai')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
    expect(chatEndpoint('https://api.openai.com/v1', 'openai-responses')).toBe(
      'https://api.openai.com/v1/responses'
    );
  });

  it('inserts /v1 when the base has no version segment', () => {
    // ocr does this too: a bare host is treated as the API root.
    expect(chatEndpoint('https://gw.example.com', 'anthropic')).toBe(
      'https://gw.example.com/v1/messages'
    );
    expect(chatEndpoint('https://gw.example.com/api', 'openai')).toBe(
      'https://gw.example.com/api/v1/chat/completions'
    );
  });

  it('keeps a base that already names the endpoint', () => {
    expect(chatEndpoint('https://gw.example.com/v1/messages', 'anthropic')).toBe(
      'https://gw.example.com/v1/messages'
    );
  });
});

describe('probeHttp', () => {
  const base = {
    name: 'p',
    apiBase: 'https://gw.example.com/v1',
    model: 'm1',
    apiKey: 'k',
  } as const;

  it('reports success and names the endpoint and model', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const res = await probeHttp({ ...base, protocol: 'anthropic' }, { fetchImpl: fakeFetch });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('m1');
    expect(calls[0].url).toBe('https://gw.example.com/v1/messages');
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ model: 'm1', max_tokens: 1 });
  });

  it('explains a 401 as a key problem', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), {
        status: 401,
      })) as unknown as typeof fetch;
    const res = await probeHttp({ ...base, protocol: 'openai' }, { fetchImpl: fakeFetch });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('401');
    expect(res.message).toContain('bad key');
    expect(res.message).toContain('API Key 无效');
  });

  it('explains a 404 as a wrong API base', async () => {
    const fakeFetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const res = await probeHttp({ ...base, protocol: 'openai' }, { fetchImpl: fakeFetch });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('接口地址不存在');
  });

  it('reports a network failure with the endpoint it tried', async () => {
    const fakeFetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await probeHttp({ ...base, protocol: 'openai' }, { fetchImpl: fakeFetch });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('ECONNREFUSED');
    expect(res.message).toContain('/v1/chat/completions');
  });
});
