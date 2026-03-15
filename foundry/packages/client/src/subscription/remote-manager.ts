import type { BackendClient } from "../backend-client.js";
import type { DebugSubscriptionTopic, SubscriptionManager, TopicStatus } from "./manager.js";
import { topicDefinitions, type TopicData, type TopicDefinition, type TopicKey, type TopicParams } from "./topics.js";

const GRACE_PERIOD_MS = 30_000;

/**
 * Remote implementation of SubscriptionManager.
 * Each cache entry owns one actor connection plus one materialized snapshot.
 */
export class RemoteSubscriptionManager implements SubscriptionManager {
  private entries = new Map<string, TopicEntry<any, any, any>>();

  constructor(private readonly backend: BackendClient) {}

  subscribe<K extends TopicKey>(topicKey: K, params: TopicParams<K>, listener: () => void): () => void {
    const definition = topicDefinitions[topicKey] as unknown as TopicDefinition<any, any, any>;
    const cacheKey = definition.key(params as any);
    let entry = this.entries.get(cacheKey);

    if (!entry) {
      entry = new TopicEntry(topicKey, cacheKey, definition, this.backend, params as any);
      this.entries.set(cacheKey, entry);
    }

    entry.cancelTeardown();
    entry.addListener(listener);
    entry.ensureStarted();

    return () => {
      const current = this.entries.get(cacheKey);
      if (!current) {
        return;
      }
      current.removeListener(listener);
      if (current.listenerCount === 0) {
        current.scheduleTeardown(GRACE_PERIOD_MS, () => {
          this.entries.delete(cacheKey);
        });
      }
    };
  }

  getSnapshot<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicData<K> | undefined {
    return this.entries.get((topicDefinitions[topicKey] as any).key(params))?.data as TopicData<K> | undefined;
  }

  getStatus<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicStatus {
    return this.entries.get((topicDefinitions[topicKey] as any).key(params))?.status ?? "loading";
  }

  getError<K extends TopicKey>(topicKey: K, params: TopicParams<K>): Error | null {
    return this.entries.get((topicDefinitions[topicKey] as any).key(params))?.error ?? null;
  }

  listDebugTopics(): DebugSubscriptionTopic[] {
    return [...this.entries.values()]
      .filter((entry) => entry.listenerCount > 0)
      .map((entry) => entry.getDebugTopic())
      .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.dispose();
    }
    this.entries.clear();
  }
}

class TopicEntry<TData, TParams, TEvent> {
  data: TData | undefined;
  status: TopicStatus = "loading";
  error: Error | null = null;
  listenerCount = 0;
  lastRefreshAt: number | null = null;

  private readonly listeners = new Set<() => void>();
  private conn: Awaited<ReturnType<TopicDefinition<TData, TParams, TEvent>["connect"]>> | null = null;
  private unsubscribeEvent: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly topicKey: TopicKey,
    private readonly cacheKey: string,
    private readonly definition: TopicDefinition<TData, TParams, TEvent>,
    private readonly backend: BackendClient,
    private readonly params: TParams,
  ) {}

  getDebugTopic(): DebugSubscriptionTopic {
    return {
      topicKey: this.topicKey,
      cacheKey: this.cacheKey,
      listenerCount: this.listenerCount,
      status: this.status,
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  addListener(listener: () => void): void {
    this.listeners.add(listener);
    this.listenerCount = this.listeners.size;
  }

  removeListener(listener: () => void): void {
    this.listeners.delete(listener);
    this.listenerCount = this.listeners.size;
  }

  ensureStarted(): void {
    if (this.started || this.startPromise) {
      return;
    }
    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
  }

  scheduleTeardown(ms: number, onTeardown: () => void): void {
    this.teardownTimer = setTimeout(() => {
      this.dispose();
      onTeardown();
    }, ms);
  }

  cancelTeardown(): void {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }

  dispose(): void {
    this.cancelTeardown();
    this.unsubscribeEvent?.();
    this.unsubscribeError?.();
    if (this.conn) {
      void this.conn.dispose();
    }
    this.conn = null;
    this.data = undefined;
    this.status = "loading";
    this.error = null;
    this.lastRefreshAt = null;
    this.started = false;
  }

  private async start(): Promise<void> {
    this.status = "loading";
    this.error = null;
    this.notify();

    try {
      this.conn = await this.definition.connect(this.backend, this.params);
      this.unsubscribeEvent = this.conn.on(this.definition.event, (event: TEvent) => {
        if (this.data === undefined) {
          return;
        }
        this.data = this.definition.applyEvent(this.data, event);
        this.lastRefreshAt = Date.now();
        this.notify();
      });
      this.unsubscribeError = this.conn.onError((error: unknown) => {
        this.status = "error";
        this.error = error instanceof Error ? error : new Error(String(error));
        this.notify();
      });
      this.data = await this.definition.fetchInitial(this.backend, this.params);
      this.status = "connected";
      this.lastRefreshAt = Date.now();
      this.started = true;
      this.notify();
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error : new Error(String(error));
      this.started = false;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
