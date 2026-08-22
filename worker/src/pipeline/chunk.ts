const MAX_TOKENS = 600;

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function chunkMarkdown(md: string): string[] {
  const blocks = md
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let cur = "";
  for (const block of blocks) {
    if (approxTokens(cur) + approxTokens(block) > MAX_TOKENS && cur) {
      chunks.push(cur);
      cur = block;
    } else if (approxTokens(block) > MAX_TOKENS) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      const sentences = block.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (approxTokens(cur) + approxTokens(s) > MAX_TOKENS && cur) {
          chunks.push(cur);
          cur = s;
        } else {
          cur = cur ? `${cur} ${s}` : s;
        }
      }
    } else {
      cur = cur ? `${cur}\n\n${block}` : block;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => approxTokens(c) > 8 || c.startsWith("#"));
}
