import { createRunStateMachine } from "openclaw/plugin-sdk/channel-lifecycle";
import { formatDurationSeconds } from "openclaw/plugin-sdk/infra-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import { processDiscordMessage } from "./message-handler.process.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { normalizeDiscordInboundWorkerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";

type DiscordInboundWorkerParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  runTimeoutMs?: number;
};

export type DiscordInboundWorker = {
  enqueue: (
    job: DiscordInboundJob,
    callbacks?: {
      onDropped?: () => void;
      onTimeout?: (settledAfterTimeout: Promise<"success" | "aborted" | "error">) => void;
      onSuccess?: () => void;
      onError?: (error: unknown) => void;
    },
  ) => void;
  deactivate: () => void;
};

function formatDiscordRunContextSuffix(job: DiscordInboundJob): string {
  const channelId = job.payload.messageChannelId?.trim();
  const messageId = job.payload.data?.message?.id?.trim();
  const details = [
    channelId ? `channelId=${channelId}` : null,
    messageId ? `messageId=${messageId}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (details.length === 0) {
    return "";
  }
  return ` (${details.join(", ")})`;
}

async function processDiscordInboundJob(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  lifecycleSignal?: AbortSignal;
  runTimeoutMs?: number;
}): Promise<{
  timedOut: boolean;
  settledAfterTimeout?: Promise<"success" | "aborted" | "error">;
}> {
  const timeoutMs = normalizeDiscordInboundWorkerTimeoutMs(params.runTimeoutMs);
  const contextSuffix = formatDiscordRunContextSuffix(params.job);
  const result = await runDiscordTaskWithTimeout({
    run: async (abortSignal) => {
      await processDiscordMessage(materializeDiscordInboundJob(params.job, abortSignal));
    },
    timeoutMs,
    abortSignals: [params.job.runtime.abortSignal, params.lifecycleSignal],
    onTimeout: (resolvedTimeoutMs) => {
      params.runtime.error?.(
        danger(
          `discord inbound worker timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
            decimals: 1,
            unit: "seconds",
          })}${contextSuffix}`,
        ),
      );
    },
    onErrorAfterTimeout: (error) => {
      params.runtime.error?.(
        danger(`discord inbound worker failed after timeout: ${String(error)}${contextSuffix}`),
      );
    },
  });
  return result;
}

export function createDiscordInboundWorker(
  params: DiscordInboundWorkerParams,
): DiscordInboundWorker {
  const runQueue = new KeyedAsyncQueue();
  const runState = createRunStateMachine({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
  });

  return {
    enqueue(job, callbacks) {
      void runQueue
        .enqueue(job.queueKey, async () => {
          if (!runState.isActive()) {
            callbacks?.onDropped?.();
            return;
          }
          runState.onRunStart();
          try {
            if (!runState.isActive()) {
              callbacks?.onDropped?.();
              return;
            }
            const result = await processDiscordInboundJob({
              job,
              runtime: params.runtime,
              lifecycleSignal: params.abortSignal,
              runTimeoutMs: params.runTimeoutMs,
            });
            if (result.timedOut) {
              callbacks?.onTimeout?.(result.settledAfterTimeout ?? Promise.resolve("error"));
              return;
            }
            callbacks?.onSuccess?.();
          } catch (error) {
            callbacks?.onError?.(error);
            throw error;
          } finally {
            runState.onRunEnd();
          }
        })
        .catch((error) => {
          params.runtime.error?.(danger(`discord inbound worker failed: ${String(error)}`));
        });
    },
    deactivate: runState.deactivate,
  };
}
