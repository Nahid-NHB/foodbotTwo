import db from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generateContent, recordTokens, budgetExceeded, type GeminiContent, type GeminiPart, type GeminiRequest } from './gemini.js';
import { systemPrompt } from './prompts.js';
import { toolDefinitions, runTool, type AgentContext } from './tools.js';
import { ToolError, MenuItemNotFoundError, MenuItemUnavailableError } from '../common/errors.js';

const MAX_TOOL_ITERATIONS = 5;
const HISTORY_WINDOW = 20;

interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  name?: string;
}

export interface AgentInput {
  conversationId: string;
  customerId: string;
  restaurantId: string;
  userText: string;
}

export interface AgentResult {
  reply: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  totalTokens: number;
}

/**
 * Load last N inbound messages. For MVP we only feed user-text history; tool
 * calls and assistant text are not fed back into the model in Phase 1 to keep
 * token usage low. The model already has full context via the system prompt
 * and the current cart.
 */
async function loadHistory(conversationId: string): Promise<HistoryMessage[]> {
  const rows = await db.query<{ direction: string; transcript: string | null }>(
    `SELECT direction, transcript FROM messages
     WHERE conversation_id = $1 AND direction = 'inbound'
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, HISTORY_WINDOW],
  );
  const reversed = [...rows].reverse();
  return reversed.map((r) => ({
    role: 'user' as const,
    content: r.transcript ?? '',
  }));
}

function safeErrorResult(err: unknown): string {
  if (err instanceof ToolError) {
    return JSON.stringify({ error: err.code, customerMessage: err.customerMessage });
  }
  if (err instanceof MenuItemNotFoundError) {
    return JSON.stringify({ error: 'menu_item_not_found', customerMessage: err.customerMessage });
  }
  if (err instanceof MenuItemUnavailableError) {
    return JSON.stringify({ error: 'menu_item_unavailable', customerMessage: err.customerMessage });
  }
  logger.error({ err }, 'unexpected tool error');
  return JSON.stringify({ error: 'internal', customerMessage: 'একটু সমস্যা হয়েছে। আবার চেষ্টা করবেন?' });
}

/**
 * Build the initial Gemini `contents` from inbound history. History is fed as
 * alternating user/model turns with text only.
 */
function historyToContents(history: HistoryMessage[], latestUserText: string): GeminiContent[] {
  const contents: GeminiContent[] = [];
  // Phase 1 simplification: history is just user messages. Each becomes a
  // separate user turn. This isn't a faithful chat replay but it's what we
  // shipped with the OpenAI version too.
  for (const m of history) {
    if (m.content.length > 0) {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: latestUserText }] });
  return contents;
}

/**
 * Read a Gemini response and extract:
 * - any text content (concatenated across parts)
 * - any function calls
 */
function parseResponse(parts: GeminiPart[] | undefined): {
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  let text = '';
  const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const part of parts ?? []) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      functionCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      });
    }
  }
  return { text, functionCalls };
}

/**
 * Run one conversation turn. Up to MAX_TOOL_ITERATIONS tool-call rounds.
 */
export async function runConversationTurn(input: AgentInput): Promise<AgentResult> {
  const ctx: AgentContext = {
    conversationId: input.conversationId,
    customerId: input.customerId,
    restaurantId: input.restaurantId,
  };

  if (budgetExceeded()) {
    return {
      reply:
        'ভাই, এই মুহূর্তে অনেক অর্ডার হচ্ছে। একটু পরে আবার লিখবেন, কিংবা সরাসরি মেনু থেকে অর্ডার করুন।',
      toolCalls: [],
      totalTokens: 0,
    };
  }

  const history = await loadHistory(input.conversationId);
  const contents = historyToContents(history, input.userText);

  const toolCallsLog: AgentResult['toolCalls'] = [];
  let totalTokens = 0;
  let finalReply = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const req: GeminiRequest = {
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      tools: [{ functionDeclarations: toolDefinitions }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.2 },
    };

    const response = await generateContent(req);
    totalTokens += response.usageMetadata?.totalTokenCount ?? 0;
    recordTokens(response.usageMetadata?.totalTokenCount ?? 0);

    const candidate = response.candidates?.[0];
    if (!candidate) break;

    const { text, functionCalls } = parseResponse(candidate.content?.parts);

    if (functionCalls.length > 0) {
      // Push the model's tool-call turn back into history verbatim.
      contents.push({
        role: 'model',
        parts: candidate.content?.parts ?? [],
      });

      // Execute each tool call and append a functionResponse part to the
      // next user turn. Gemini requires tool responses under role: 'user'.
      const responseParts: GeminiPart[] = [];
      for (const fc of functionCalls) {
        const result = await runTool(fc.name, fc.args, ctx).catch(safeErrorResult);
        toolCallsLog.push({ name: fc.name, args: fc.args, result });
        responseParts.push({
          functionResponse: { name: fc.name, response: parseToolResult(result) },
        });
      }
      contents.push({ role: 'user', parts: responseParts });
      continue;
    }

    // No tool calls — final text reply.
    finalReply = text;
    break;
  }

  if (!finalReply) {
    finalReply = 'ভাই, একটু জটিল হয়ে গেল। আবার বলবেন?';
  }

  return { reply: finalReply, toolCalls: toolCallsLog, totalTokens };
}

/**
 * Gemini functionResponse.response must be a JSON object, not a string.
 * Our tool handlers already return JSON strings; parse them safely so the
 * model sees structured data.
 */
function parseToolResult(result: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { text: result };
  }
}

export const __test = { loadHistory, historyToContents, parseResponse, parseToolResult };