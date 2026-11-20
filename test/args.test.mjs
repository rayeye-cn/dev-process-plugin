// CLI plumbing: which repository a command run by hand talks to.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubRepoFromUrl, repoName } from "../engine/cli/args.mjs";

describe("repository name", () => {
  it("reads owner/name from the usual github.com remote URLs, nothing from other hosts", () => {
    for (const url of ["https://github.com/o/r.git", "https://github.com/o/r", "https://x-access-token:t@github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "git@github.com:o/r.git\n"]) {
      assert.equal(githubRepoFromUrl(url), "o/r", url);
    }
    for (const url of ["", "git@gitlab.example.com:o/r.git", "https://github.example.com/o/r.git", "https://github.com/o"]) assert.equal(githubRepoFromUrl(url), null, url);
  });

  it("--repo, then GITHUB_REPOSITORY, then the origin remote; otherwise a message that says to pass --repo", () => {
    const origin = () => "git@github.com:from/origin.git";
    assert.equal(repoName({ repo: "a/b" }, "/w", { GITHUB_REPOSITORY: "c/d" }, origin), "a/b");
    assert.equal(repoName({}, "/w", { GITHUB_REPOSITORY: "c/d" }, origin), "c/d");
    assert.equal(repoName({ repo: true }, "/w", {}, origin), "from/origin");
    assert.throws(() => repoName({}, "/w", {}, () => ""), /--repo <owner>\/<name>/);
  });
});
