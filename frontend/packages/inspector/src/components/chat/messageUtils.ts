import type { TimelineEntry } from "./types";

export const getMessageClass = (entry: TimelineEntry) => {
  if (entry.kind === "tool") return "tool";
  if (entry.kind === "meta") return entry.meta?.severity === "error" ? "error" : "system";
  if (entry.kind === "reasoning") return "assistant";
  if (entry.role === "user") return "user";
  return "assistant";
};

export const getAvatarLabel = (messageClass: string) => {
  if (messageClass === "user") return "U";
  if (messageClass === "tool") return "T";
  if (messageClass === "system") return "S";
  if (messageClass === "error") return "!";
  return "AI";
};
