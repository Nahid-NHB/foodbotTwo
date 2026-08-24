/**
 * Detect simple yes/no questions in agent replies and return suggested chips
 * to render under the bubble. Matches common Bangla + Banglish patterns.
 */

const YES_NO_PATTERNS = [
  /কনফার্ম করবেন\?/,
  /কনফার্ম করবেন/i,
  /অর্ডারটি\s+কনফার্ম/,
  /\b(yes|no)\b.*\?/i,
  /\b(হ্যাঁ|না)\s*\/\s*(হ্যাঁ|না)/,
  /ঠিক আছে\?/,
  /চান\?$/m,
];

export interface QuickReply {
  label: string;
  send: string;
}

export function detectQuickReplies(reply: string): QuickReply[] | null {
  const matched = YES_NO_PATTERNS.some((p) => p.test(reply));
  if (!matched) return null;

  // Localized options: bangla first, banglish fallback for English-leaning replies.
  if (/[অ-হ]/.test(reply)) {
    return [
      { label: "হ্যাঁ", send: "হ্যাঁ" },
      { label: "না", send: "না" },
    ];
  }
  return [
    { label: "Yes", send: "yes" },
    { label: "No", send: "no" },
  ];
}