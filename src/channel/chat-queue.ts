/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Process-level chat task queue.
 *
 * Although located in channel/, this module is intentionally shared
 * across channel, messaging, tools, and card layers as a process-level
 * singleton. Consumers: monitor.ts, dispatch.ts, oauth.ts, auto-auth.ts.
 *
 * Ensures tasks targeting the same account+chat are executed serially.
 * Used by both websocket inbound messages and synthetic message paths.
 */

type QueueStatus = 'queued' | 'immediate';

export interface ActiveDispatcherEntry {
  abortCard: () => Promise<void>;
  abortController?: AbortController;
}

const chatQueues = new Map<string, Promise<void>>();
const activeDispatchers = new Map<string, ActiveDispatcherEntry>();

/**
 * Per-key yield resolvers.
 *
 * When a running task calls `yieldCurrentTask(key)`, the queue slot resolves
 * early so subsequent tasks can proceed — even though the current task
 * continues running in the background.  This is used by AskUserQuestion
 * to avoid blocking the entire group chat while waiting for user input.
 *
 * The resolver is registered when the task *starts executing* (not when
 * enqueued), so it always refers to the currently running task for that key.
 */
const taskYieldResolvers = new Map<string, () => void>();

/**
 * Append `:thread:{threadId}` suffix when threadId is present.
 * Consistent with the SDK's `:thread:` separator convention.
 */
export function threadScopedKey(base: string, threadId?: string): string {
  return threadId ? `${base}:thread:${threadId}` : base;
}

export function buildQueueKey(accountId: string, chatId: string, threadId?: string): string {
  return threadScopedKey(`${accountId}:${chatId}`, threadId);
}

export function registerActiveDispatcher(key: string, entry: ActiveDispatcherEntry): void {
  activeDispatchers.set(key, entry);
}

export function unregisterActiveDispatcher(key: string): void {
  activeDispatchers.delete(key);
}

export function getActiveDispatcher(key: string): ActiveDispatcherEntry | undefined {
  return activeDispatchers.get(key);
}

/** Check whether the queue has an active task for the given key. */
export function hasActiveTask(key: string): boolean {
  return chatQueues.has(key);
}

export function enqueueFeishuChatTask(params: {
  accountId: string;
  chatId: string;
  threadId?: string;
  task: () => Promise<void>;
}): { status: QueueStatus; promise: Promise<void> } {
  const { accountId, chatId, threadId, task } = params;
  const key = buildQueueKey(accountId, chatId, threadId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const status: QueueStatus = chatQueues.has(key) ? 'queued' : 'immediate';

  // Wrap task so we can register a per-execution yield resolver.
  // `yieldPromise` resolves when `yieldCurrentTask(key)` is called,
  // allowing the queue to advance while the task keeps running.
  let yieldResolve: () => void;
  const yieldPromise = new Promise<void>((resolve) => {
    yieldResolve = resolve;
  });

  const wrappedTask = async (): Promise<void> => {
    taskYieldResolvers.set(key, yieldResolve!);
    try {
      await task();
    } finally {
      // If task completes without yielding, clean up the resolver
      if (taskYieldResolvers.get(key) === yieldResolve!) {
        taskYieldResolvers.delete(key);
      }
      // Also resolve the yield promise so the queue slot cleans up
      yieldResolve!();
    }
  };

  const taskPromise = prev.then(wrappedTask, wrappedTask);

  // Queue slot resolves when either: task completes OR task yields
  const next = Promise.race([taskPromise, yieldPromise]);
  chatQueues.set(key, next);

  const cleanup = (): void => {
    if (chatQueues.get(key) === next) {
      chatQueues.delete(key);
    }
  };

  next.then(cleanup, cleanup);

  return { status, promise: taskPromise };
}

/**
 * Yield the current task's queue position for the given key.
 *
 * After yielding, subsequent tasks in the queue will proceed immediately
 * while the current task continues running in the background.
 *
 * Used by AskUserQuestion to avoid blocking other users in group chats
 * while waiting for a card-based response.
 */
export function yieldCurrentTask(accountId: string, chatId: string, threadId?: string): void {
  const key = buildQueueKey(accountId, chatId, threadId);
  const resolver = taskYieldResolvers.get(key);
  if (resolver) {
    resolver();
    taskYieldResolvers.delete(key);
  }
}

/** @internal Test-only: reset all queue and dispatcher state. */
export function _resetChatQueueState(): void {
  chatQueues.clear();
  activeDispatchers.clear();
  taskYieldResolvers.clear();
}
