/** Shared CLI plumbing: `--key value` / `--flag` arguments, repository root, "run if main". */
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
 * (`<root>/.dev-process/engine/cli/x.mjs`).
 */
export function repoRoot(env = process.env, cliUrl = import.meta.url) {
  return env.DEV_PROCESS_ROOT ? resolve(env.DEV_PROCESS_ROOT) : resolve(fileURLToPath(cliUrl), "..", "..", "..", "..");
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
