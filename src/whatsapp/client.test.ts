import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WHATSAPP_TOKEN = 'EAAtest';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '67890';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
});

import * as client from './client.js';

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  // Default no-op fetch
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.123' }] }),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  client.setFetchImpl(mockFetch as never);
});

describe('whatsapp client', () => {
  it('sendText posts to the right URL with bearer auth', async () => {
    const r = await client.sendText({ to: '+8801700000000', body: 'hello' });
    expect(r.wamid).toBe('wamid.123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('graph.facebook.com/v20.0/12345/messages');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer EAAtest');
    const body = JSON.parse(((init as RequestInit).body as string) ?? '{}');
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+8801700000000');
    expect(body.text.body).toBe('hello');
  });

  it('sendText throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'bad', code: 100 } }),
    });
    await expect(client.sendText({ to: '+1', body: 'x' })).rejects.toThrow(/bad/);
  });

  it('resolveMediaUrl returns url from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://lookaside.fb.com/media/abc', mime_type: 'audio/ogg' }),
    });
    const url = await client.resolveMediaUrl('media-abc');
    expect(url).toBe('https://lookaside.fb.com/media/abc');
  });

  it('resolveMediaUrl throws on missing url', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    await expect(client.resolveMediaUrl('x')).rejects.toThrow(/no url/);
  });

  it('downloadMedia returns a Buffer', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const buf = await client.downloadMedia('https://x/y');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(3);
  });
});