interface QueueSendResult {
  status: "completed" | "timedOut";
  response?: unknown;
}

export function expectQueueResponse<T>(result: QueueSendResult | void): T {
  if (!result || result.status === "timedOut") {
    throw new Error("Queue command timed out");
  }
  return result.response as T;
}

export function normalizeMessages<T>(input: T | T[] | null | undefined): T[] {
  if (!input) return [];
  return Array.isArray(input) ? input : [input];
}
