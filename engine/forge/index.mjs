/**
 * Forge adapters. Each one returns the same normalized shapes (see forge/github.mjs `loadChange`) and the same write
 * operations, so the core and the CLIs don't know which forge they talk to.
 */
import { createGithub } from "./github.mjs";

export function createForge(policy, opts = {}) {
  switch (policy.forge) {
    case "github":
      return createGithub(opts);
    default:
      throw new Error(`forge "${policy.forge}" is not supported yet`);
  }
}
