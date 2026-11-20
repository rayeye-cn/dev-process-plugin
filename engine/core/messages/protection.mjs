/** Protection and consistency texts (zh/en, same keys). See messages/index.mjs. */
const zh = {
  "consistency.codeownersMismatch": (p) => `CODEOWNERS 与策略的 highPaths 不一致：缺 ${p.missing.join("、") || "无"}；多 ${p.extra.join("、") || "无"}`,
  "consistency.ownerNotTrusted": (p) => `CODEOWNERS 里 ${p.glob} 的所有者 ${p.owners.join("、")} 不在信任名单里`,
  "consistency.singleOwner": (p) => `CODEOWNERS 里 ${p.glob} 只有一位所有者：他自己的 ${p.pr ?? "PR"} 没有人能批`,
  "consistency.applyToMissing": "Copilot 安全指令文件没有 applyTo 前言",
  "consistency.applyToMismatch": (p) => `Copilot 安全指令的 applyTo 与 securityPaths 不一致：缺 ${p.missing.join("、") || "无"}；多 ${p.extra.join("、") || "无"}`,
  "consistency.processNotHigh": (p) => `流程文件不在 highPaths 里：${p.paths.join("、")}（AI 读的是 PR 分支上的指令，改它必须有另一人审）`,
  "consistency.waiverIsSignoff": (p) => `豁免命令与签署命令相同（${p.cmd}）`,
  "consistency.waiverFree": "豁免 AI 评审至少要多要一位他人批准",
  "consistency.claudeMdWaiver": (p) => `CLAUDE.md 没写豁免命令 \`${p.cmd} <head sha>\``,
  "consistency.claudeMdSignoff": (p) => `CLAUDE.md 没写签署命令 \`${p.cmd} <head sha>\``,
  "consistency.lowNeedsPeople": (p) => `low 档要 ${p.n} 人：只改文档也要人，大多数改动就不能零人合入`,
  "consistency.humansDecrease": (p) => `各档人数要单调不减（low ${p.low} / medium ${p.medium} / high ${p.high}）`,
  "consistency.highUnderTwo": (p) => `high 档只要 ${p.n} 人：总要有人看的路径应当由作者以外的人批准`,
  "consistency.oneTrustedAuthor": (p) => `信任名单只有 ${p.n} 人：high 档需要的另一位批准人找不到`,
  "consistency.highAndLow": (p) => `这些文件既在 highPaths 又在 lowOnlyPaths：${p.files.slice(0, 5).join("、")}`,
  "consistency.deadGlobs": (p) => `这些路径规则还没命中任何文件（写错了，或文件还没建）：${p.globs.join("、")}`,
};

const en = {
  "consistency.codeownersMismatch": (p) => `CODEOWNERS does not match the policy's highPaths: missing ${p.missing.join(", ") || "none"}; extra ${p.extra.join(", ") || "none"}`,
  "consistency.ownerNotTrusted": (p) => `CODEOWNERS owners of ${p.glob} are not trusted authors: ${p.owners.join(", ")}`,
  "consistency.singleOwner": (p) => `CODEOWNERS names a single owner for ${p.glob}: nobody can approve that owner's own ${p.pr ?? "PR"}s`,
  "consistency.applyToMissing": "The Copilot security instruction file has no applyTo front matter",
  "consistency.applyToMismatch": (p) => `The Copilot security instruction's applyTo does not match securityPaths: missing ${p.missing.join(", ") || "none"}; extra ${p.extra.join(", ") || "none"}`,
  "consistency.processNotHigh": (p) => `Process files are not in highPaths: ${p.paths.join(", ")} (the AI reads instructions from the PR branch, so changing them needs another person)`,
  "consistency.waiverIsSignoff": (p) => `The waiver command equals the sign-off command (${p.cmd})`,
  "consistency.waiverFree": "Waiving the AI review must require at least one extra approval",
  "consistency.claudeMdWaiver": (p) => `CLAUDE.md does not mention the waiver command \`${p.cmd} <head sha>\``,
  "consistency.claudeMdSignoff": (p) => `CLAUDE.md does not mention the sign-off command \`${p.cmd} <head sha>\``,
  "consistency.lowNeedsPeople": (p) => `The low tier needs ${p.n} people: even docs-only changes need someone, so most changes cannot merge with nobody`,
  "consistency.humansDecrease": (p) => `People per tier must not decrease (low ${p.low} / medium ${p.medium} / high ${p.high})`,
  "consistency.highUnderTwo": (p) => `The high tier needs only ${p.n}: paths that always need a human should be approved by someone other than the author`,
  "consistency.oneTrustedAuthor": (p) => `Only ${p.n} trusted author(s): the second approver the high tier needs does not exist`,
  "consistency.highAndLow": (p) => `These files are in both highPaths and lowOnlyPaths: ${p.files.slice(0, 5).join(", ")}`,
  "consistency.deadGlobs": (p) => `These path rules match no file yet (a typo, or not created yet): ${p.globs.join(", ")}`,
};

export default { zh, en };
