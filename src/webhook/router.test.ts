import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WHATSAPP_TOKEN = 'EAAtest';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '67890';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
});

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import db, { closeDb } from '../db/client.js';
import { closeRedis } from '../redis/client.js';
import { seed } from '../db/seed.js';
import { buildApp } from '../index.js';
import { sign } from './verify.js';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = { restaurant: Record<string, string> };

describe('webhook router', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let restaurantPhoneNumberId: string;

  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    const restaurantId = ids.restaurant['hungry_bird']!;
    // Read current phone_number_id from DB
    const rows = await db.query<{ whatsapp_phone_number_id: string }>(
      `SELECT whatsapp_phone_number_id FROM restaurants WHERE id = $1`,
      [restaurantId],
    );
    restaurantPhoneNumberId = rows[0]!.whatsapp_phone_number_id;

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    await closeRedis();
  });

  it('GET /webhook verifies with matching token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=12345',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('12345');
  });

  it('GET /webhook rejects wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /webhook with valid signature processes text message', async () => {
    const wamid = `wamid.test.${Date.now()}`;
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: restaurantPhoneNumberId },
                messages: [
                  {
                    from: '8801700001234',
                    id: wamid,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hello webhook test' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(body));
    const signature = sign(raw, config.WHATSAPP_APP_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);

    // Verify message was persisted with the conversation id attached
    const rows = await db.query<{ direction: string; transcript: string | null }>(
      `SELECT direction, transcript FROM messages WHERE whatsapp_message_id = $1`,
      [wamid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('inbound');
    expect(rows[0]!.transcript).toBe('hello webhook test');
  });

  it('POST /webhook rejects invalid signature in production', async () => {
    // Force NODE_ENV check
    const prev = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: 'production' });
    try {
      const wamid = `wamid.bad.${Date.now()}`;
      const body = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { metadata: { phone_number_id: restaurantPhoneNumberId }, messages: [{ from: '8801700009999', id: wamid, timestamp: '1700000000', type: 'text', text: { body: 'x' } }] } }] }],
      };
      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
        payload: Buffer.from(JSON.stringify(body)),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('POST /webhook dedupes duplicate wamid', async () => {
    const wamid = `wamid.dedup.${Date.now()}`;
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: restaurantPhoneNumberId },
                messages: [
                  { from: '8801700005555', id: wamid, timestamp: '1700000000', type: 'text', text: { body: 'first' } },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(body));
    const signature = sign(raw, config.WHATSAPP_APP_SECRET);

    // Send twice
    const r1 = await app.inject({
      method: 'POST', url: '/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: raw,
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: 'POST', url: '/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: raw,
    });
    expect(r2.statusCode).toBe(200);

    const rows = await db.query<{ transcript: string | null }>(
      `SELECT transcript FROM messages WHERE whatsapp_message_id = $1`,
      [wamid],
    );
    expect(rows).toHaveLength(1);
  });
});