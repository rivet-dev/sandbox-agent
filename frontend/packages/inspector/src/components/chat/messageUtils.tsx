import type { UniversalItem } from "sandbox-agent";
import { Settings, AlertTriangle, User } from "lucide-react";
import type { ReactNode } from "react";

export const getMessageClass = (item: UniversalItem) => {
  if (item.kind === "tool_call" || item.kind === "tool_result") return "tool";
  if (item.kind === "system" || item.kind === "status") return "system";
  if (item.role === "user") return "user";
  if (item.role === "tool") return "tool";
  if (item.role === "system") return "system";
  return "assistant";
};

export const getAvatarLabel = (messageClass: string): ReactNode => {
  if (messageClass === "user") return <User size={14} />;
  if (messageClass === "tool") return "T";
  if (messageClass === "system") return <Settings size={14} />;
  if (messageClass === "error") return <AlertTriangle size={14} />;
  return "AI";
};
