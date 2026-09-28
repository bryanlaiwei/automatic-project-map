// Pulls out the words a person wrote in a chat message.
// Hidden thinking and big tool output are left out.

type ContentBlock = {
  type?: string;
  text?: string;
  content?: unknown;
};

export function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const typed = block as ContentBlock;
    if (typed.type === "thinking" || typed.type === "reasoning") {
      continue;
    }
    if (typed.type === "tool_result" || typed.type === "tool_use") {
      parts.push("[tool output omitted]");
      continue;
    }
    if (typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("\n");
}
