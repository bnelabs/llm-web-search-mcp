// Token estimation: 4 chars ≈ 1 token (intentional overestimate for safety)
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;

  // Truncate at last sentence boundary before the limit
  const truncated = text.slice(0, maxChars);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("\n"),
    truncated.lastIndexOf("\n\n"),
  );

  if (lastSentenceEnd > maxChars * 0.6) {
    return truncated.slice(0, lastSentenceEnd + 1) + `\n\n[... truncated, estimated ${maxTokens} tokens]`;
  }

  return truncated.slice(0, maxChars - 10) + `\n\n[... truncated, estimated ${maxTokens} tokens]`;
}

export function truncateTableToTokenLimit(table: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (table.length <= maxChars) return table;

  const lines = table.split("\n");
  const header = lines[0];
  const separator = lines[1];
  const dataLines = lines.slice(2);

  let result = header + "\n" + separator + "\n";
  let currentLength = result.length;

  for (const line of dataLines) {
    if (currentLength + line.length > maxChars) {
      const remaining = dataLines.length - dataLines.indexOf(line);
      result += `[... ${remaining} more rows, total ${dataLines.length} rows in source]\n`;
      break;
    }
    result += line + "\n";
    currentLength += line.length + 1;
  }

  return result.trimEnd();
}
