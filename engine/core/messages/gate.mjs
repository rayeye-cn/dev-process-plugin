/**
 * risk-gate texts. Common params: `ai` reviewer display name, `reviewer` reviewer id (copilot | claude),
 * `pr` "PR" or "MR", `base` target branch name.
 */

/** How a missing AI review gets (re)started, per reviewer. */
const autoHint = {
  zh: { copilot: "通常每次推送后几分钟内自动评审；没来就在评审人列表里重新请求 Copilot", claude: "每次推送后评审作业自动运行（草稿不评审）；没跑成就重跑 AI 评审作业" },
  en: { copilot: "usually arrives a few minutes after each push; if not, re-request Copilot in the reviewers list", claude: "the review job runs after every push (not on drafts); if it failed, re-run the AI review job" },
};
/** Does the gate refresh when the review lands? Copilot's review event does not reach it; Claude's summary comment does. */
const rejudgeHint = {
  zh: (reviewer, label) =>
    reviewer === "claude" ? "它发出总结评论时门会自动重判" : `评审到了门不会自己刷新，发一条评论或打 \`${label}\` 标签就会重判`,
  en: (reviewer, label) =>
    reviewer === "claude"
      ? "the gate re-runs when its summary comment is posted"
      : `the gate does not refresh by itself when the review lands: post a comment or add the \`${label}\` label to re-run it`,
};
/** A review from before the target-branch change: who starts the new one. */
const staleHint = {
  zh: (reviewer) =>
    reviewer === "claude"
      ? "；它的评审在改目标分支之前、看的是旧 diff。改目标分支时评审作业会自己重跑；没跑（比如合并队列合掉上游 PR 后自动改的目标分支）就手动重跑 AI 评审作业"
      : "；它的评审在改目标分支之前、看的是旧 diff，门会请它重新评审",
  en: (reviewer) =>
    reviewer === "claude"
      ? "; its review predates the target-branch change and saw an old diff. The review job re-runs on a retarget by itself; if it did not (e.g. the merge queue retargeted the PR after merging the PR below it), re-run the AI review job"
      : "; its review predates the target-branch change and saw an old diff, so the gate asks it to review again",
};

const zh = {
  "tier.high": (p, h) => `改到总要有人看的路径：${h.list(p.paths)}`,
  "tier.docsOnly": "只改文档",
  "tier.empty": "没有文件改动",
  "tier.medium": "普通代码改动",
  "tier.size": (p) => `非文档改动 ${p.lines} 行，超过 ${p.threshold} 行（建议拆成串联 ${p.pr ?? "PR"}）`,
  "classifier.raised": (p) => `${p.ai} 第二意见提到 ${p.tier}：${p.reason || "（未给理由）"}`,
  "classifier.notHigher": (p) => `${p.ai} 第二意见：${p.tier}（不高于规则分档，不改）`,
  "classifier.none": (p) => `没有 ${p.ai} 第二意见（未启用或没跑成），按规则分档`,
  "base.changed": (p) => `目标分支在 ${p.at} 改过：在那之前的 ${p.ai} 评审、签署、批准与豁免命令都不算`,

  "missing.aiReview": (p, h) =>
    `等 ${p.ai} 评审当前提交 ${h.short(p.sha)}（${autoHint.zh[p.reviewer] ?? autoHint.zh.copilot}；${rejudgeHint.zh(p.reviewer, p.queueLabel)}）` +
    (p.staleBase ? staleHint.zh(p.reviewer) : "") +
    (p.notice !== null && p.notice !== undefined ? `；它在这个提交上只留了一条通知：「${p.notice || "（空正文）"}」` : "") +
    (p.ignored ? `；${h.tr(p.ignored)}` : "") +
    `。${p.ai} 故障或额度用完时，有写权限的人可以在评论里发 \`${p.cmd}\`，改为多要 ${p.extra} 位他人批准`,
  "waiver.beforeBase": "豁免命令发在改目标分支之前，要重发",
  "waiver.stale": (p) => `评论里的豁免命令写的是 ${p.sha}，不是当前提交`,
  "waiver.uncounted": (p) => `豁免命令是 \`${p.by ?? "?"}\` 发的（没有写权限），不算`,
  "missing.signoff": (p) =>
    `作者 @${p.author} 在评论里发 \`${p.cmd}\`（读过证据并为这次改动负责）` +
    (p.prev === "beforeBase" ? "；之前的签署在改目标分支之前（diff 变了），要重签" : p.prev === "stale" ? `；之前签的是 ${p.staleSha}，有新提交要重签` : ""),
  "missing.approvals": (p, h) => `还差 ${p.n} 位他人对当前提交 ${h.short(p.sha)} 的批准${p.notes.length ? `（${h.join(p.notes.map(h.tr))}）` : ""}`,
  "note.untrusted": "作者不在信任名单，多要一位",
  "note.waived": (p) => `AI 评审已豁免（\`${p.by}\` 发了 \`${p.cmd}\`），多要 ${p.extra} 位顶替`,
  "note.staleApprovers": (p, h) => `${h.mentions(p.logins)} 批的是旧提交，需重新批准`,
  "note.baseStaleApprovers": (p, h) => `${h.mentions(p.logins)} 批在改目标分支之前，需重新批准`,
  "note.uncountedApprovers": (p, h) => `${h.mentions(p.logins)} 没有写权限，不计`,
  "missing.changesRequested": (p, h) => `${h.mentions(p.logins)} 要求修改：处理后请对方重新评审`,
  "missing.unanswered": (p) => `${p.ai} 有 ${p.n} 条意见未回应：修掉，或回复以 ${p.tags.join(" / ")} 开头说明理由`,

  "status.ok": (p) => `${p.tier}：已满足（${p.humans} 人）`,
  "status.missing": (p) => `${p.tier}：还差 ${p.n} 项，见 ${p.pr} 里的 ${p.gate} 评论`,
  "status.rejudging": "重判中",
  "status.error": (p) => `重判出错，挡住合并：${p.message}`,

  "render.title": (p, h) => `### ${p.gate}：**${p.tier}**（需要 ${p.humans} 人${p.trusted ? "" : "，作者不在信任名单 +1"}）· 提交 \`${h.short(p.sha)}\``,
  "render.signoff": (p) => `- 作者签署：${p.needed ? (p.signed ? `已签（${p.sha}）` : "未签") : "本档不需要"}`,
  "render.approvals": (p, h) => `- 他人批准：${p.have}/${p.need}${p.logins.length ? `（${h.mentions(p.logins)}）` : ""}`,
  "render.ai": (p) => `- ${p.ai} 评审 ${p.rounds} 轮（当前提交：${p.state}），未回应意见 ${p.unanswered} 条`,
  "render.ai.reviewed": "已评审",
  "render.ai.waived": (p) => `没评审，已豁免：\`${p.by ?? "?"}\`${p.at ? ` 于 ${p.at}` : ""}`,
  "render.ai.pending": "还没评审",
  "render.ok.self": (p) => `**已满足。** 打 \`${p.queueLabel}\` 标签入队，队列会在最新 ${p.base} 上重跑 CI 后合入。`,
  "render.ok.native": "**已满足。** 可以加入合并队列。",
  "render.ok.train": "**已满足。** 可以设为流水线成功后自动合并（加入合并列车）。",
  "render.missing": "**还差：**",
  "render.unanswered": (p) => `未回应的 ${p.ai} 意见`,
  "render.link": "链接",
  "render.footer": (p) => `<sub>分档与人数见 \`${p.config}\`；评审流程见 CLAUDE.md。</sub>`,
  "rethink.body": (p) =>
    `${p.ai} 已评审 ${p.rounds} 轮，仍有 ${p.n} 条意见未回应。按评审流程，到这里请先停下来重新考虑方案（是不是方向或拆分有问题），而不是继续一轮轮修。`,
};

const en = {
  "tier.high": (p, h) => `Touches paths that always need a human: ${h.list(p.paths)}`,
  "tier.docsOnly": "Docs only",
  "tier.empty": "No file changes",
  "tier.medium": "Regular code change",
  "tier.size": (p) => `${p.lines} non-doc lines changed, over ${p.threshold} (consider a stack of smaller ${p.pr ?? "PR"}s)`,
  "classifier.raised": (p) => `${p.ai} second opinion raised it to ${p.tier}: ${p.reason || "(no reason given)"}`,
  "classifier.notHigher": (p) => `${p.ai} second opinion: ${p.tier} (not above the path-based tier, unchanged)`,
  "classifier.none": (p) => `No ${p.ai} second opinion (disabled or did not run); the path-based tier applies`,
  "base.changed": (p) => `The target branch changed at ${p.at}: ${p.ai} reviews, sign-offs, approvals and waivers before then don't count`,

  "missing.aiReview": (p, h) =>
    `Wait for ${p.ai} to review the head commit ${h.short(p.sha)} (${autoHint.en[p.reviewer] ?? autoHint.en.copilot}; ${rejudgeHint.en(p.reviewer, p.queueLabel)})` +
    (p.staleBase ? staleHint.en(p.reviewer) : "") +
    (p.notice !== null && p.notice !== undefined ? `; it left only a notice on this commit: "${p.notice || "(empty body)"}"` : "") +
    (p.ignored ? `; ${h.tr(p.ignored)}` : "") +
    `. If ${p.ai} is down or out of quota, someone with write access can comment \`${p.cmd}\` to require ${p.extra} more approval(s) instead`,
  "waiver.beforeBase": "the waiver was posted before the target-branch change; post it again",
  "waiver.stale": (p) => `the waiver in the comments names ${p.sha}, not the head commit`,
  "waiver.uncounted": (p) => `the waiver was posted by \`${p.by ?? "?"}\` (no write access) and does not count`,
  "missing.signoff": (p) =>
    `Author @${p.author}: comment \`${p.cmd}\` (you have read the evidence and own this change)` +
    (p.prev === "beforeBase"
      ? "; the earlier sign-off predates the target-branch change (the diff changed), sign again"
      : p.prev === "stale"
        ? `; you signed ${p.staleSha}, new commits need a new sign-off`
        : ""),
  "missing.approvals": (p, h) => `${p.n} more approval(s) from others on the head commit ${h.short(p.sha)}${p.notes.length ? ` (${h.join(p.notes.map(h.tr))})` : ""}`,
  "note.untrusted": "author not in the trusted list, one more needed",
  "note.waived": (p) => `AI review waived (\`${p.by}\` posted \`${p.cmd}\`), ${p.extra} more needed instead`,
  "note.staleApprovers": (p, h) => `${h.mentions(p.logins)} approved an older commit and need to approve again`,
  "note.baseStaleApprovers": (p, h) => `${h.mentions(p.logins)} approved before the target-branch change and need to approve again`,
  "note.uncountedApprovers": (p, h) => `${h.mentions(p.logins)} lack write access and don't count`,
  "missing.changesRequested": (p, h) => `${h.mentions(p.logins)} requested changes: address them and ask for a re-review`,
  "missing.unanswered": (p) => `${p.n} ${p.ai} comment(s) unanswered: fix them, or reply starting with ${p.tags.join(" / ")} and a reason`,

  "status.ok": (p) => `${p.tier}: satisfied (${p.humans} ${p.humans === 1 ? "person" : "people"})`,
  "status.missing": (p) => `${p.tier}: ${p.n} item(s) missing, see the ${p.gate} comment on the ${p.pr}`,
  "status.rejudging": "re-evaluating",
  "status.error": (p) => `gate error, blocking merge: ${p.message}`,

  "render.title": (p, h) =>
    `### ${p.gate}: **${p.tier}** (needs ${p.humans} ${p.humans === 1 ? "person" : "people"}${p.trusted ? "" : ", untrusted author +1"}) · commit \`${h.short(p.sha)}\``,
  "render.signoff": (p) => `- Author sign-off: ${p.needed ? (p.signed ? `signed (${p.sha})` : "not yet") : "not needed for this tier"}`,
  "render.approvals": (p, h) => `- Approvals from others: ${p.have}/${p.need}${p.logins.length ? ` (${h.mentions(p.logins)})` : ""}`,
  "render.ai": (p) => `- ${p.ai} reviews: ${p.rounds} round(s) (head commit: ${p.state}); ${p.unanswered} unanswered`,
  "render.ai.reviewed": "reviewed",
  "render.ai.waived": (p) => `not reviewed, waived by \`${p.by ?? "?"}\`${p.at ? ` at ${p.at}` : ""}`,
  "render.ai.pending": "not reviewed yet",
  "render.ok.self": (p) => `**Satisfied.** Add the \`${p.queueLabel}\` label to queue it; the queue re-runs CI on the latest ${p.base} before merging.`,
  "render.ok.native": "**Satisfied.** It can join the merge queue.",
  "render.ok.train": "**Satisfied.** Set it to merge when the pipeline succeeds (joins the merge train).",
  "render.missing": "**Still missing:**",
  "render.unanswered": (p) => `Unanswered ${p.ai} comments`,
  "render.link": "link",
  "render.footer": (p) => `<sub>Tiers and people: \`${p.config}\`; process: CLAUDE.md.</sub>`,
  "rethink.body": (p) =>
    `${p.ai} has reviewed ${p.rounds} rounds and ${p.n} comment(s) are still unanswered. Per the review process, stop here and reconsider the approach (direction or split) instead of iterating round after round.`,
};

export default { zh, en };
