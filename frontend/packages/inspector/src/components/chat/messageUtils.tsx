import type { TimelineEntry } from "./types";
import { Settings, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

export const getMessageClass = (entry: TimelineEntry) => {
  if (entry.kind === "tool") return "tool";
  if (entry.kind === "meta") return entry.meta?.severity === "error" ? "error" : "system";
  if (entry.kind === "reasoning") return "assistant";
  if (entry.role === "user") return "user";
  return "assistant";
};

export const getAvatarLabel = (messageClass: string): ReactNode => {
  if (messageClass === "user") return null;
  if (messageClass === "tool") return "T";
  if (messageClass === "system") return <Settings size={14} />;
  if (messageClass === "error") return <AlertTriangle size={14} />;
  return <span className="ai-label">AI</span>;
};
