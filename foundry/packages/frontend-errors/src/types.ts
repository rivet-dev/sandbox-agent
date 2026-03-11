export type FrontendErrorKind = "window-error" | "resource-error" | "unhandled-rejection" | "console-error" | "fetch-error" | "fetch-response-error";

export interface FrontendErrorContext {
  route?: string;
  workspaceId?: string;
  taskId?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface FrontendErrorEventInput {
  kind?: string;
  message?: string;
  stack?: string | null;
  source?: string | null;
  line?: number | null;
  column?: number | null;
  url?: string | null;
  timestamp?: number;
  context?: FrontendErrorContext | null;
  extra?: Record<string, unknown> | null;
}

export interface FrontendErrorLogEvent {
  id: string;
  kind: FrontendErrorKind;
  message: string;
  stack: string | null;
  source: string | null;
  line: number | null;
  column: number | null;
  url: string | null;
  timestamp: number;
  receivedAt: number;
  userAgent: string | null;
  clientIp: string | null;
  reporter: string;
  context: FrontendErrorContext;
  extra: Record<string, unknown>;
}

export interface FrontendErrorCollectorScriptOptions {
  endpoint: string;
  reporter?: string;
  includeConsoleErrors?: boolean;
  includeFetchErrors?: boolean;
}
