import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WHATSAPP_TOKEN = 'tkn';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '456';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
});

// Mock the openai client used by ./client.js
const fakeCreate = vi.fn();
const fakeAudio = { transcriptions: { create: fakeCreate } };
vi.mock('../ai/client.js', () => ({
  openai: { audio: fakeAudio },
  recordTokens: () => undefined,
  budgetExceeded: () => false,
  tokensUsedToday: () => 0,
}));

describe('whisper client', () => {
  beforeAll(() => {
    // ensure config can load
  });

  it('transcribe passes language=bn and temperature=0', async () => {
    fakeCreate.mockResolvedValueOnce({ text: 'আসসালামু আলাইকুম' });
    const { transcribe } = await import('./whisper.js');
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    const text = await transcribe(buf, 'audio/ogg');
    expect(text).toBe('আসসালামু আলাইকুম');
    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'bn',
        temperature: 0,
        response_format: 'json',
      }),
    );
  });

  it('transcribe throws on empty buffer', async () => {
    const { transcribe } = await import('./whisper.js');
    await expect(transcribe(Buffer.alloc(0), 'audio/ogg')).rejects.toThrow(/empty/);
  });
});