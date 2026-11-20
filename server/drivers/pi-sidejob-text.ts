import type {
  RuntimeEventListener,
  SendTurnInput,
  TextGenerationOptions,
} from "../contracts.ts";
import { newId } from "../contracts.ts";

interface SidejobSession {
  stop: () => Promise<void>;
}

export interface SidejobTextDeps {
  sendTurn: (turn: SendTurnInput) => Promise<unknown>;
  active: Map<string, SidejobSession>;
  listeners: Set<RuntimeEventListener>;
  defaultModel?: string;
}

/** A one-off text call is a turn the tool scope itself strips bare: {allow: []} denies every
 * native and MCP tool through the same extension gate a person's scope choice uses, so the
 * model can only write. Each call gets its own thread key — a fresh child, never a warm
 * session that could still hold an earlier conversation. */
export function createSidejobText(deps: SidejobTextDeps) {
  return async function generateText(prompt: string, options: TextGenerationOptions = {}): Promise<string> {
    const threadId = `pi-sidejob-${newId()}`;
    const parts: string[] = [];
    let usage: { input: number; output: number; cachedInput?: number } | undefined;
    let seenModel: string | undefined;
    let settle: (result: { ok: boolean; reason?: string }) => void = () => {};
    const completed = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      settle = resolve;
    });
    const listen: RuntimeEventListener = (event) => {
      if (event.threadId !== threadId) return;
      if (event.type === "item.completed" && event.itemType === "assistant_text") {
        if (event.text.trim()) parts.push(event.text);
      } else if (event.type === "session.started" && typeof event.model === "string" && event.model) {
        seenModel = event.model;
      } else if (event.type === "turn.completed") {
        usage = event.usage;
        settle({ ok: event.ok, reason: event.stopReason ?? undefined });
      } else if (event.type === "runtime.error") {
        settle({ ok: false, reason: event.message });
      }
    };
    deps.listeners.add(listen);
    void completed.finally(() => deps.listeners.delete(listen));
    const timedOut = new Promise<never>((_, reject) => {
      const deadline = options.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        void deps.active.get(threadId)?.stop().finally(() => reject(new Error(`pi text call timed out after ${deadline}ms`)));
      }, deadline);
      timer.unref?.();
      void completed.finally(() => clearTimeout(timer));
    });
    const cancelled = options.signal
      ? new Promise<never>((_, reject) => {
          const onAbort = () => {
            void deps.active.get(threadId)?.stop().finally(() => reject(new Error("pi text call cancelled")));
          };
          options.signal!.addEventListener("abort", onAbort, { once: true });
          void completed.finally(() => options.signal!.removeEventListener("abort", onAbort));
        })
      : null;
    try {
      await deps.sendTurn({
        threadId,
        text: prompt,
        toolScope: { allow: [] },
        approvalMode: "ask",
        ...(options.model ? { model: options.model } : {}),
      });
      const raced = [completed, timedOut, ...(cancelled ? [cancelled] : [])] as const;
      const result = await Promise.race(raced);
      if (!result.ok) throw new Error(result.reason ?? "pi text call failed");
      const model = seenModel ?? options.model ?? deps.defaultModel ?? "pi";
      options.onUsage?.({ model, input: usage?.input, output: usage?.output, ...(usage?.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}) });
      return parts.join("\n");
    } finally {
      // A dispatch that rejected left no turn behind; one that reached the prompt ends on its own event.
      void deps.active.get(threadId)?.stop().catch(() => {});
    }
  };
}
