import { describe, it, expect, vi } from "vitest";
import { subscribe, emit } from "@src/shared/events.js";

describe("events", () => {
  it("emit fans out to all subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribe(a);
    const unsubB = subscribe(b);
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    unsubA();
    unsubB();
  });

  it("unsubscribe stops further delivery", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    unsub();
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("a throwing listener does not break siblings", () => {
    const thrower = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    const u1 = subscribe(thrower);
    const u2 = subscribe(ok);
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(thrower).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
    u1();
    u2();
  });

  it("unsubscribe is idempotent", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    unsub();
    unsub();
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("passes the emitted event unchanged to listeners", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    const event = { type: "task_update", taskId: "t-42", status: "complete" } as const;
    emit(event);
    expect(listener).toHaveBeenCalledWith(event);
    unsub();
  });
});
