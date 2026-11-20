/** Shared CLI plumbing: `--key value` / `--flag` arguments, repository root and name, "run if main". */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `--key value` / `--flag`; positionals in `_`. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * Repository root: `DEV_PROCESS_ROOT`, else three levels above the engine CLI
 * (`<root>/.dev-process/engine/cli/x.mjs`). Not in GitLab CI: pipeline variables can override any variable, and the root
 * decides which configuration (and so which gate) the bot's jobs use.
 */
export function repoRoot(env = process.env, cliUrl = import.meta.url) {
  const here = resolve(fileURLToPath(cliUrl), "..", "..", "..", "..");
  return env.DEV_PROCESS_ROOT && env.GITLAB_CI !== "true" ? resolve(env.DEV_PROCESS_ROOT) : here;
}

/** `owner/name` from a github.com remote URL (https, ssh, scp-like), or null. */
export function githubRepoFromUrl(url) {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The repository `owner/name`: `--repo`, else GITHUB_REPOSITORY / CI_PROJECT_PATH (set in CI), else the github.com
 * `origin` remote of the checkout, so commands run by hand in the repository need no `--repo`.
 */
export function repoName(args, root, env = process.env, originUrl = defaultOrigin) {
  if (typeof args.repo === "string") return args.repo;
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  if (env.CI_PROJECT_PATH) return env.CI_PROJECT_PATH; // GitLab CI
  const found = githubRepoFromUrl(originUrl(root));
  if (found) return found;
  throw new Error("which repository? pass --repo <owner>/<name> (no github.com origin remote here, and GITHUB_REPOSITORY is not set)");
}

function defaultOrigin(root) {
  try {
    return execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** Run `main` when the module is the entry point; print the error and exit 1 on failure. */
export function runIfMain(metaUrl, name, main) {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl)) {
    main().catch((e) => {
      console.error(`[${name}] ${e.stack || e.message}`);
      process.exitCode = 1;
    });
  }
}
