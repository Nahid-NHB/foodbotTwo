import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

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
      'llm daily token budget exceeded',
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