import { describe, expect, it, vi } from "vitest";
import {
  MemoryIndexManager,
  type MemoryIndexManager as MemoryIndexManagerInstance,
} from "./index.js";

describe("memory search async sync", () => {
  it("does not await sync when searching", async () => {
    const pending = new Promise<void>(() => {});
    const syncMock = vi.fn(async () => pending);
    const activeManager: {
      sync: () => Promise<void>;
      ensureProviderInitialized: () => Promise<void>;
      provider: { id: string; model: string } | null;
      settings: {
        sync: { onSearch: boolean };
        query: {
          minScore: number;
          maxResults: number;
          hybrid: { enabled: boolean; candidateMultiplier: number };
        };
      };
      warmSession: (sessionKey?: string) => Promise<void>;
      dirty: boolean;
      sessionsDirty: boolean;
      fts: { enabled: boolean; available: boolean };
      embedQueryWithTimeout: (input: string) => Promise<number[]>;
      searchVector: (
        queryVec: number[],
        limit: number,
      ) => Promise<Array<{ score: number; id: string }>>;
    } = {
      sync: syncMock,
      ensureProviderInitialized: async () => {},
      provider: { id: "openai", model: "text-embedding-3-small" },
      settings: {
        sync: { onSearch: true },
        query: {
          minScore: 0,
          maxResults: 10,
          hybrid: { enabled: false, candidateMultiplier: 1 },
        },
      },
      warmSession: async () => {},
      dirty: true,
      sessionsDirty: false,
      fts: { enabled: false, available: false },
      embedQueryWithTimeout: async () => [0.2, 0.2, 0.2],
      searchVector: async () => [],
    };
    await MemoryIndexManager.prototype.search.call(
      activeManager as unknown as MemoryIndexManagerInstance,
      "hello",
    );
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight search sync during close", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const watcherClose = vi.fn(async () => {});
    const sessionUnsubscribe = vi.fn();
    const dbClose = vi.fn();
    const watchTimer = setTimeout(() => undefined, 60_000);
    const sessionWatchTimer = setTimeout(() => undefined, 60_000);
    const intervalTimer = setInterval(() => undefined, 60_000);
    const activeManager = {
      closed: false,
      syncing: pendingSync,
      providerInitPromise: null,
      watchTimer,
      sessionWatchTimer,
      intervalTimer,
      watcher: { close: watcherClose },
      sessionUnsubscribe,
      db: { close: dbClose },
      cacheKey: "close-test",
    };

    let closed = false;
    const closePromise = MemoryIndexManager.prototype.close
      .call(activeManager as unknown as MemoryIndexManagerInstance)
      .then(() => {
        closed = true;
      });

    await Promise.resolve();
    expect(closed).toBe(false);
    expect(dbClose).not.toHaveBeenCalled();

    releaseSync();
    await closePromise;
    expect(activeManager.closed).toBe(true);
    expect(watcherClose).toHaveBeenCalledTimes(1);
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
  });
});
