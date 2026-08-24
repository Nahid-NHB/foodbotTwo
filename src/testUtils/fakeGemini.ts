/**
 * Shared test mock for the Gemini API.
 *
 * Stubs out the `fetch` that `src/ai/gemini.ts` calls so tests can queue up
 * canned `generateContent` responses. Captures requests for assertion.
 *
 * Usage:
 *
 *   const fake = new FakeGemini();
 *   fake.queueResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
 *   // ... code under test calls generateContent(...)
 *   expect(fake.lastRequest.tools).toBeDefined();
 */
import { vi } from 'vitest';

export interface FakeGeminiResponse {
  candidates?: Array<{
    content?: { parts?: unknown[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: { totalTokenCount?: number; promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code: number; message: string; status: string };
}

export interface CapturedGeminiRequest {
  systemInstruction?: unknown;
  contents: unknown[];
  tools?: unknown[];
  toolConfig?: unknown;
  generationConfig?: unknown;
}

export class FakeGemini {
  static responses: FakeGeminiResponse[] = [];
  static requests: CapturedGeminiRequest[] = [];

  reset(): void {
    FakeGemini.responses = [];
    FakeGemini.requests = [];
  }

  /** Queue a canned response. */
  queueResponse(r: FakeGeminiResponse): void {
    FakeGemini.responses.push(r);
  }

  /** Last request body the agent sent. */
  get lastRequest(): CapturedGeminiRequest | undefined {
    return FakeGemini.requests[FakeGemini.requests.length - 1];
  }

  /** A fetch impl that pulls responses from the queue. */
  static fetchImpl: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    let body: CapturedGeminiRequest | undefined;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body) as CapturedGeminiRequest;
        FakeGemini.requests.push(body);
      } catch {
        /* ignore */
      }
    }
    const next = FakeGemini.responses.shift();
    if (!next) {
      return new Response(
        JSON.stringify({ error: { code: 0, message: 'FakeGemini: no responses queued', status: 'INTERNAL' } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }
    void _input;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  install(): void {
    FakeGemini.responses = [];
    FakeGemini.requests = [];
  }
}

/**
 * Convenience helper: queue a response that emits a single text reply.
 */
export function geminiTextReply(text: string, totalTokens = 50): FakeGeminiResponse {
  return {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: totalTokens, promptTokenCount: 30, candidatesTokenCount: totalTokens - 30 },
  };
}

/**
 * Convenience helper: queue a response that emits a single function call.
 */
export function geminiToolCall(name: string, args: Record<string, unknown>, totalTokens = 40): FakeGeminiResponse {
  return {
    candidates: [
      {
        content: { parts: [{ functionCall: { name, args } }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { totalTokenCount: totalTokens, promptTokenCount: 25, candidatesTokenCount: totalTokens - 25 },
  };
}

/**
 * Wire up the fake as the module's fetch implementation.
 * Call this once per test file inside `vi.hoisted` or top-level.
 */
export function useFakeGemini(): FakeGemini {
  const fake = new FakeGemini();
  fake.install();
  return fake;
}

/** Vitest mock helper — registers the fetch override at module load. */
export const mockGeminiFetch = vi.fn().mockImplementation(FakeGemini.fetchImpl);