import {
  AgentConversation,
  type AgentConversationClassNames,
  type AgentTranscriptClassNames,
  type ChatComposerClassNames,
  type TranscriptEntry,
} from "@sandbox-agent/react";
import { AlertTriangle, Brain, ChevronDown, ChevronRight, ExternalLink, Info, PlayCircle, Send, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import MarkdownText from "./MarkdownText";

const agentLogos: Record<string, string> = {
  claude: `${import.meta.env.BASE_URL}logos/claude.svg`,
  codex: `${import.meta.env.BASE_URL}logos/openai.svg`,
  opencode: `${import.meta.env.BASE_URL}logos/opencode.svg`,
  amp: `${import.meta.env.BASE_URL}logos/amp.svg`,
  pi: `${import.meta.env.BASE_URL}logos/pi.svg`,
};

const transcriptClassNames: Partial<AgentTranscriptClassNames> = {
  root: "messages",
  divider: "status-divider",
  dividerLine: "status-divider-line",
  dividerText: "status-divider-text",
  message: "message",
  messageContent: "message-content",
  error: "message-error",
  toolGroupSingle: "tool-group-single",
  toolGroupContainer: "tool-group-container",
  toolGroupHeader: "tool-group-header",
  toolGroupIcon: "tool-group-icon",
  toolGroupLabel: "tool-group-label",
  toolGroupChevron: "tool-group-chevron",
  toolGroupBody: "tool-group",
  toolItem: "tool-item",
  toolItemConnector: "tool-item-connector",
  toolItemDot: "tool-item-dot",
  toolItemLine: "tool-item-line",
  toolItemContent: "tool-item-content",
  toolItemHeader: "tool-item-header",
  toolItemIcon: "tool-item-icon",
  toolItemLabel: "tool-item-label",
  toolItemSpinner: "tool-item-spinner",
  toolItemLink: "tool-item-link",
  toolItemChevron: "tool-item-chevron",
  toolItemBody: "tool-item-body",
  toolSection: "tool-section",
  toolSectionTitle: "tool-section-title",
  toolCode: "tool-code",
  toolCodeMuted: "muted",
  thinkingRow: "thinking-row",
  thinkingIndicator: "thinking-indicator",
};

const conversationClassNames: Partial<AgentConversationClassNames> = {
  root: "chat-conversation",
  transcript: "messages-container",
};

const composerClassNames: Partial<ChatComposerClassNames> = {
  root: "input-container",
  form: "input-wrapper",
  submit: "send-button",
};

const ThinkingDots = () => (
  <>
    <span className="thinking-dot" />
    <span className="thinking-dot" />
    <span className="thinking-dot" />
  </>
);

export interface InspectorConversationProps {
  entries: TranscriptEntry[];
  sessionError: string | null;
  eventError?: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  onEventClick?: (eventId: string) => void;
  isThinking?: boolean;
  agentId?: string;
  emptyState?: ReactNode;
  message: string;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  disabled: boolean;
}

const InspectorConversation = ({
  entries,
  sessionError,
  eventError,
  messagesEndRef,
  onEventClick,
  isThinking,
  agentId,
  emptyState,
  message,
  onMessageChange,
  onSendMessage,
  onKeyDown,
  placeholder,
  disabled,
}: InspectorConversationProps) => {
  return (
    <AgentConversation
      entries={entries}
      classNames={conversationClassNames}
      emptyState={emptyState}
      transcriptClassNames={transcriptClassNames}
      transcriptProps={{
        endRef: messagesEndRef,
        sessionError,
        eventError,
        onEventClick,
        isThinking,
        agentId,
        canOpenEvent: (entry) => !(entry.kind === "meta" && entry.meta?.title === "Available commands update"),
        renderMessageText: (entry) => <MarkdownText text={entry.text ?? ""} />,
        renderInlinePendingIndicator: () => <ThinkingDots />,
        renderToolItemIcon: (entry) => {
          if (entry.kind === "tool") {
            return <Wrench size={12} />;
          }
          if (entry.kind === "reasoning") {
            return <Brain size={12} />;
          }
          return entry.meta?.severity === "error" ? <AlertTriangle size={12} /> : <Info size={12} />;
        },
        renderToolGroupIcon: () => <PlayCircle size={14} />,
        renderChevron: (expanded) => (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />),
        renderEventLinkContent: () => <ExternalLink size={10} />,
        renderThinkingState: ({ agentId: activeAgentId }) => (
          <div className="thinking-row">
            <div className="thinking-avatar">
              {activeAgentId && agentLogos[activeAgentId] ? (
                <img src={agentLogos[activeAgentId]} alt="" className="thinking-avatar-img" />
              ) : (
                <span className="ai-label">AI</span>
              )}
            </div>
            <span className="thinking-indicator">
              <ThinkingDots />
            </span>
          </div>
        ),
      }}
      composerClassNames={composerClassNames}
      composerProps={{
        message,
        onMessageChange,
        onSubmit: onSendMessage,
        onKeyDown,
        placeholder,
        disabled,
        submitLabel: "Send",
        renderSubmitContent: () => <Send />,
      }}
    />
  );
};

export default InspectorConversation;
