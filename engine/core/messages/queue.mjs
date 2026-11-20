/**
 * merge-queue texts (zh/en, same keys). See messages/index.mjs. Common params: `pr` "PR" or "MR", `branch` the target
 * (default) branch, `gate` the gate status name, `label` the queue label, `why` a nested `{ code, params }` item.
 * The attempt counter and the waiver trailer are machine-read and live in core/queue.mjs and core/gate.mjs, not here.
 */

const zh = {
  "queue.ready": "就绪",
  "queue.wait.draft": "还是草稿",
  "queue.wait.checkMissing": (p) => `必需检查 ${p.name} 还没跑`,
  "queue.wait.checkRunning": (p) => `必需检查 ${p.name} 还在跑`,
  "queue.wait.gatePending": (p) => `${p.gate} 还没重判`,
  "queue.eject.fork": (p) => `fork 来的 ${p.pr} 不进队列（它的代码会带着本仓的权限在 CI 里跑），请从本仓分支提 ${p.pr}`,
  "queue.eject.conflict": (p) => `与 ${p.branch} 有冲突，请先更新分支`,
  "queue.eject.checkFailed": (p) => `必需检查 ${p.name} 结论是 ${p.conclusion}`,
  "queue.eject.trialConflict": (p) => `与最新 ${p.branch} 合不起来（冲突），请先更新分支`,
  "queue.eject.ciFailed": (p) => `在最新 ${p.branch} 上 CI 结论是 ${p.conclusion}${p.url ? `（${p.url}）` : ""}`,
  "queue.eject.giveUp": (p) =>
    `同一提交已在队列里连续测了 ${p.attempts} 次仍没合成（${p.branch} 在测试期间一直在动，或队列运行中途中断），停止自动重测；等 ${p.branch} 稳定后重新入队`,
  "queue.eject.mergeRejected": (p) => `合并被拒：${p.message}`,

  "queue.gate.newCommits": (p) => `${p.pr} 有新提交，下一轮再判`,
  "queue.gate.otherBase": (p) => `目标分支是 ${p.actual}，不是 ${p.branch}`,
  "queue.gate.running": (p) => `${p.gate} 正在重判，等它跑完`,
  "queue.gate.unmet": (p, h) => `${p.gate} 重判未满足${p.n > 1 ? `（共 ${p.n} 项）` : ""}：${h.tr(p.first)}`,
  "queue.gate.staleStatus": (p) => `${p.gate} 重判已满足，但现存结论是旧的：已请 ${p.gate} 重判，跑完再来`,
  "queue.gate.ok": (p) => `${p.gate} 重判已满足（${p.tier}）`,
  "queue.gate.error": (p) => `${p.gate} 重判出错：${p.message}`,

  "queue.block.closed": (p) => `${p.pr} 已关闭`,
  "queue.block.newCommits": (p) => `${p.pr} 有新提交，下一轮再处理`,
  "queue.block.otherBase": (p) => `目标分支改成了 ${p.actual}`,
  "queue.block.unlabeled": (p) => `${p.label} 标签已被摘掉`,

  "queue.status.ejected": (p, h) => `出队：${h.tr(p.why)}`,
  "queue.status.testing": (p, h) => `在 ${p.branch}@${h.short(p.sha)} 上重跑 CI`,
  "queue.status.voided": (p) => `作废（${p.branch} 在测试期间动了），待重测`,
  "queue.status.notMerged": (p, h) => `没合：${h.tr(p.why)}`,
  "queue.status.verified": (p, h) => `已在 ${p.branch}@${h.short(p.sha)} 上验证`,
  "queue.status.needsQueue": (p) => `需要经合并队列合入（打 ${p.label} 标签）`,

  "queue.comment.ejected": (p, h) => `合并队列：已出队——${h.tr(p.why)}。处理后重新打 \`${p.label}\` 标签入队。${p.run ? `\n\n队列运行：${p.run}` : ""}`,
  "queue.comment.issueClosed": (p, h) =>
    `由 #${p.number} 合入关闭${p.sha ? `（${h.short(p.sha)}）` : ""}。合并队列以 CI 身份合入时平台不会按 Closes 自动关闭，由队列代关。`,
  "queue.comment.untested": (p, h) =>
    `合并队列：本 ${p.pr} 测的是 ${p.branch}@${h.short(p.tested)}，合入时 ${p.branch} 已到 ${h.short(p.parent)}，合进去的组合没有被完整测过。` +
    `已在 ${p.branch} 上补跑 CI，请值班看结果。`,

  "queue.commit.title": (p) => `合并 ${p.pr} #${p.number}`,
  "queue.commit.trial": (p, h) => `${p.queue}: 在 ${p.branch}@${h.short(p.sha)} 上试合 #${p.number}`,
  "queue.commit.body": (p, h) => `合并队列在 ${p.branch}@${h.short(p.sha)} 上重跑 CI 通过：${p.url ?? ""}`,
  "queue.commit.waived": (p) => `AI 评审已豁免：\`${p.by ?? "?"}\`${p.at ? ` 于 ${p.at}` : ""} 发了 \`${p.cmd}\`，多要了他人批准顶替。`,
};

const en = {
  "queue.ready": "ready",
  "queue.wait.draft": "still a draft",
  "queue.wait.checkMissing": (p) => `required check ${p.name} has not run yet`,
  "queue.wait.checkRunning": (p) => `required check ${p.name} is still running`,
  "queue.wait.gatePending": (p) => `${p.gate} has not been re-evaluated yet`,
  "queue.eject.fork": (p) =>
    `${p.pr}s from forks don't enter the queue (their code would run in CI with this repository's permissions); open the ${p.pr} from a branch in this repository`,
  "queue.eject.conflict": (p) => `conflicts with ${p.branch}; update the branch first`,
  "queue.eject.checkFailed": (p) => `required check ${p.name} concluded ${p.conclusion}`,
  "queue.eject.trialConflict": (p) => `does not merge into the latest ${p.branch} (conflict); update the branch first`,
  "queue.eject.ciFailed": (p) => `CI on the latest ${p.branch} concluded ${p.conclusion}${p.url ? ` (${p.url})` : ""}`,
  "queue.eject.giveUp": (p) =>
    `the same commit was tested ${p.attempts} times in a row without merging (${p.branch} kept moving during the tests, or a queue run was interrupted); automatic re-testing stopped, re-queue once ${p.branch} settles`,
  "queue.eject.mergeRejected": (p) => `merge rejected: ${p.message}`,

  "queue.gate.newCommits": (p) => `the ${p.pr} has new commits; it is judged again next round`,
  "queue.gate.otherBase": (p) => `the target branch is ${p.actual}, not ${p.branch}`,
  "queue.gate.running": (p) => `${p.gate} is re-evaluating; waiting for it to finish`,
  "queue.gate.unmet": (p, h) => `${p.gate} re-evaluation not satisfied${p.n > 1 ? ` (${p.n} items)` : ""}: ${h.tr(p.first)}`,
  "queue.gate.staleStatus": (p) => `${p.gate} re-evaluation is satisfied but the stored result is outdated: asked ${p.gate} to re-evaluate, back after it finishes`,
  "queue.gate.ok": (p) => `${p.gate} re-evaluation satisfied (${p.tier})`,
  "queue.gate.error": (p) => `${p.gate} re-evaluation failed: ${p.message}`,

  "queue.block.closed": (p) => `the ${p.pr} is closed`,
  "queue.block.newCommits": (p) => `the ${p.pr} has new commits; handled next round`,
  "queue.block.otherBase": (p) => `the target branch changed to ${p.actual}`,
  "queue.block.unlabeled": (p) => `the ${p.label} label was removed`,

  "queue.status.ejected": (p, h) => `ejected: ${h.tr(p.why)}`,
  "queue.status.testing": (p, h) => `re-running CI on ${p.branch}@${h.short(p.sha)}`,
  "queue.status.voided": (p) => `voided (${p.branch} moved during the test), to be re-tested`,
  "queue.status.notMerged": (p, h) => `not merged: ${h.tr(p.why)}`,
  "queue.status.verified": (p, h) => `verified on ${p.branch}@${h.short(p.sha)}`,
  "queue.status.needsQueue": (p) => `must merge through the merge queue (add the ${p.label} label)`,

  "queue.comment.ejected": (p, h) =>
    `Merge queue: removed from the queue: ${h.tr(p.why)}. Once fixed, add the \`${p.label}\` label again to re-queue.${p.run ? `\n\nQueue run: ${p.run}` : ""}`,
  "queue.comment.issueClosed": (p, h) =>
    `Closed by the merge of #${p.number}${p.sha ? ` (${h.short(p.sha)})` : ""}. The platform does not close issues from "Closes" when the merge queue merges as the CI identity, so the queue closes them.`,
  "queue.comment.untested": (p, h) =>
    `Merge queue: this ${p.pr} was tested on ${p.branch}@${h.short(p.tested)}, but ${p.branch} was at ${h.short(p.parent)} when it merged, so the merged combination was not fully tested. ` +
    `CI was re-run on ${p.branch}; please watch the result.`,

  "queue.commit.title": (p) => `${p.start ? "Merge" : "merge"} ${p.pr} #${p.number}`,
  "queue.commit.trial": (p, h) => `${p.queue}: trial merge of #${p.number} on ${p.branch}@${h.short(p.sha)}`,
  "queue.commit.body": (p, h) => `Merge queue re-ran CI on ${p.branch}@${h.short(p.sha)} and it passed: ${p.url ?? ""}`,
  "queue.commit.waived": (p) => `AI review waived: \`${p.by ?? "?"}\` posted \`${p.cmd}\`${p.at ? ` at ${p.at}` : ""}; extra approvals from others were required instead.`,
};

export default { zh, en };
