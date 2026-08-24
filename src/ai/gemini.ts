/**
 * Google Gemini HTTP client.
 *
 * No SDK — just a thin `fetch` wrapper. Easier to mock in tests, smaller
 * dependency surface, and lets us control every request field explicitly.
 *
 * Token budget tracking is preserved from the previous OpenAI version: each
 * response's `usageMetadata.totalTokenCount` is recorded and a daily cap is
 * enforced.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Track today's token usage; resets at midnight UTC.
let dailyTokens = 0;
let dailyResetAt = nextUtcMidnight();

function nextUtcMidnight(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

export function recordTokens(used: number): void {
  if (Date.now() > dailyResetAt) {
    dailyTokens = 0;
    dailyResetAt = nextUtcMidnight();
  }
  dailyTokens += used;
  if (dailyTokens > config.LLM_DAILY_TOKEN_BUDGET) {
    logger.warn(
      { dailyTokens, budget: config.LLM_DAILY_TOKEN_BUDGET },
      'gemini daily token budget exceeded',
    );
  }
}

export function tokensUsedToday(): number {
  return dailyTokens;
}

export function budgetExceeded(): boolean {
  if (Date.now() > dailyResetAt) {
    dailyTokens = 0;
    dailyResetAt = nextUtcMidnight();
  }
  return dailyTokens > config.LLM_DAILY_TOKEN_BUDGET;
}

// ---------- request / response types ----------

/** A single part in a content block. */
export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string }; // base64
}

/** A turn in the conversation. Gemini alternates `user` and `model` roles. */
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** A function declaration Gemini uses to describe available tools. */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>; // JSONSchema
}

export interface GeminiRequest {
  systemInstruction?: { parts: Array<{ text?: string }> };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: FunctionDeclaration[] }>;
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE' } };
  generationConfig?: { temperature?: number; topP?: number; maxOutputTokens?: number };
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  error?: { code: number; message: string; status: string };
}

// ---------- fetch override (test seam) ----------

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...args) => globalThis.fetch(...args);

/** Test seam: swap in a fake fetch. */
export function setFetchImpl(fn: FetchFn): void {
  fetchImpl = fn;
}

/** Test seam: restore the real fetch. */
export function resetFetchImpl(): void {
  fetchImpl = (...args) => globalThis.fetch(...args);
}

// ---------- public API ----------

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/**
 * Call the Gemini API. The model name comes from config.LLM_MODEL.
 * Throws `GeminiError` on non-2xx responses or transport failures.
 */
export async function generateContent(req: GeminiRequest): Promise<GeminiResponse> {
  const url = `${BASE_URL}/${config.LLM_MODEL}:generateContent?key=${encodeURIComponent(config.GEMINI_API_KEY)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  let body: GeminiResponse;
  try {
    body = JSON.parse(text) as GeminiResponse;
  } catch {
    throw new GeminiError(`gemini: invalid JSON (status ${res.status}): ${text.slice(0, 200)}`, res.status, text);
  }
  if (!res.ok) {
    const msg = body.error?.message ?? `gemini http ${res.status}`;
    throw new GeminiError(msg, res.status, body);
  }
  // Some Gemini errors come back 200 with `error` populated.
  if (body.error) {
    throw new GeminiError(body.error.message, body.error.code, body);
  }
  return body;
}