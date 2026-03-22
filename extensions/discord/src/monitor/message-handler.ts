import type { Client } from "@buape/carbon";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { buildDiscordInboundJob } from "./inbound-job.js";
import { createDiscordInboundWorker } from "./inbound-worker.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  workerRunTimeoutMs?: number;
};

export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
};

type QueuedDiscordInboundDelivery = {
  data: DiscordMessageEvent;
  client: Client;
  abortSignal?: AbortSignal;
};

const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_DISCORD_MESSAGE_MAX = 5000;
const IN_FLIGHT_DISCORD_MESSAGE_MAX = 5000;
const PENDING_DUPLICATE_DELIVERY_MAX = 5000;

function buildDiscordInboundDedupeKey(params: {
  accountId: string;
  data: DiscordMessageEvent;
}): string | null {
  const messageId = params.data.message?.id?.trim();
  if (!messageId) {
    return null;
  }
  const channelId = resolveDiscordMessageChannelId({
    message: params.data.message,
    eventChannelId: params.data.channel_id,
  });
  if (!channelId) {
    return null;
  }
  return `${params.accountId}:${channelId}:${messageId}`;
}

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams,
): DiscordMessageHandlerWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const inboundWorker = createDiscordInboundWorker({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    runTimeoutMs: params.workerRunTimeoutMs,
  });
  const recentInboundMessages = createDedupeCache({
    ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
    maxSize: RECENT_DISCORD_MESSAGE_MAX,
  });
  const pendingDuplicateDeliveries = new Map<string, QueuedDiscordInboundDelivery>();
  const inFlightDedupeKeys = new Set<string>();
  let replayHandler: DiscordMessageHandler | null = null;
  const uniqueDedupeKeys = (keys: Array<string | null | undefined>) => [
    ...new Set(keys.filter((key): key is string => Boolean(key))),
  ];
  const releaseDedupeKeys = (keys: Array<string | null | undefined>) => {
    for (const key of keys) {
      recentInboundMessages.delete(key);
    }
  };
  const clearInFlightDedupeKeys = (keys: Array<string | null | undefined>) => {
    for (const key of keys) {
      if (key) {
        inFlightDedupeKeys.delete(key);
      }
    }
  };
  const clearPendingDuplicateDeliveries = (keys: Array<string | null | undefined>) => {
    for (const key of keys) {
      if (key) {
        pendingDuplicateDeliveries.delete(key);
      }
    }
  };
  const replayPendingDuplicateDeliveries = (keys: Array<string | null | undefined>) => {
    const retries = uniqueDedupeKeys(keys)
      .map((key) => {
        const retry = pendingDuplicateDeliveries.get(key);
        pendingDuplicateDeliveries.delete(key);
        return retry;
      })
      .filter((retry): retry is QueuedDiscordInboundDelivery => Boolean(retry));
    if (retries.length === 0) {
      return;
    }
    queueMicrotask(() => {
      for (const retry of retries) {
        void replayHandler?.(retry.data, retry.client, { abortSignal: retry.abortSignal });
      }
    });
  };
  const tryTrackInFlightDedupeKey = (key: string | null | undefined): boolean => {
    if (!key) {
      return false;
    }
    if (inFlightDedupeKeys.has(key)) {
      return true;
    }
    if (inFlightDedupeKeys.size >= IN_FLIGHT_DISCORD_MESSAGE_MAX) {
      return false;
    }
    inFlightDedupeKeys.add(key);
    return true;
  };
  const tryQueuePendingDuplicateDelivery = (
    key: string | null | undefined,
    delivery: QueuedDiscordInboundDelivery,
  ) => {
    if (!key) {
      return;
    }
    if (
      !pendingDuplicateDeliveries.has(key) &&
      pendingDuplicateDeliveries.size >= PENDING_DUPLICATE_DELIVERY_MAX
    ) {
      return;
    }
    pendingDuplicateDeliveries.set(key, delivery);
  };

  const { debouncer } = createChannelInboundDebouncer<{
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    dedupeKey?: string | null;
  }>({
    cfg: params.cfg,
    channel: "discord",
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message,
        eventChannelId: entry.data.channel_id,
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia: Boolean(
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
        ),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const dedupeKeys = uniqueDedupeKeys(entries.map((entry) => entry.dedupeKey));
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        clearInFlightDedupeKeys(dedupeKeys);
        releaseDedupeKeys(dedupeKeys);
        clearPendingDuplicateDeliveries(dedupeKeys);
        return;
      }
      if (entries.length === 1) {
        const ctx = await preflightDiscordMessage({
          ...params,
          ackReactionScope,
          groupPolicy,
          abortSignal,
          data: last.data,
          client: last.client,
        });
        if (!ctx) {
          clearInFlightDedupeKeys(dedupeKeys);
          releaseDedupeKeys(dedupeKeys);
          replayPendingDuplicateDeliveries(dedupeKeys);
          clearPendingDuplicateDeliveries(dedupeKeys);
          return;
        }
        inboundWorker.enqueue(buildDiscordInboundJob(ctx), {
          onDropped: () => {
            clearInFlightDedupeKeys(dedupeKeys);
            releaseDedupeKeys(dedupeKeys);
            clearPendingDuplicateDeliveries(dedupeKeys);
          },
          onTimeout: (settledAfterTimeout) => {
            void settledAfterTimeout.then((outcome) => {
              clearInFlightDedupeKeys(dedupeKeys);
              if (outcome === "success") {
                clearPendingDuplicateDeliveries(dedupeKeys);
                return;
              }
              releaseDedupeKeys(dedupeKeys);
              replayPendingDuplicateDeliveries(dedupeKeys);
            });
          },
          onSuccess: () => {
            clearInFlightDedupeKeys(dedupeKeys);
            clearPendingDuplicateDeliveries(dedupeKeys);
          },
          onError: () => {
            clearInFlightDedupeKeys(dedupeKeys);
            releaseDedupeKeys(dedupeKeys);
            replayPendingDuplicateDeliveries(dedupeKeys);
          },
        });
        return;
      }
      const combinedBaseText = entries
        .map((entry) => resolveDiscordMessageText(entry.data.message, { includeForwarded: false }))
        .filter(Boolean)
        .join("\n");
      const syntheticMessage = {
        ...last.data.message,
        content: combinedBaseText,
        attachments: [],
        message_snapshots: (last.data.message as { message_snapshots?: unknown }).message_snapshots,
        messageSnapshots: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
        rawData: {
          ...(last.data.message as { rawData?: Record<string, unknown> }).rawData,
        },
      };
      const syntheticData: DiscordMessageEvent = {
        ...last.data,
        message: syntheticMessage,
      };
      const ctx = await preflightDiscordMessage({
        ...params,
        ackReactionScope,
        groupPolicy,
        abortSignal,
        data: syntheticData,
        client: last.client,
      });
      if (!ctx) {
        clearInFlightDedupeKeys(dedupeKeys);
        releaseDedupeKeys(dedupeKeys);
        replayPendingDuplicateDeliveries(dedupeKeys);
        clearPendingDuplicateDeliveries(dedupeKeys);
        return;
      }
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.data.message?.id).filter(Boolean) as string[];
        if (ids.length > 0) {
          const ctxBatch = ctx as typeof ctx & {
            MessageSids?: string[];
            MessageSidFirst?: string;
            MessageSidLast?: string;
          };
          ctxBatch.MessageSids = ids;
          ctxBatch.MessageSidFirst = ids[0];
          ctxBatch.MessageSidLast = ids[ids.length - 1];
        }
      }
      inboundWorker.enqueue(buildDiscordInboundJob(ctx), {
        onDropped: () => {
          clearInFlightDedupeKeys(dedupeKeys);
          releaseDedupeKeys(dedupeKeys);
          clearPendingDuplicateDeliveries(dedupeKeys);
        },
        onTimeout: (settledAfterTimeout) => {
          void settledAfterTimeout.then((outcome) => {
            clearInFlightDedupeKeys(dedupeKeys);
            if (outcome === "success") {
              clearPendingDuplicateDeliveries(dedupeKeys);
              return;
            }
            releaseDedupeKeys(dedupeKeys);
            replayPendingDuplicateDeliveries(dedupeKeys);
          });
        },
        onSuccess: () => {
          clearInFlightDedupeKeys(dedupeKeys);
          clearPendingDuplicateDeliveries(dedupeKeys);
        },
        onError: () => {
          clearInFlightDedupeKeys(dedupeKeys);
          releaseDedupeKeys(dedupeKeys);
          replayPendingDuplicateDeliveries(dedupeKeys);
        },
      });
    },
    onError: (err, entries) => {
      const dedupeKeys = uniqueDedupeKeys(entries.map((entry) => entry.dedupeKey));
      clearInFlightDedupeKeys(dedupeKeys);
      releaseDedupeKeys(dedupeKeys);
      replayPendingDuplicateDeliveries(dedupeKeys);
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    },
  });

  const handler: DiscordMessageHandlerWithLifecycle = async (data, client, options) => {
    let dedupeKey: string | null = null;
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }
      dedupeKey = buildDiscordInboundDedupeKey({
        accountId: params.accountId,
        data,
      });
      if (dedupeKey && inFlightDedupeKeys.has(dedupeKey)) {
        tryQueuePendingDuplicateDelivery(dedupeKey, {
          data,
          client,
          abortSignal: options?.abortSignal,
        });
        return;
      }
      if (dedupeKey && recentInboundMessages.check(dedupeKey)) {
        return;
      }
      if (dedupeKey && !tryTrackInFlightDedupeKey(dedupeKey)) {
        recentInboundMessages.delete(dedupeKey);
        dedupeKey = null;
      }

      await debouncer.enqueue({
        data,
        client,
        abortSignal: options?.abortSignal,
        dedupeKey,
      });
    } catch (err) {
      clearInFlightDedupeKeys([dedupeKey]);
      releaseDedupeKeys([dedupeKey]);
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };

  replayHandler = handler;
  handler.deactivate = () => {
    pendingDuplicateDeliveries.clear();
    inFlightDedupeKeys.clear();
    recentInboundMessages.clear();
    inboundWorker.deactivate();
  };

  return handler;
}
