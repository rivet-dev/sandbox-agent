declare module "@sandbox-agent/react" {
  import type { CSSProperties, KeyboardEvent, ReactNode, Ref, RefObject, TextareaHTMLAttributes } from "react";
  import type { SandboxAgent } from "sandbox-agent";

  export type PermissionReply = "once" | "always" | "reject";

  export type PermissionOption = {
    optionId: string;
    name: string;
    kind: string;
  };

  export type TranscriptEntry = {
    id: string;
    eventId?: string;
    kind: "message" | "tool" | "meta" | "reasoning" | "permission";
    time: string;
    role?: "user" | "assistant";
    text?: string;
  };

  export interface AgentTranscriptClassNames {
    root: string;
    message: string;
    messageContent: string;
    messageText: string;
    thinkingRow: string;
    thinkingIndicator: string;
  }

  export interface PermissionOptionRenderContext {
    entry: TranscriptEntry;
    option: PermissionOption;
    label: string;
    reply: PermissionReply;
    selected: boolean;
    dimmed: boolean;
    resolved: boolean;
  }

  export interface AgentTranscriptProps {
    entries: TranscriptEntry[];
    className?: string;
    classNames?: Partial<AgentTranscriptClassNames>;
    endRef?: RefObject<HTMLDivElement>;
    sessionError?: string | null;
    eventError?: string | null;
    isThinking?: boolean;
    agentId?: string;
    onEventClick?: (eventId: string) => void;
    onPermissionReply?: (permissionId: string, reply: PermissionReply) => void;
    renderMessageText?: (entry: TranscriptEntry) => ReactNode;
    renderInlinePendingIndicator?: () => ReactNode;
    renderThinkingState?: (context: { agentId?: string }) => ReactNode;
    renderPermissionOptionContent?: (context: PermissionOptionRenderContext) => ReactNode;
  }

  export const AgentTranscript: (props: AgentTranscriptProps) => ReactNode;

  export interface ChatComposerClassNames {
    root: string;
    form: string;
    input: string;
    submit: string;
    submitContent: string;
  }

  export interface ChatComposerProps {
    message: string;
    onMessageChange: (value: string) => void;
    onSubmit: () => void;
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
    disabled?: boolean;
    submitDisabled?: boolean;
    allowEmptySubmit?: boolean;
    submitLabel?: string;
    className?: string;
    classNames?: Partial<ChatComposerClassNames>;
    inputRef?: Ref<HTMLTextAreaElement>;
    rows?: number;
    textareaProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "disabled" | "onChange" | "onKeyDown" | "placeholder" | "rows" | "value">;
    renderSubmitContent?: () => ReactNode;
    renderFooter?: () => ReactNode;
  }

  export const ChatComposer: (props: ChatComposerProps) => ReactNode;

  export interface ProcessTerminalClient extends SandboxAgent {}

  export interface ProcessTerminalProps {
    client: SandboxAgent | null;
    processId: string;
    height?: string | number;
    showStatusBar?: boolean;
    style?: CSSProperties;
    terminalStyle?: CSSProperties;
    onExit?: () => void;
  }

  export const ProcessTerminal: (props: ProcessTerminalProps) => ReactNode;
}
