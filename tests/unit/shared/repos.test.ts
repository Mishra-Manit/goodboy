import { describe, it, expect } from "vitest";
import { getRepo, listRepoNames, listRepos, getRepoNwo, buildPrUrl } from "@src/shared/repos.js";

// `tests/setup/env.ts` seeds REGISTERED_REPOS with "myrepo" and "other".

describe("listRepoNames", () => {
  it("returns every registered name", () => {
    expect(listRepoNames().slice().sort()).toEqual(["myrepo", "other"]);
  });
});

describe("listRepos", () => {
  it("returns each entry with its name", () => {
    const byName = Object.fromEntries(listRepos().map((r) => [r.name, r]));
    expect(byName.myrepo.localPath).toBe("/tmp/myrepo");
    expect(byName.other.githubUrl).toBe("https://github.com/test/other.git");
  });
});

describe("getRepo", () => {
  it("returns the entry with its name", () => {
    expect(getRepo("myrepo")).toMatchObject({
      name: "myrepo",
      localPath: "/tmp/myrepo",
      githubUrl: "https://github.com/test/myrepo",
    });
  });
  it("returns null for unknown", () => {
    expect(getRepo("nope")).toBeNull();
  });
});

describe("getRepoNwo", () => {
  it("parses nwo from githubUrl", () => {
    expect(getRepoNwo("myrepo")).toBe("test/myrepo");
    expect(getRepoNwo("other")).toBe("test/other");
  });
  it("returns null for unknown repo", () => {
    expect(getRepoNwo("nope")).toBeNull();
  });
});

describe("buildPrUrl", () => {
  it("composes owner/repo/pull/N", () => {
    expect(buildPrUrl("myrepo", 42)).toBe("https://github.com/test/myrepo/pull/42");
  });
  it("returns null for null prNumber", () => {
    expect(buildPrUrl("myrepo", null)).toBeNull();
  });
  it("returns null for unknown repo", () => {
    expect(buildPrUrl("nope", 1)).toBeNull();
  });
});
