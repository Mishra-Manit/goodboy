import path from "node:path";
import { describe, expect, it } from "vitest";
import { artifactPath } from "@src/shared/artifact-paths/index.js";

describe("artifact helpers", () => {
  it("builds artifact paths inside the given artifacts dir", () => {
    expect(artifactPath("/tmp/task-1", "plan.md")).toBe(path.join("/tmp/task-1", "plan.md"));
  });
});
