import { describe, it, expect, vi, beforeEach } from "vitest";

// Plain-handler mocks (vi.fn spy pattern warns on rejected promises in
// vitest 4; see vitest-dev/vitest#9024).
const { pipelineHandlers, queriesHandler, stageHandler } = vi.hoisted(() => ({
  pipelineHandlers: {
    runPipeline: { calls: [] as unknown[][], impl: async () => undefined },
    runQuestion: { calls: [] as unknown[][], impl: async () => undefined },
    runPrReview: { calls: [] as unknown[][], impl: async () => undefined },
  },
  queriesHandler: {
    createTask: {
      calls: [] as unknown[][],
      impl: async (data: Record<string, unknown>) => ({
        id: "abcd1234-0000-4000-8000-000000000000",
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        ...data,
      }),
    },
    listTasks: {
      calls: [] as unknown[][],
      impl: async (): Promise<unknown[]> => [],
    },
    updateTask: {
      calls: [] as unknown[][],
      impl: async (_id: string, _data: unknown) => undefined,
    },
    createRetryTask: {
      calls: [] as unknown[][],
      impl: async (source: Record<string, unknown>) => ({
        ...source,
        id: "dcba4321-0000-4000-8000-000000000000",
        status: "queued",
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    },
  },
  stageHandler: {
    cancelTask: { calls: [] as unknown[][], returns: true as boolean },
  },
}));

vi.mock("@src/pipelines/coding/pipeline.js", () => ({
  runPipeline: (...args: unknown[]) => {
    pipelineHandlers.runPipeline.calls.push(args);
    return pipelineHandlers.runPipeline.impl();
  },
}));
vi.mock("@src/pipelines/question/pipeline.js", () => ({
  runQuestion: (...args: unknown[]) => {
    pipelineHandlers.runQuestion.calls.push(args);
    return pipelineHandlers.runQuestion.impl();
  },
}));
vi.mock("@src/pipelines/pr-review/pipeline.js", () => ({
  runPrReview: (...args: unknown[]) => {
    pipelineHandlers.runPrReview.calls.push(args);
    return pipelineHandlers.runPrReview.impl();
  },
}));
vi.mock("@src/core/stage.js", () => ({
  cancelTask: (...args: unknown[]) => {
    stageHandler.cancelTask.calls.push(args);
    return stageHandler.cancelTask.returns;
  },
}));
vi.mock("@src/db/repository.js", () => ({
  createTask: (data: Record<string, unknown>) => {
    queriesHandler.createTask.calls.push([data]);
    return queriesHandler.createTask.impl(data);
  },
  listTasks: (...args: unknown[]) => {
    queriesHandler.listTasks.calls.push(args);
    return queriesHandler.listTasks.impl();
  },
  updateTask: (id: string, data: unknown) => {
    queriesHandler.updateTask.calls.push([id, data]);
    return queriesHandler.updateTask.impl(id, data);
  },
  createRetryTask: (source: Record<string, unknown>) => {
    queriesHandler.createRetryTask.calls.push([source]);
    return queriesHandler.createRetryTask.impl(source);
  },
}));

import { handleIntent } from "@src/telegram/handlers.js";

interface FakeCtx {
  chatId: string;
  /** Required by the real Ctx interface; verified to be threaded into pipeline calls. */
  sendTelegram: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

function makeCtx(): FakeCtx {
  return {
    chatId: "1",
    sendTelegram: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

function mkTask(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "abcd1234-0000-4000-8000-000000000000",
    repo: "myrepo",
    kind: "coding_task",
    status: "queued",
    description: "do the thing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    telegramChatId: "1",
    prNumber: null,
    prUrl: null,
    branch: null,
    worktreePath: null,
    error: null,
    instance: "test",
    prIdentifier: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const h of Object.values(pipelineHandlers)) {
    h.calls.length = 0;
    h.impl = async () => undefined;
  }
  for (const h of Object.values(queriesHandler)) {
    h.calls.length = 0;
  }
  queriesHandler.createTask.impl = async (data) => ({
    id: "abcd1234-0000-4000-8000-000000000000",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    ...data,
  });
  queriesHandler.listTasks.impl = async () => [];
  queriesHandler.updateTask.impl = async () => undefined;
  queriesHandler.createRetryTask.impl = async (source) => ({
    ...source,
    id: "dcba4321-0000-4000-8000-000000000000",
    status: "queued",
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  stageHandler.cancelTask.calls.length = 0;
  stageHandler.cancelTask.returns = true;
});

describe("handleIntent — coding_task", () => {
  it("creates a task and kicks off the coding pipeline", async () => {
    const ctx = makeCtx();
    await handleIntent(
      { type: "coding_task", repo: "myrepo", description: "add dark mode" },
      ctx,
    );
    expect(queriesHandler.createTask.calls).toHaveLength(1);
    expect(pipelineHandlers.runPipeline.calls).toHaveLength(1);
    // First arg is the task id; second is ctx.sendTelegram.
    expect(pipelineHandlers.runPipeline.calls[0][0]).toBe(
      "abcd1234-0000-4000-8000-000000000000",
    );
    expect(pipelineHandlers.runPipeline.calls[0][1]).toBe(ctx.sendTelegram);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Task created"));
  });

  it("replies with the repo list when the repo is not registered", async () => {
    const ctx = makeCtx();
    await handleIntent(
      { type: "coding_task", repo: "nope", description: "x" },
      ctx,
    );
    expect(queriesHandler.createTask.calls).toHaveLength(0);
    expect(pipelineHandlers.runPipeline.calls).toHaveLength(0);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });
});

describe("handleIntent — codebase_question", () => {
  it("routes to runQuestion with the question as the task description", async () => {
    const ctx = makeCtx();
    await handleIntent(
      { type: "codebase_question", repo: "myrepo", question: "what does X do" },
      ctx,
    );
    expect(pipelineHandlers.runQuestion.calls).toHaveLength(1);
    const createArg = queriesHandler.createTask.calls[0][0] as { kind: string; description: string };
    expect(createArg.kind).toBe("codebase_question");
    expect(createArg.description).toBe("what does X do");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Question received"));
  });
});

describe("handleIntent — pr_review", () => {
  it("creates a pr_review task and dispatches to runPrReview", async () => {
    const ctx = makeCtx();
    await handleIntent(
      { type: "pr_review", repo: "myrepo", prIdentifier: "#1" },
      ctx,
    );
    expect(queriesHandler.createTask.calls).toHaveLength(1);
    const createArg = queriesHandler.createTask.calls[0][0] as {
      kind: string; description: string; prIdentifier?: string;
    };
    expect(createArg.kind).toBe("pr_review");
    expect(createArg.description).toBe("#1");
    expect(createArg.prIdentifier).toBe("#1");
    expect(pipelineHandlers.runPrReview.calls).toHaveLength(1);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("PR review queued"));
  });
});

describe("handleIntent — task_status", () => {
  it("replies 'No active tasks' when nothing is running", async () => {
    queriesHandler.listTasks.impl = async () => [];
    const ctx = makeCtx();
    await handleIntent({ type: "task_status" }, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No active tasks"));
  });

  it("lists only non-terminal tasks", async () => {
    queriesHandler.listTasks.impl = async () => [
      mkTask({ id: "aaaaaaaa-0000-0000-0000-000000000000", status: "running", description: "live" }),
      mkTask({ id: "bbbbbbbb-0000-0000-0000-000000000000", status: "complete", description: "done" }),
    ];
    const ctx = makeCtx();
    await handleIntent({ type: "task_status" }, ctx);
    const text = (ctx.reply.mock.calls[0][0] as string);
    expect(text).toContain("aaaaaaaa");
    expect(text).not.toContain("bbbbbbbb");
  });

  it("shows a specific task when a prefix is given", async () => {
    queriesHandler.listTasks.impl = async () => [
      mkTask({ id: "abcd1234-0000-4000-8000-000000000000", status: "complete" }),
    ];
    const ctx = makeCtx();
    await handleIntent({ type: "task_status", taskPrefix: "abcd1234" }, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("abcd1234"));
  });

  it("reports task-not-found", async () => {
    queriesHandler.listTasks.impl = async () => [];
    const ctx = makeCtx();
    await handleIntent({ type: "task_status", taskPrefix: "zzzz" }, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });
});

describe("handleIntent — task_cancel", () => {
  it("calls cancelTask and marks the task cancelled", async () => {
    queriesHandler.listTasks.impl = async () => [
      mkTask({ id: "abcd1234-0000-4000-8000-000000000000", status: "running" }),
    ];
    const ctx = makeCtx();
    await handleIntent({ type: "task_cancel", taskPrefix: "abcd1234" }, ctx);
    expect(stageHandler.cancelTask.calls[0][0]).toBe(
      "abcd1234-0000-4000-8000-000000000000",
    );
    const update = queriesHandler.updateTask.calls[0];
    expect(update[0]).toBe("abcd1234-0000-4000-8000-000000000000");
    expect(update[1]).toEqual({ status: "cancelled" });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Cancelled"));
  });

  it("replies with ambiguity when the prefix matches multiple tasks", async () => {
    queriesHandler.listTasks.impl = async () => [
      mkTask({ id: "abcd1234-aaaa-4000-8000-000000000000" }),
      mkTask({ id: "abcd1234-bbbb-4000-8000-000000000000" }),
    ];
    const ctx = makeCtx();
    await handleIntent({ type: "task_cancel", taskPrefix: "abcd1234" }, ctx);
    expect(stageHandler.cancelTask.calls).toHaveLength(0);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/[Aa]mbiguous/));
  });
});

describe("handleIntent — task_retry", () => {
  it("creates a fresh retry task and starts the pipeline", async () => {
    const failedTask = mkTask({ id: "abcd1234-0000-4000-8000-000000000000", status: "failed" });
    queriesHandler.listTasks.impl = async () => [failedTask];
    const ctx = makeCtx();
    await handleIntent({ type: "task_retry", taskPrefix: "abcd1234" }, ctx);
    expect(queriesHandler.createRetryTask.calls[0][0]).toBe(failedTask);
    expect(queriesHandler.updateTask.calls).toHaveLength(0);
    expect(pipelineHandlers.runPipeline.calls).toHaveLength(1);
    expect(pipelineHandlers.runPipeline.calls[0][0]).toBe("dcba4321-0000-4000-8000-000000000000");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("as dcba4321"));
  });

  it("refuses to retry a running task", async () => {
    queriesHandler.listTasks.impl = async () => [
      mkTask({ id: "abcd1234-0000-4000-8000-000000000000", status: "running" }),
    ];
    const ctx = makeCtx();
    await handleIntent({ type: "task_retry", taskPrefix: "abcd1234" }, ctx);
    expect(pipelineHandlers.runPipeline.calls).toHaveLength(0);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not in failed state"));
  });
});

describe("handleIntent — unknown", () => {
  it("replies with the fallback message", async () => {
    const ctx = makeCtx();
    await handleIntent({ type: "unknown", rawText: "lol" }, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("didn't understand"));
  });
});
