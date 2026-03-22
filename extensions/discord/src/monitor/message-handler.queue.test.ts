import { describe, expect, it, vi } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

const eventualReplyDeliveredMock = vi.hoisted(() => vi.fn());
type SetStatusFn = (patch: Record<string, unknown>) => void;

function createDeferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [{ id: `att-${messageId}` }],
    },
  };
}

function createPreflightContext(channelId = "ch-1") {
  return createDiscordPreflightContext(channelId);
}

function createHandlerWithDefaultPreflight(overrides?: {
  setStatus?: SetStatusFn;
  workerRunTimeoutMs?: number;
}) {
  preflightDiscordMessageMock.mockImplementation(async (params: { data: { channel_id: string } }) =>
    createPreflightContext(params.data.channel_id),
  );
  return createDiscordMessageHandler(createDiscordHandlerParams(overrides));
}

async function createLifecycleStopScenario(params: {
  createHandler: (status: SetStatusFn) => {
    handler: (data: never, opts: never) => Promise<void>;
    stop: () => void;
  };
}) {
  preflightDiscordMessageMock.mockImplementation(
    async (preflightParams: { data: { channel_id: string } }) =>
      createPreflightContext(preflightParams.data.channel_id),
  );
  const runInFlight = createDeferred();
  processDiscordMessageMock.mockImplementation(async () => {
    await runInFlight.promise;
  });

  const setStatus = vi.fn<SetStatusFn>();
  const { handler, stop } = params.createHandler(setStatus);

  await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
  await vi.waitFor(() => {
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  const callsBeforeStop = setStatus.mock.calls.length;
  stop();

  return {
    setStatus,
    callsBeforeStop,
    finish: async () => {
      runInFlight.resolve();
      await runInFlight.promise;
      await Promise.resolve();
    },
  };
}

describe("createDiscordMessageHandler queue behavior", () => {
  it("resets busy counters when the handler is created", () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const setStatus = vi.fn();
    createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRuns: 0,
        busy: false,
      }),
    );
  });

  it("returns immediately and tracks busy status while queued runs execute", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred();
    const secondRun = createDeferred();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
      })
      .mockImplementationOnce(async () => {
        await secondRun.promise;
      });
    const setStatus = vi.fn();
    const handler = createHandlerWithDefaultPreflight({ setStatus });

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRuns: 1,
        busy: true,
      }),
    );

    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
    });
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

    firstRun.resolve();
    await firstRun.promise;

    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    });

    secondRun.resolve();
    await secondRun.promise;

    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeRuns: 0,
          busy: false,
        }),
      );
    });
  });

  it("drops duplicate inbound message deliveries before they reach preflight", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const handler = createHandlerWithDefaultPreflight();
    const duplicate = createMessageData("m-dup");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("releases the dedupe key when preflight fails so the same delivery can retry", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    preflightDiscordMessageMock
      .mockRejectedValueOnce(new Error("preflight boom"))
      .mockImplementation(async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
      );

    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler(params);
    const duplicate = createMessageData("m-retry");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
    expect(params.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("discord debounce flush failed: Error: preflight boom"),
    );
  });

  it("releases the dedupe key when preflight returns null so a later hydrated redelivery can retry", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    preflightDiscordMessageMock
      .mockResolvedValueOnce(null)
      .mockImplementation(async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
      );

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const duplicate = createMessageData("m-null-retry");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("releases the dedupe key when a queued flush is aborted so the same delivery can retry", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();
      preflightDiscordMessageMock.mockImplementation(
        async (params: { data: { channel_id: string } }) =>
          createPreflightContext(params.data.channel_id),
      );

      const params = createDiscordHandlerParams();
      params.cfg.messages = { inbound: { debounceMs: 50 } };
      const handler = createDiscordMessageHandler(params);
      const duplicate = createMessageData("m-abort-retry");
      const abortController = new AbortController();

      await expect(
        handler(duplicate as never, {} as never, { abortSignal: abortController.signal }),
      ).resolves.toBeUndefined();
      abortController.abort();

      await vi.advanceTimersByTimeAsync(60);
      await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

      await vi.waitFor(() => {
        expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
        expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the dedupe key when the inbound worker fails so the same delivery can retry", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    processDiscordMessageMock
      .mockRejectedValueOnce(new Error("worker boom"))
      .mockResolvedValueOnce(undefined);

    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler(params);
    const duplicate = createMessageData("m-worker-retry");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("discord inbound worker failed: Error: worker boom"),
      );
    });
    expect(params.runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("discord inbound worker failed after timeout"),
    );

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    });
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
  });

  it("replays a duplicate that arrived during preflight when the first attempt fails", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstAttempt = createDeferred();
    preflightDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstAttempt.promise;
        throw new Error("preflight boom");
      })
      .mockImplementation(async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
      );

    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler(params);
    const duplicate = createMessageData("m-preflight-inflight");

    const firstCall = handler(duplicate as never, {} as never);
    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

    firstAttempt.resolve();
    await expect(firstCall).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
    expect(params.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("discord debounce flush failed: Error: preflight boom"),
    );
  });

  it("replays a duplicate that arrived during worker execution when the first attempt fails", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const firstRun = createDeferred();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
        throw new Error("worker boom");
      })
      .mockResolvedValueOnce(undefined);

    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler(params);
    const duplicate = createMessageData("m-worker-inflight");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    firstRun.resolve();

    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    });
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(params.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("discord inbound worker failed: Error: worker boom"),
    );
  });

  it("still queues a duplicate retry while the first worker run is in flight after the dedupe TTL expires", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();
      preflightDiscordMessageMock.mockImplementation(
        async (params: { data: { channel_id: string } }) =>
          createPreflightContext(params.data.channel_id),
      );

      const firstRun = createDeferred();
      processDiscordMessageMock
        .mockImplementationOnce(async () => {
          await firstRun.promise;
          throw new Error("worker boom");
        })
        .mockResolvedValueOnce(undefined);

      const params = createDiscordHandlerParams();
      const handler = createDiscordMessageHandler(params);
      const duplicate = createMessageData("m-worker-ttl-retry");

      await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

      firstRun.resolve();

      await vi.waitFor(() => {
        expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      });
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the dedupe key when the worker drops a run after deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    handler.deactivate();
    const duplicate = createMessageData("m-dropped-retry");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
    });
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("clears pending duplicate replays when the handler is deactivated", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const firstRun = createDeferred();
    processDiscordMessageMock.mockImplementationOnce(async () => {
      await firstRun.promise;
      throw new Error("worker boom");
    });

    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler(params);
    const duplicate = createMessageData("m-deactivate-pending");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    handler.deactivate();
    firstRun.resolve();

    await vi.waitFor(() => {
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("discord inbound worker failed: Error: worker boom"),
      );
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the dedupe claim when a timed-out worker later succeeds while still unblocking later queued runs", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();
      const firstRunAfterAbort = createDeferred();

      processDiscordMessageMock
        .mockImplementationOnce(async (ctx: { abortSignal?: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            if (ctx.abortSignal?.aborted) {
              return;
            }
            ctx.abortSignal?.addEventListener(
              "abort",
              () => {
                void firstRunAfterAbort.promise.then(() => resolve());
              },
              { once: true },
            );
          });
        })
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => undefined);
      const params = createDiscordHandlerParams({ workerRunTimeoutMs: 50 });
      preflightDiscordMessageMock.mockImplementation(
        async (preflightParams: { data: { channel_id: string } }) =>
          createPreflightContext(preflightParams.data.channel_id),
      );
      const handler = createDiscordMessageHandler(params);

      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();
      await expect(
        handler(createMessageData("m-2") as never, {} as never),
      ).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(60);
      await vi.waitFor(() => {
        expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      });

      const retryCall = handler(createMessageData("m-1") as never, {} as never);
      await Promise.resolve();
      await Promise.resolve();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);

      const firstCtx = processDiscordMessageMock.mock.calls[0]?.[0] as
        | { abortSignal?: AbortSignal }
        | undefined;
      expect(firstCtx?.abortSignal?.aborted).toBe(true);
      firstRunAfterAbort.resolve();

      await Promise.resolve();
      await Promise.resolve();
      expect(firstCtx?.abortSignal?.aborted).toBe(true);
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("discord inbound worker timed out after"),
      );
      await expect(retryCall).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays a timed-out delivery when the original run later fails", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();
      const firstRunAfterAbort = createDeferred();

      processDiscordMessageMock
        .mockImplementationOnce(async (ctx: { abortSignal?: AbortSignal }) => {
          await new Promise<void>((resolve, reject) => {
            if (ctx.abortSignal?.aborted) {
              return;
            }
            ctx.abortSignal?.addEventListener(
              "abort",
              () => {
                void firstRunAfterAbort.promise.then(() => reject(new Error("worker boom")));
              },
              { once: true },
            );
          });
        })
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => undefined);

      const params = createDiscordHandlerParams({ workerRunTimeoutMs: 50 });
      preflightDiscordMessageMock.mockImplementation(
        async (preflightParams: { data: { channel_id: string } }) =>
          createPreflightContext(preflightParams.data.channel_id),
      );
      const handler = createDiscordMessageHandler(params);

      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();
      await expect(
        handler(createMessageData("m-2") as never, {} as never),
      ).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(60);
      await vi.waitFor(() => {
        expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      });

      const retryCall = handler(createMessageData("m-1") as never, {} as never);
      await Promise.resolve();
      await Promise.resolve();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);

      firstRunAfterAbort.resolve();

      await vi.waitFor(() => {
        expect(processDiscordMessageMock).toHaveBeenCalledTimes(3);
      });
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("discord inbound worker timed out after"),
      );
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("discord inbound worker failed after timeout: Error: worker boom"),
      );
      await expect(retryCall).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out queued runs when the inbound worker timeout is disabled", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();
      eventualReplyDeliveredMock.mockReset();

      processDiscordMessageMock.mockImplementationOnce(
        async (ctx: { abortSignal?: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              if (!ctx.abortSignal?.aborted) {
                eventualReplyDeliveredMock();
              }
              resolve();
            }, 80);
          });
        },
      );
      const params = createDiscordHandlerParams({ workerRunTimeoutMs: 0 });
      const handler = createHandlerWithDefaultPreflight({ workerRunTimeoutMs: 0 });

      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(80);
      await Promise.resolve();

      expect(eventualReplyDeliveredMock).toHaveBeenCalledTimes(1);
      expect(params.runtime.error).not.toHaveBeenCalledWith(
        expect.stringContaining("discord inbound worker timed out after"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes run activity while active runs are in progress", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const runInFlight = createDeferred();
    processDiscordMessageMock.mockImplementation(async () => {
      await runInFlight.promise;
    });
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    let heartbeatTick: () => void = () => {};
    let capturedHeartbeat = false;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          heartbeatTick = () => {
            callback();
          };
          capturedHeartbeat = true;
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      const setStatus = vi.fn();
      const handler = createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));
      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();

      await vi.waitFor(() => {
        expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
      });

      expect(capturedHeartbeat).toBe(true);
      const busyCallsBefore = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;

      heartbeatTick();

      const busyCallsAfter = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;
      expect(busyCallsAfter).toBeGreaterThan(busyCallsBefore);

      runInFlight.resolve();
      await runInFlight.promise;

      await vi.waitFor(() => {
        expect(clearIntervalSpy).toHaveBeenCalled();
      });
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("stops status publishing after lifecycle abort", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const abortController = new AbortController();
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status, abortSignal: abortController.signal }),
        );
        return { handler, stop: () => abortController.abort() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("stops status publishing after handler deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status }),
        );
        return { handler, stop: () => handler.deactivate() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("skips queued runs that have not started yet after deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
      })
      .mockImplementationOnce(async () => undefined);
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });

    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();
    handler.deactivate();

    firstRun.resolve();
    await firstRun.promise;
    await Promise.resolve();

    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("preserves non-debounced message ordering by awaiting debouncer enqueue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstPreflight = createDeferred();
    const processedMessageIds: string[] = [];

    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string; message?: { id?: string } } }) => {
        const messageId = params.data.message?.id ?? "unknown";
        if (messageId === "m-1") {
          await firstPreflight.promise;
        }
        return {
          ...createPreflightContext(params.data.channel_id),
          messageId,
        };
      },
    );

    processDiscordMessageMock.mockImplementation(async (ctx: { messageId?: string }) => {
      processedMessageIds.push(ctx.messageId ?? "unknown");
    });

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    const sequentialDispatch = (async () => {
      await handler(createMessageData("m-1") as never, {} as never);
      await handler(createMessageData("m-2") as never, {} as never);
    })();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);

    firstPreflight.resolve();
    await sequentialDispatch;

    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    });
    expect(processedMessageIds).toEqual(["m-1", "m-2"]);
  });

  it("recovers queue progress after a run failure without leaving busy state stuck", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
        throw new Error("simulated run failure");
      })
      .mockImplementationOnce(async () => undefined);
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const setStatus = vi.fn();
    const handler = createHandlerWithDefaultPreflight({ setStatus });

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    firstRun.resolve();
    await firstRun.promise.catch(() => undefined);

    await vi.waitFor(() => {
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ activeRuns: 0, busy: false }),
      );
    });
  });
});
