import * as React from "react";

/**
 * Tiny, safe Markdown renderer covering only what the agent actually emits:
 * - bullet lists (lines starting with `• ` or `- `)
 * - blank-line paragraph breaks
 * - **bold** and *italic*
 * - inline `code`
 * - bare URLs (auto-linked)
 *
 * Anything else passes through as text. We escape HTML first to avoid XSS
 * from user-typed messages.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(escaped: string, keyPrefix: string): React.ReactNode[] {
  // Order matters: code first (no formatting inside), then bold, italic, link.
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let buf = "";
  let counter = 0;
  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = "";
    }
  };

  while (i < escaped.length) {
    // Inline code: `...`
    if (escaped[i] === "`") {
      const end = escaped.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push(
          <code
            key={`${keyPrefix}-c-${counter++}`}
            className="rounded bg-[var(--color-muted)] px-1 py-0.5 font-mono text-[0.85em]"
          >
            {escaped.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    // Bold: **...**
    if (escaped.startsWith("**", i)) {
      const end = escaped.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        nodes.push(
          <strong key={`${keyPrefix}-b-${counter++}`}>
            {renderInline(escaped.slice(i + 2, end), `${keyPrefix}-b-${counter}`)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }
    // Italic: *...* (not **)
    if (escaped[i] === "*" && escaped[i + 1] !== "*") {
      const end = escaped.indexOf("*", i + 1);
      if (end !== -1 && escaped[end + 1] !== "*") {
        flush();
        nodes.push(
          <em key={`${keyPrefix}-i-${counter++}`}>
            {escaped.slice(i + 1, end)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }
    buf += escaped[i];
    i++;
  }
  flush();
  return nodes;
}

function autoLink(escaped: string, keyPrefix: string): React.ReactNode[] {
  const urlRe = /(https?:\/\/[^\s<]+)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let counter = 0;
  while ((m = urlRe.exec(escaped)) !== null) {
    if (m.index > last) {
      nodes.push(...renderInline(escaped.slice(last, m.index), `${keyPrefix}-t-${counter}`));
    }
    nodes.push(
      <a
        key={`${keyPrefix}-l-${counter++}`}
        href={m[1]}
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        {m[1]}
      </a>,
    );
    last = m.index + m[1].length;
  }
  if (last < escaped.length) {
    nodes.push(...renderInline(escaped.slice(last), `${keyPrefix}-t-${counter}`));
  }
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines between blocks.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Bullet list: collect consecutive lines starting with `• ` or `- `.
    if (/^[•\-\*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[•\-\*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[•\-\*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul
          key={`md-ul-${keyCounter++}`}
          className="my-1.5 ml-4 list-disc space-y-0.5"
        >
          {items.map((it, j) => (
            <li key={j}>{autoLink(escapeHtml(it), `md-ul-${keyCounter}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-bullet lines.
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^[•\-\*]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const text = paraLines.join("\n");
    blocks.push(
      <p key={`md-p-${keyCounter++}`} className="whitespace-pre-wrap leading-relaxed">
        {autoLink(escapeHtml(text), `md-p-${keyCounter}`)}
      </p>,
    );
  }

  return <div className="space-y-1">{blocks}</div>;
}