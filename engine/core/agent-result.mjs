/**
 * Role agents: what the Claude run is asked (the prompt) and what it must answer (one JSON object, AGENT_RESULT_SCHEMA).
 * Pure. The runner (cli/agent-run.mjs) does every write; the model only edits files in its worktree and answers.
 */
import { asCodeBlock } from "./findings.mjs";
import { t } from "./messages/index.mjs";

export const AGENT_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "next"],
  properties: {
    status: { type: "string", enum: ["done", "needs_human", "failed"] },
    summary: { type: "string", description: "what you did or found, for the issue comment" },
    next: { type: "string", description: 'the role to hand the issue on to, or "done", or "human"' },
    handoff: { type: "string", description: "notes for the next role: what is ready, what to do next" },
    questions: { type: "array", items: { type: "string" }, description: "what a person must decide (status needs_human)" },
    pr: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body"],
      properties: {
        title: { type: "string", description: "pull request title, one line" },
        body: { type: "string", description: "what changed and why" },
        verification: { type: "string", description: "commands you ran and their results" },
      },
    },
    triage: {
      type: "object",
      additionalProperties: false,
      required: ["role"],
      properties: {
        role: { type: "string", description: "the role this issue belongs to" },
        subtasks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "body", "role"],
            properties: { title: { type: "string" }, body: { type: "string" }, role: { type: "string" } },
          },
        },
      },
    },
  },
});

const cap = (s, n) => String(s ?? "").trim().slice(0, n);
const MAX_SUBTASKS = 10;

/** The result object from the CLI's JSON output (structured_output first), checked and capped; null when unusable. */
export function parseAgentResult(raw) {
  let o;
  try {
    const outer = JSON.parse(String(raw ?? "").trim());
    o = outer && typeof outer.structured_output === "object" && outer.structured_output !== null ? outer.structured_output : outer;
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || !["done", "needs_human", "failed"].includes(o.status) || typeof o.next !== "string") return null;
  const status = o.status;
  const next = status === "done" ? cap(o.next, 40) : "human";
  const pr =
    o.pr && typeof o.pr === "object" && typeof o.pr.title === "string" && o.pr.title.trim()
      ? { title: cap(o.pr.title, 200).replace(/\s+/g, " "), body: cap(o.pr.body, 20000), verification: cap(o.pr.verification, 20000) }
      : null;
  const triage =
    o.triage && typeof o.triage === "object" && typeof o.triage.role === "string"
      ? {
          role: cap(o.triage.role, 40),
          subtasks: (Array.isArray(o.triage.subtasks) ? o.triage.subtasks : [])
            .filter((s) => s && typeof s.title === "string" && s.title.trim() && typeof s.role === "string")
            .slice(0, MAX_SUBTASKS)
            .map((s) => ({ title: cap(s.title, 200).replace(/\s+/g, " "), body: cap(s.body, 8000), role: cap(s.role, 40) })),
        }
      : null;
  return {
    status,
    summary: cap(o.summary, 8000),
    next,
    handoff: cap(o.handoff, 8000),
    questions: (Array.isArray(o.questions) ? o.questions : []).filter((q) => typeof q === "string" && q.trim()).slice(0, 10).map((q) => cap(q, 1000)),
    pr,
    triage,
  };
}

/** What the run was refused (`permission_denials` of the CLI's JSON output): commands or file paths. */
export function deniedActions(raw) {
  try {
    const o = JSON.parse(String(raw ?? "").trim());
    return (o.permission_denials ?? []).map((d) => String(d.tool_input?.command ?? d.tool_input?.file_path ?? d.tool_name ?? "").slice(0, 200)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The prompt: the role's instructions, the ground rules, the task context, then the issue as material in fenced blocks
 * (its text is data, never instructions).
 * @param issue    `{ number, title, body, comments: [{ login, body }] }`
 * @param context  `{ role, triage, next: [role…], paths, protectedPaths, roles: [role…] }`
 */
export function buildAgentPrompt({ lang, instructions, issue, context }) {
  const comments = (issue.comments ?? []).slice(-20).map((c) => `${c.login}:\n${c.body}`).join("\n\n---\n\n");
  return [
    String(instructions ?? "").trim(),
    "",
    t(lang, "agent.prompt.rules", context),
    "",
    t(lang, context.triage ? "agent.prompt.triage" : "agent.prompt.task", context),
    ...(context.continued ? ["", t(lang, "agent.prompt.continue")] : []),
    "",
    t(lang, "agent.prompt.issueHeader", { number: issue.number }),
    asCodeBlock(`${issue.title}\n\n${issue.body ?? ""}`),
    ...(comments ? ["", t(lang, "agent.prompt.commentsHeader"), asCodeBlock(comments)] : []),
    "",
    t(lang, "agent.prompt.answer", context),
  ].join("\n");
}
