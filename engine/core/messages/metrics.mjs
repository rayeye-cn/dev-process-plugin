/**
 * metrics texts (zh/en, same keys): the weekly review metrics report and its issue. See messages/index.mjs.
 * Params: `ai` reviewer display name, `pr` "PR" or "MR", `pairs` `[[name, count]]` (already rendered names; outcome
 * names are reply tags / codes and stay as they are), `tag` the false-positive reply tag.
 */
const pairs = (list, sep) => (list ?? []).map(([k, v]) => `${k} ${v}`).join(sep) || "—";

const zh = {
  "metrics.title": (p) => `## 评审指标 ${p.since} ～ ${p.until}`,
  "metrics.summary": (p) => `合入 ${p.prs} 个 ${p.pr ?? "PR"}；没有他人批准就合入的占 ${p.zeroHuman}。`,
  "metrics.table.header": "| 指标 | 中位数 | p95 |",
  "metrics.row.approvals": (p) => `他人批准数 / ${p.pr ?? "PR"}`,
  "metrics.row.humanComments": (p) => `他人评论数 / ${p.pr ?? "PR"}`,
  "metrics.row.leadHours": (p) => `开 ${p.pr ?? "PR"} → 合入`,
  "metrics.row.approvalWaitHours": (p) => `开 ${p.pr ?? "PR"} → 第一个他人批准`,
  "metrics.row.aiRounds": (p) => `${p.ai} 评审轮数 / ${p.pr ?? "PR"}`,
  "metrics.unit.hours": " 小时",
  "metrics.tier.untiered": "未分档",
  "metrics.tiers": (p) => `**分档**：${pairs(p.pairs, "，")}`,
  "metrics.outcomes": (p) => `**${p.ai} 意见去向**：${pairs(p.pairs, "，")}；误报率（${p.tag} ÷ 有去向）${p.rate}`,
  "metrics.waived": (p) => `**AI 评审豁免**：${p.n} 个 ${p.pr ?? "PR"} 没等到 ${p.ai} 评审，改由人顶替（按合入提交里合并队列写的豁免记录数）。`,
  "metrics.guard": (p) => `**护栏**：回滚提交 ${p.reverts} 个，修复类 ${p.pr ?? "PR"} ${p.fixPrs} 个。这两个数上升时，省下的评审时间只是挪到了修 bug 上。`,
  "metrics.issue.title": "评审指标周报",
  "metrics.issue.body": (p) => `评审指标工作流每周在这里追加一条评论。口径见 \`${p.doc}\` 文件头。`,
};

const en = {
  "metrics.title": (p) => `## Review metrics ${p.since} – ${p.until}`,
  "metrics.summary": (p) => `${p.prs} ${p.pr ?? "PR"}(s) merged; ${p.zeroHuman} of them without an approval from someone other than the author.`,
  "metrics.table.header": "| Metric | Median | p95 |",
  "metrics.row.approvals": (p) => `Approvals from others / ${p.pr ?? "PR"}`,
  "metrics.row.humanComments": (p) => `Comments from others / ${p.pr ?? "PR"}`,
  "metrics.row.leadHours": (p) => `${p.pr ?? "PR"} opened → merged`,
  "metrics.row.approvalWaitHours": (p) => `${p.pr ?? "PR"} opened → first approval from others`,
  "metrics.row.aiRounds": (p) => `${p.ai} review rounds / ${p.pr ?? "PR"}`,
  "metrics.unit.hours": " h",
  "metrics.tier.untiered": "untiered",
  "metrics.tiers": (p) => `**Tiers**: ${pairs(p.pairs, ", ")}`,
  "metrics.outcomes": (p) => `**What became of ${p.ai} comments**: ${pairs(p.pairs, ", ")}; false-positive rate (${p.tag} ÷ with an outcome) ${p.rate}`,
  "metrics.waived": (p) =>
    `**AI review waivers**: ${p.n} ${p.pr ?? "PR"}(s) did not wait for a ${p.ai} review; people stood in instead (counted from the waiver records the merge queue writes into merge commits).`,
  "metrics.guard": (p) =>
    `**Guardrails**: ${p.reverts} revert commit(s), ${p.fixPrs} fix ${p.pr ?? "PR"}(s). When these rise, the review time saved has only moved to fixing bugs.`,
  "metrics.issue.title": "Weekly review metrics",
  "metrics.issue.body": (p) => `The review metrics workflow appends a comment here every week. What is measured: see the header of \`${p.doc}\`.`,
};

export default { zh, en };
