import { config } from '../config.js';
import { logger } from '../logger.js';

const API_VERSION = 'v20.0';
const baseUrl = (): string =>
  `https://graph.facebook.com/${API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}`;

export interface SendTextInput {
  to: string; // E.164 phone number of recipient
  body: string;
}

export interface SendResult {
  wamid: string;
  raw: unknown;
}

// Internal mutable binding so tests can swap the implementation.
let _fetchImpl: typeof fetch = (url, init) => fetch(url, init);

export function setFetchImpl(fn: typeof fetch): void {
  _fetchImpl = fn;
}

function getFetchImpl(): typeof fetch {
  return _fetchImpl;
}

/**
 * Send a free-form text message via the WhatsApp Cloud API.
 *
 * Free-form messages can only be sent within 24 hours of the customer's
 * last inbound message — otherwise Meta rejects with error code 131047.
 * Outside that window, you must use a pre-approved template.
 */
export async function sendText(input: SendTextInput): Promise<SendResult> {
  const url = `${baseUrl()}/messages`;
  const res = await getFetchImpl()(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: input.to,
      type: 'text',
      text: { body: input.body, preview_url: false },
    }),
  });

  const data = (await res.json()) as {
    messages?: Array<{ id: string }>;
    error?: { message: string; code: number };
  };

  if (!res.ok || data.error) {
    logger.error({ status: res.status, error: data.error }, 'whatsapp send error');
    throw new Error(`whatsapp send failed: ${data.error?.message ?? res.statusText}`);
  }
  const wamid = data.messages?.[0]?.id;
  if (!wamid) throw new Error('whatsapp send: no message id in response');
  return { wamid, raw: data };
}

/**
 * Resolve a media_id from an inbound message to a downloadable URL.
 * The URL is short-lived (5 minutes); download immediately.
 */
export async function resolveMediaUrl(mediaId: string): Promise<string> {
  const url = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
  const res = await getFetchImpl()(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`resolveMediaUrl failed: ${res.status}`);
  const data = (await res.json()) as { url?: string; error?: { message: string } };
  if (!data.url) throw new Error(`resolveMediaUrl: no url (${data.error?.message ?? 'unknown'})`);
  return data.url;
}

/**
 * Download media bytes from a media_url returned by resolveMediaUrl.
 */
export async function downloadMedia(mediaUrl: string): Promise<Buffer> {
  const res = await getFetchImpl()(mediaUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`downloadMedia failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}