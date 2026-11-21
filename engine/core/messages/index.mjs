/**
 * Message catalog. Pure decision functions return `{ code, params }`; text is produced here, in the project's language.
 * Each module file exports `{ zh: {...}, en: {...} }` with the same keys (test/messages.test.mjs checks parity).
 * A message is a string or a function `(params, h) => string`, where `h` holds language-aware helpers.
 *
 * Machine-read tokens never live in messages (they would change with the language): see the `*_TOKEN` constants
 * in the core modules.
 */
import agent from "./agent.mjs";
import aiReview from "./ai-review.mjs";
import classify from "./classify.mjs";
import doctor from "./doctor.mjs";
import evalTexts from "./eval.mjs";
import gate from "./gate.mjs";
import metrics from "./metrics.mjs";
import protection from "./protection.mjs";
import queue from "./queue.mjs";
import release from "./release.mjs";
import sweep from "./sweep.mjs";

export const MODULES = Object.freeze({ gate, queue, release, metrics, classify, sweep, eval: evalTexts, protection, doctor, aiReview, agent });
export const LANGUAGES = Object.freeze(["zh", "en"]);

const CATALOG = Object.fromEntries(LANGUAGES.map((lang) => [lang, Object.assign({}, ...Object.values(MODULES).map((m) => m[lang]))]));

/** How the forge cites a change: `#12` for a PR, `!12` for a GitLab MR (where `#12` means issue 12). */
export function changeRef(number, pr = "PR") {
  return `${pr === "MR" ? "!" : "#"}${number}`;
}

export function helpers(lang) {
  const zh = lang === "zh";
  return {
    zh,
    /** First n items, then "and N more". */
    list: (items, n = 5) =>
      zh
        ? `${items.slice(0, n).join("、")}${items.length > n ? ` 等 ${items.length} 个` : ""}`
        : `${items.slice(0, n).join(", ")}${items.length > n ? ` and ${items.length - n} more` : ""}`,
    mentions: (logins) => logins.map((l) => `@${l}`).join(zh ? "、" : ", "),
    join: (parts) => parts.join(zh ? "；" : "; "),
    short: (sha, n = 7) => String(sha ?? "").slice(0, n),
    /** How the forge cites a change: `#12` (GitHub PR) or `!12` (GitLab MR; `#12` would be issue 12 there). */
    ref: (number, pr = "PR") => changeRef(number, pr),
    /** Render a nested `{ code, params }` item in the same language. */
    tr: (item) => t(lang, item.code, item.params),
  };
}

export function t(lang, code, params = {}) {
  const m = (CATALOG[lang] ?? CATALOG.en)[code];
  if (m === undefined) throw new Error(`missing message ${lang}:${code}`);
  return typeof m === "function" ? m(params, helpers(lang)) : m;
}

/** Render a `{ code, params }` item. */
export const tr = (lang, item) => t(lang, item.code, item.params);

/** Keys per module and language (for the parity test). */
export function catalogKeys() {
  return Object.fromEntries(Object.entries(MODULES).map(([name, m]) => [name, Object.fromEntries(LANGUAGES.map((l) => [l, Object.keys(m[l]).sort()]))]));
}
