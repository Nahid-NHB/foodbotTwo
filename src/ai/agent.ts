import db from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { openai, recordTokens, budgetExceeded } from './client.js';
import { systemPrompt } from './prompts.js';
import { toolDefinitions, runTool, type AgentContext } from './tools.js';
import { ToolError, MenuItemNotFoundError, MenuItemUnavailableError } from '../common/errors.js';
import * as ConversationService from '../conversation/service.js';

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
 * Load last N messages. For MVP we only feed user-text history. Tool calls
 * and assistant text are not fed back into the model in Phase 1 to keep
 * token usage low; the model already has full context via the system prompt
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
  // Use a typed mutable array of chat messages.
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt() },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: input.userText },
  ];

  const toolCallsLog: AgentResult['toolCalls'] = [];
  let totalTokens = 0;
  let finalReply = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await openai.chat.completions.create({
      model: config.LLM_MODEL,
      // Cast because OpenAI's strict types refuse our mutable array shape.
      messages: messages as never,
      tools: toolDefinitions,
      tool_choice: 'auto',
      temperature: 0.2,
    });
    totalTokens += response.usage?.total_tokens ?? 0;
    recordTokens(response.usage?.total_tokens ?? 0);

    const choice = response.choices[0];
    if (!choice) break;
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Persist assistant message with tool_calls (model expects this for round-trip).
      messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        const result = await runTool(name, args, ctx).catch(safeErrorResult);
        toolCallsLog.push({ name, args, result });
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name });
      }
      continue;
    }

    // No tool calls — this is the final reply.
    finalReply = msg.content ?? '';
    messages.push({ role: 'assistant', content: finalReply });
    break;
  }

  if (!finalReply) {
    finalReply = 'ভাই, একটু জটিল হয়ে গেল। আবার বলবেন?';
  }

  return { reply: finalReply, toolCalls: toolCallsLog, totalTokens };
}

export const __test = { loadHistory };