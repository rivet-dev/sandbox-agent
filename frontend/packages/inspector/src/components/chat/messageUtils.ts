import type { UniversalItem } from "../../types/legacyApi";

export const getMessageClass = (item: UniversalItem) => {
  if (item.kind === "tool_call" || item.kind === "tool_result") return "tool";
  if (item.kind === "system" || item.kind === "status") return "system";
  if (item.role === "user") return "user";
  if (item.role === "tool") return "tool";
  if (item.role === "system") return "system";
  return "assistant";
};

export const getAvatarLabel = (messageClass: string) => {
  if (messageClass === "user") return "U";
  if (messageClass === "tool") return "T";
  if (messageClass === "system") return "S";
  if (messageClass === "error") return "!";
  return "AI";
};
