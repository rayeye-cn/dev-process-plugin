#!/usr/bin/env node
/**
 * Look at a repository and propose init answers (the init skill shows the proposal and asks the user to confirm or
 * change it — nothing here is final).
 *
 *   node tools/detect.mjs --target <repo>            # local facts only (git, files)
 *   node tools/detect.mjs --target <repo> --remote   # plus GitHub facts through `gh` (visibility, plan, collaborators)
 *
 * Output (JSON on stdout): `{ facts, proposal }`. `proposal` has the answers shape (tools/answers.mjs) with the fields that
 * could be guessed; `facts` explains where the guesses came from and what already exists (CLAUDE.md, CODEOWNERS, …).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** `owner/name` from a GitHub remote URL (https or ssh), or null. */
export function repoFromRemote(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Host of a remote URL (for GHES / GitLab detection). */
export function hostOf(url) {
  const s = String(url ?? "").trim();
  return /^[a-z]+:\/\/([^/@]+@)?([^/:]+)/i.exec(s)?.[2] ?? /^[^@]+@([^:]+):/.exec(s)?.[1] ?? null;
}

/** Share of CJK characters among letters in a text sample (0..1). */
export function cjkShare(text) {
  const letters = String(text).match(/[\p{L}]/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /\p{Script=Han}/u.test(c)).length / letters.length;
}

const NODE_SKIP = /^(pre|post)|^(start|dev|serve|watch|preview|release|publish|deploy|prepare|clean)(:|$)/;

/** CI proposal for a Node project from package.json scripts and the lock file. */
export function nodeCi(pkg, files) {
  const pm = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : files.has("bun.lockb") || files.has("bun.lock") ? "bun" : "npm";
  const install = { npm: files.has("package-lock.json") ? "npm ci" : "npm install", pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile", bun: "bun install --frozen-lockfile" }[pm];
  const run = (s) => (pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
  const scripts = pkg?.scripts ?? {};
  const names = Object.keys(scripts).filter((s) => !NODE_SKIP.test(s));
  const checks = names.filter((s) => /^(typecheck|type-check|types|tsc|lint|lint:[\w-]+|format:check|fmt:check|check|check:[\w-]+)$/.test(s)).map((s) => ({ name: s, run: run(s) }));
  const realTest = scripts.test && !/no test specified/.test(scripts.test);
  const tests = realTest ? [{ name: "test", run: pm === "npm" ? "npm test" : `${pm} test` }] : [];
  const setup = [
    ...(pm === "pnpm" ? [{ uses: "pnpm/action-setup@v4" }] : []),
    ...(pm === "bun" ? [{ uses: "oven-sh/setup-bun@v2" }] : [{ uses: "actions/setup-node@v4", with: { "node-version": 24, cache: pm } }]),
    { run: install },
  ];
  return { setup, checks, tests, releaseFiles: [{ file: "package.json", field: "version" }] };
}

export function pythonCi(files, text) {
  const uv = files.has("uv.lock");
  const setup = [{ uses: "actions/setup-python@v5", with: { "python-version": "3.12" } }, { run: uv ? "pip install uv && uv sync" : files.has("requirements.txt") ? "pip install -r requirements.txt" : "pip install -e ." }];
  const x = (cmd) => (uv ? `uv run ${cmd}` : cmd);
  const checks = [];
  if (/\[tool\.ruff/.test(text) || files.has("ruff.toml") || files.has(".ruff.toml")) checks.push({ name: "ruff", run: x("ruff check .") });
  if (/\[tool\.mypy/.test(text) || files.has("mypy.ini")) checks.push({ name: "mypy", run: x("mypy .") });
  const tests = /pytest/.test(text) || files.has("pytest.ini") || files.has("tests") ? [{ name: "pytest", run: x("pytest") }] : [];
  return { setup, checks, tests, releaseFiles: [] };
}

export const goCi = () => ({
  setup: [{ uses: "actions/setup-go@v5", with: { "go-version": "stable" } }],
  checks: [{ name: "vet", run: "go vet ./..." }, { name: "gofmt", run: 'test -z "$(gofmt -l .)"' }],
  tests: [{ name: "test", run: "go test ./..." }],
  releaseFiles: [],
});

export const rustCi = () => ({
  setup: [{ uses: "dtolnay/rust-toolchain@stable", with: { components: "rustfmt, clippy" } }],
  checks: [{ name: "fmt", run: "cargo fmt --all --check" }, { name: "clippy", run: "cargo clippy --all-targets -- -D warnings" }],
  tests: [{ name: "test", run: "cargo test" }],
  releaseFiles: [],
});

const RISKY_DIR = /^(auth|authn|authz|security|crypto|permissions?|acl|payments?|billing|secrets?|migrations?|db\/migrations|infra|terraform|deploy|deployment|k8s|helm)$/i;
const SECURITY_DIR = /^(auth|authn|authz|security|crypto|permissions?|acl|payments?|billing|secrets?)$/i;
const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Dockerfile"];
const AGENT_FILES = new Set(["CLAUDE.md", "AGENTS.md"]);

/** Directories up to depth 2 (skipping vendored/build dirs), as posix paths. */
function dirsOf(root) {
  const skip = new Set([".git", "node_modules", "dist", "build", "target", "vendor", ".venv", "venv", "__pycache__", ".next", "coverage"]);
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 2) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      walk(join(dir, e.name), r, depth + 1);
    }
  };
  walk(root, "", 1);
  return out;
}

export function detectLocal(target) {
  const root = resolve(target);
  const files = new Set(readdirSync(root));
  const remoteUrl = git(root, ["remote", "get-url", "origin"]);
  const host = hostOf(remoteUrl);
  // Only github.com is certain from a host name; a self-managed GitLab or a GHES host can be called anything.
  const forge = !host || host === "github.com" ? "github" : /gitlab/i.test(host) ? "gitlab" : "unknown";
  const head = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = head ? head.replace(/^origin\//, "") : git(root, ["branch", "--show-current"]) || "main";
  const pkg = readJson(join(root, "package.json"));
  const pyText = readText(join(root, "pyproject.toml"));

  const stack = [];
  const cis = [];
  const add = (name, proposal) => {
    stack.push(name);
    cis.push(proposal);
  };
  if (pkg) add("node", nodeCi(pkg, files));
  if (pyText || files.has("requirements.txt")) add("python", pythonCi(files, pyText + readText(join(root, "requirements.txt"))));
  if (files.has("go.mod")) add("go", goCi());
  if (files.has("Cargo.toml")) add("rust", rustCi());
  const ci = { setup: cis.flatMap((c) => c.setup), checks: cis.flatMap((c) => c.checks), tests: cis.flatMap((c) => c.tests) };

  const dirs = dirsOf(root);
  const risky = dirs.filter((d) => RISKY_DIR.test(d.split("/").at(-1))).map((d) => `${d}/**`);
  const security = dirs.filter((d) => SECURITY_DIR.test(d.split("/").at(-1))).map((d) => `${d}/**`);
  const rootDocs = [...files].filter((f) => /\.(md|mdx|txt|rst)$/i.test(f) && !AGENT_FILES.has(f) && statSync(join(root, f)).isFile());
  const lowOnly = [...(files.has("docs") ? ["docs/**"] : []), ...rootDocs.sort()];

  const sample = [readText(join(root, "README.md")), git(root, ["log", "-50", "--format=%s"]) ?? ""].join("\n");
  const language = cjkShare(sample) > 0.2 ? "zh" : "en";
  const authors = (git(root, ["shortlog", "-sne", "--all", "--no-merges"]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => /^\s*(\d+)\s+(.+?)\s+<([^>]+)>$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ commits: Number(m[1]), name: m[2], email: m[3] }))
    .slice(0, 10);

  const workflowsDir = join(root, ".github", "workflows");
  return {
    facts: {
      remoteUrl,
      host,
      stack,
      language,
      authors,
      existing: {
        claudeMd: files.has("CLAUDE.md"),
        agentsMd: files.has("AGENTS.md"),
        codeowners: [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].filter((p) => existsSync(join(root, p))),
        prTemplate: existsSync(join(root, ".github", "pull_request_template.md")),
        workflows: existsSync(workflowsDir) ? readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)) : [],
        devProcess: existsSync(join(root, ".dev-process", "answers.json")),
      },
    },
    proposal: {
      version: 1,
      forge,
      language,
      project: { name: pkg?.name ?? basename(root), description: pkg?.description ?? "" },
      repo: repoFromRemote(remoteUrl),
      defaultBranch,
      paths: { high: [...new Set([...risky, ...MANIFESTS.filter((m) => files.has(m))])], security: [...new Set([...security, ".github/**"])], lowOnly },
      ci: { ...ci, testsRunner: "hosted" },
      release: { label: "release", versionFiles: cis.flatMap((c) => c.releaseFiles) },
    },
  };
}

const gh = (args) => {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
};

/**
 * GitHub facts through `gh`: visibility, owner type and plan (native merge queue: public org repos, Enterprise Cloud
 * private repos, GHES org repos), and collaborators with write access (trusted-author candidates).
 */
export function detectRemote(repo) {
  const r = gh(["api", `repos/${repo}`]);
  if (!r) return { reachable: false };
  const org = r.owner?.type === "Organization" ? gh(["api", `orgs/${r.owner.login}`]) : null;
  const plan = org?.plan?.name ?? null;
  const nativeQueue = r.owner?.type === "Organization" && (r.visibility === "public" || /enterprise/i.test(plan ?? ""));
  const collaborators = (gh(["api", `repos/${repo}/collaborators?per_page=100`]) ?? [])
    .filter((c) => c.permissions?.push || c.permissions?.maintain || c.permissions?.admin)
    .filter((c) => c.type !== "Bot")
    .map((c) => c.login);
  return { reachable: true, visibility: r.visibility, ownerType: r.owner?.type, plan, nativeQueue, defaultBranch: r.default_branch, collaborators };
}

function main() {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf("--target");
  const target = ti >= 0 ? argv[ti + 1] : ".";
  const out = detectLocal(target);
  if (argv.includes("--remote") && out.proposal.repo && out.proposal.forge === "github") {
    const remote = detectRemote(out.proposal.repo);
    out.facts.remote = remote;
    if (remote.reachable) {
      out.proposal.defaultBranch = remote.defaultBranch ?? out.proposal.defaultBranch;
      // The native queue is reported in facts.remote.nativeQueue but not proposed until this version supports it.
      out.proposal.queue = { mode: "self" };
      out.proposal.people = { trustedAuthors: remote.collaborators };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
