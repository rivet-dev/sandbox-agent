export type TimelineEntry = {
  id: string;
  kind: "message" | "tool" | "meta" | "reasoning";
  time: string;
  // For messages:
  role?: "user" | "assistant";
  text?: string;
  // For tool calls:
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  toolStatus?: string;
  // For reasoning:
  reasoning?: { text: string; visibility?: string };
  // For meta:
  meta?: { title: string; detail?: string; severity?: "info" | "error" };
};
