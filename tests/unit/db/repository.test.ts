import { beforeEach, describe, expect, it, vi } from "vitest";

interface DbCall {
  table?: unknown;
  data?: unknown;
  where?: unknown;
  selection?: unknown;
}

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  insertRows: [] as unknown[][],
  updateRows: [] as unknown[][],
  selects: [] as DbCall[],
  inserts: [] as DbCall[],
  updates: [] as DbCall[],
}));

function nextRows(queue: unknown[][]): unknown[] {
  return queue.shift() ?? [];
}

function terminal(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: () => promise,
    orderBy: () => promise,
    returning: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function makeDb() {
  return {
    select: (selection?: unknown) => ({
      from: (table: unknown) => {
        const call: DbCall = { table, selection };
        state.selects.push(call);
        return {
          where: (where: unknown) => {
            call.where = where;
            return terminal(nextRows(state.selectRows));
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (data: unknown) => {
        const call: DbCall = { table, data };
        state.inserts.push(call);
        return terminal(nextRows(state.insertRows));
      },
    }),
    update: (table: unknown) => ({
      set: (data: unknown) => ({
        where: (where: unknown) => {
          const call: DbCall = { table, data, where };
          state.updates.push(call);
          return terminal(nextRows(state.updateRows));
        },
      }),
    }),
    transaction: async (callback: (tx: ReturnType<typeof makeDb>) => Promise<unknown>) => callback(makeDb()),
  };
}

vi.mock("@src/db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/db/index.js")>();
  return {
    ...actual,
    getDb: () => makeDb(),
  };
});

function collectColumnNames(value: unknown, seen = new WeakSet<object>()): Set<string> {
  if (!value || typeof value !== "object" || seen.has(value)) return new Set();
  seen.add(value);

  const found = new Set<string>();
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && typeof record.columnType === "string") {
    found.add(record.name);
  }

  for (const child of Object.values(record)) {
    for (const name of collectColumnNames(child, seen)) found.add(name);
  }

  return found;
}

function expectInstanceScoped(where: unknown): void {
  expect(Array.from(collectColumnNames(where))).toContain("instance");
}

beforeEach(() => {
  state.selectRows = [];
  state.insertRows = [];
  state.updateRows = [];
  state.selects = [];
  state.inserts = [];
  state.updates = [];
});

describe("repository instance scoping", () => {
  it("scopes task row reads and writes by instance", async () => {
    const repo = await import("@src/db/repository.js");
    state.selectRows.push([{ id: "task-1" }]);
    state.updateRows.push([{ id: "task-1" }]);

    await repo.getTask("task-1");
    await repo.updateTask("task-1", { status: "running" });

    expectInstanceScoped(state.selects[0]?.where);
    expectInstanceScoped(state.updates[0]?.where);
  });

  it("scopes PR session row reads, writes, and run reads through the parent session", async () => {
    const repo = await import("@src/db/repository.js");
    state.selectRows.push([{ id: "session-1" }], []);
    state.updateRows.push([{ id: "session-1" }]);

    await repo.getPrSession("session-1");
    await repo.updatePrSession("session-1", { watchStatus: "muted" });
    await repo.getRunsForPrSession("session-1");

    expectInstanceScoped(state.selects[0]?.where);
    expectInstanceScoped(state.updates[0]?.where);
    expect(Array.from(collectColumnNames(state.selects[1]?.where))).toContain("pr_session_id");
  });

  it("atomically creates a PR session and clears task git ownership", async () => {
    const repo = await import("@src/db/repository.js");
    state.insertRows.push([{ id: "session-1" }]);
    state.updateRows.push([{ id: "task-1" }]);

    const session = await repo.createPrSessionAndTransferTaskOwnership({
      repo: "goodboy",
      branch: "fix/x",
      worktreePath: "/tmp/wt",
      mode: "review",
      sourceTaskId: "task-1",
      telegramChatId: null,
    });

    expect(session).toEqual({ id: "session-1" });
    expect(state.inserts[0]?.data).toMatchObject({ instance: "test", sourceTaskId: "task-1" });
    expect(state.updates[0]?.data).toMatchObject({ branch: null, worktreePath: null });
    expectInstanceScoped(state.updates[0]?.where);
  });

  it("rejects PR session ownership transfer when the source task is outside this instance", async () => {
    const repo = await import("@src/db/repository.js");
    state.insertRows.push([{ id: "session-1" }]);
    state.updateRows.push([]);

    await expect(repo.createPrSessionAndTransferTaskOwnership({
      repo: "goodboy",
      branch: "fix/x",
      worktreePath: "/tmp/wt",
      mode: "review",
      sourceTaskId: "other-instance-task",
      telegramChatId: null,
    })).rejects.toThrow(/not found for this instance/);
  });
});
