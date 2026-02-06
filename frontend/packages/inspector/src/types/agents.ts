import type { AgentCapabilities } from "sandbox-agent";

export type FeatureCoverageView = AgentCapabilities & {
  toolResults?: boolean;
  textMessages?: boolean;
  images?: boolean;
  fileAttachments?: boolean;
  sessionLifecycle?: boolean;
  errorEvents?: boolean;
  reasoning?: boolean;
  status?: boolean;
  commandExecution?: boolean;
  fileChanges?: boolean;
  mcpTools?: boolean;
  streamingDeltas?: boolean;
  itemStarted?: boolean;
  variants?: boolean;
};

export const emptyFeatureCoverage: FeatureCoverageView = {
  planMode: false,
  permissions: false,
  questions: false,
  toolCalls: false,
  toolResults: false,
  textMessages: false,
  images: false,
  fileAttachments: false,
  sessionLifecycle: false,
  errorEvents: false,
  reasoning: false,
  status: false,
  commandExecution: false,
  fileChanges: false,
  mcpTools: false,
  streamingDeltas: false,
  itemStarted: false,
  variants: false,
  sharedProcess: false
};
