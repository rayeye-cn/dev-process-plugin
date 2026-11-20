// Shared fixtures for engine tests.
import { readFileSync } from "node:fs";

import { withDefaults } from "../engine/core/policy.mjs";

export const policy = withDefaults(JSON.parse(readFileSync(new URL("./fixtures/policy.json", import.meta.url), "utf8")));
export const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
export const OLD = "0123456789abcdef0123456789abcdef01234567";
export const AUTHOR = "alice";

export const file = (filename, lines = 10, previous_filename) => ({ filename, additions: lines, deletions: 0, previous_filename });
