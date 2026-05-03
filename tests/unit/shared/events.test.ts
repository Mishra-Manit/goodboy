import { describe, it, expect, vi, afterEach } from "vitest";
import { subscribe, emit } from "@src/shared/runtime/events.js";

// `listeners` is module-level state shared across every test. Track every
// subscription here so afterEach can flush them even when an assertion throws
// before the manual unsub call.
const unsubs: Array<() => void> = [];

afterEach(() => {
  unsubs.forEach((fn) => fn());
  unsubs.length = 0;
});

function track(listener: Parameters<typeof subscribe>[0]): () => void {
  const unsub = subscribe(listener);
  unsubs.push(unsub);
  return unsub;
}

describe("events", () => {
  it("emit fans out to all subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    track(a);
    track(b);
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("unsubscribe stops further delivery", () => {
    const listener = vi.fn();
    const unsub = track(listener);
    unsub();
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("a throwing listener does not break siblings", () => {
    const thrower = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    track(thrower);
    track(ok);
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(thrower).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
  });

  it("unsubscribe is idempotent", () => {
    const listener = vi.fn();
    const unsub = track(listener);
    unsub();
    unsub();
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("passes the emitted event unchanged to listeners", () => {
    const listener = vi.fn();
    track(listener);
    const event = { type: "task_update", taskId: "t-42", status: "complete" } as const;
    emit(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("accepts variant metadata on task-scoped stage and session events", () => {
    const listener = vi.fn();
    track(listener);
    emit({ type: "stage_update", taskId: "t", stage: "pr_impact", variant: 2, status: "running" });
    emit({
      type: "session_entry",
      scope: "task",
      id: "t",
      stage: "pr_impact",
      variant: 2,
      entry: { type: "session", id: "s", version: 3, timestamp: "now", cwd: "/" },
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
