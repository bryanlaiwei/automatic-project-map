export type Message = { role: "User" | "Agent"; at: string | null; text: string };

const messageStart = /^(User|Agent) \(([^)]*)\): /gm;

/** Session excerpts are stored as "User (time): text" blocks; split them back into turns. */
export function parseExcerpt(excerpt: string): Message[] {
  const starts = [...excerpt.matchAll(messageStart)];
  if (starts.length === 0) {
    return [{ role: "Agent", at: null, text: excerpt.trim() }];
  }
  return starts.map((match, index) => {
    const next = starts[index + 1];
    const bodyStart = (match.index ?? 0) + match[0].length;
    const text = excerpt.slice(bodyStart, next?.index ?? excerpt.length).trim();
    return { role: match[1] === "User" ? "User" : "Agent", at: match[2] ?? null, text };
  });
}
