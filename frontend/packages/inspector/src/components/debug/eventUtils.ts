import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle,
  FileDiff,
  HelpCircle,
  Info,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Shield,
  Terminal,
  Wrench,
  Zap
} from "lucide-react";
import type { UniversalEvent } from "../../types/legacyApi";

export const getEventType = (event: UniversalEvent) => event.type;

export const getEventKey = (event: UniversalEvent) =>
  event.event_id ? `id:${event.event_id}` : `seq:${event.sequence}`;

export const getEventCategory = (type: string) => type.split(".")[0] ?? type;

export const getEventClass = (type: string) => type.replace(/\./g, "-");

export const getEventIcon = (type: string) => {
  switch (type) {
    // ACP session update events
    case "acp.agent_message_chunk":
      return MessageSquare;
    case "acp.user_message_chunk":
      return MessageSquare;
    case "acp.agent_thought_chunk":
      return Brain;
    case "acp.tool_call":
      return Wrench;
    case "acp.tool_call_update":
      return Activity;
    case "acp.plan":
      return FileDiff;
    case "acp.session_info_update":
      return Info;
    case "acp.usage_update":
      return Info;
    case "acp.current_mode_update":
      return Info;
    case "acp.config_option_update":
      return Info;
    case "acp.available_commands_update":
      return Terminal;

    // Inspector lifecycle events
    case "inspector.turn_started":
      return PlayCircle;
    case "inspector.turn_ended":
      return PauseCircle;
    case "inspector.user_message":
      return MessageSquare;

    // Session lifecycle (inspector-emitted)
    case "session.started":
      return PlayCircle;
    case "session.ended":
      return PauseCircle;

    // Legacy synthetic events
    case "turn.started":
      return PlayCircle;
    case "turn.ended":
      return PauseCircle;
    case "item.started":
      return MessageSquare;
    case "item.delta":
      return Activity;
    case "item.completed":
      return CheckCircle;

    // Approval events
    case "question.requested":
      return HelpCircle;
    case "question.resolved":
      return CheckCircle;
    case "permission.requested":
      return Shield;
    case "permission.resolved":
      return CheckCircle;

    // Error events
    case "error":
      return AlertTriangle;
    case "agent.unparsed":
      return Brain;

    default:
      if (type.startsWith("acp.")) return Zap;
      if (type.startsWith("inspector.")) return Info;
      if (type.startsWith("item.")) return MessageSquare;
      if (type.startsWith("session.")) return PlayCircle;
      if (type.startsWith("error")) return AlertTriangle;
      if (type.startsWith("agent.")) return Brain;
      if (type.startsWith("question.")) return HelpCircle;
      if (type.startsWith("permission.")) return Shield;
      if (type.startsWith("file.")) return FileDiff;
      if (type.startsWith("command.")) return Terminal;
      if (type.startsWith("tool.")) return Wrench;
      return Zap;
  }
};
