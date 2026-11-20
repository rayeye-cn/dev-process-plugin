/**
 * Text produced by an AI CLI run, whichever CLI produced it:
 * - GitHub Copilot CLI (`copilot -p … -s`): plain text;
 * - Claude Code (`claude --bare -p … --output-format json`): a JSON object whose `result` is the text
 *   (`structured_output` when `--json-schema` was used).
 * Anything that is not such a JSON object is taken as plain text.
 */
export function extractText(raw) {
  const s = String(raw ?? "");
  const trimmed = s.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed);
      if (o && typeof o === "object") {
        if (typeof o.result === "string") return o.result;
        if (o.structured_output !== undefined) return typeof o.structured_output === "string" ? o.structured_output : JSON.stringify(o.structured_output);
      }
    } catch {
      // not JSON: plain text
    }
  }
  return s;
}
