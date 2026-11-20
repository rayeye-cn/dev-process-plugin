/**
 * sweep texts (zh/en, same keys). See messages/index.mjs.
 * Also holds `finding.format`, the output format shared by every AI CLI review prompt (core/findings.mjs; the sweep and
 * the eval both end their prompts with it). Params `finding` / `none` are the machine-read tokens, never translated.
 * Common params: `pr` "PR" or "MR"; `cli` the AI CLI ("copilot" | "claude"), which decides the read-only tools named.
 */

/** How the model reads code, per AI CLI: Copilot CLI is allowed read-only shell commands, Claude Code its own read tools. */
const readWith = {
  zh: { copilot: "用 ls、cat、grep、head、wc 读代码", claude: "用 Read、Grep、Glob 工具读代码" },
  en: { copilot: "Read the code with ls, cat, grep, head and wc", claude: "Read the code with the Read, Grep and Glob tools" },
};

const zh = {
  "finding.format": (p) =>
    [
      "每条发现单独输出一行，格式严格如下（一行一个 JSON，不要加代码块）：",
      `${p.finding} {"file":"相对仓根的路径","line":行号,"title":"一句话中文标题","evidence":"为什么是 bug，引用那一行的代码"}`,
      `没有发现就只输出一行：${p.none}`,
    ].join("\n"),

  "sweep.prompt.task": (p) => `你是这个仓库的代码评审员，今晚要审的是**现有代码**（不是某个 ${p.pr}），范围是路径匹配下面这个 glob 的文件：\n  ${p.area}`,
  "sweep.prompt.tools": (p) => `${readWith.zh[p.cli]}，不要修改任何文件，不要运行测试或安装任何东西。`,
  "sweep.prompt.scope": "只报会导致错误行为、数据丢失、安全或隐私问题的真 bug，必须能指出具体文件与行号；风格问题一律不报。",
  "sweep.prompt.max": (p) => `最多报 ${p.max} 条，按严重程度排序。`,
  "sweep.prompt.criteria": (p) => `评审标准（与 ${p.pr} 上的 AI 代码评审同一份指令）：`,

  "sweep.issue.title": (p) => `夜间巡检：${p.title}（${p.file}:${p.line}）`,
  "sweep.issue.area": (p) => `巡检范围：\`${p.area}\``,
  "sweep.issue.location": (p) => `**位置**：\`${p.file}:${p.line}\``,
  "sweep.issue.evidence": (p) => `**依据**（巡检原话，按原文显示）：\n\n${p.block}`,
  "sweep.issue.noEvidence": "**依据**：（未给）",
  "sweep.issue.footer": (p) =>
    `这条由 AI 夜间巡检发现，**还没有人核实**。核实后：成立就开 ${p.pr} 修；不成立就关掉并在评论里写原因（用于评估巡检的误报率）。`,
};

const en = {
  "finding.format": (p) =>
    [
      "Print each finding on its own line, exactly in this format (one JSON object per line, no code block):",
      `${p.finding} {"file":"path relative to the repository root","line":line number,"title":"one-line title in English","evidence":"why it is a bug, quoting the code on that line"}`,
      `If there are no findings, print a single line: ${p.none}`,
    ].join("\n"),

  "sweep.prompt.task": (p) =>
    `You are a code reviewer for this repository. Tonight you review the **existing code** (not a single ${p.pr}), limited to files whose path matches this glob:\n  ${p.area}`,
  "sweep.prompt.tools": (p) => `${readWith.en[p.cli]}; do not modify any file, do not run tests or install anything.`,
  "sweep.prompt.scope": "Report only real bugs that cause wrong behavior, data loss, or security or privacy problems, each with a specific file and line number; never report style issues.",
  "sweep.prompt.max": (p) => `Report at most ${p.max}, most severe first.`,
  "sweep.prompt.criteria": (p) => `Review criteria (the same instructions as the AI code review on ${p.pr}s):`,

  "sweep.issue.title": (p) => `Nightly review: ${p.title} (${p.file}:${p.line})`,
  "sweep.issue.area": (p) => `Sweep area: \`${p.area}\``,
  "sweep.issue.location": (p) => `**Location**: \`${p.file}:${p.line}\``,
  "sweep.issue.evidence": (p) => `**Evidence** (the sweep's own words, shown verbatim):\n\n${p.block}`,
  "sweep.issue.noEvidence": "**Evidence**: (none given)",
  "sweep.issue.footer": (p) =>
    `Found by the nightly AI sweep and **not verified by anyone yet**. After checking: if it holds, fix it in a new ${p.pr}; if not, close this issue with the reason in a comment (this measures the sweep's false-positive rate).`,
};

export default { zh, en };
