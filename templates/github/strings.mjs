/**
 * Short UI strings for workflow job and step names (what people see in the Actions UI), per language.
 * Workflow comments are English; these names follow the project language. Same keys in both languages
 * (test/context.test.mjs checks parity). Template authors add keys here as needed.
 *
 * The workflows use these values unquoted as YAML values and inside double-quoted `echo "…"` lines, so a value must
 * not contain `: `, ` #`, `"`, `$`, a backtick or a backslash, and must not start with a YAML indicator character
 * (test/workflow-templates.test.mjs checks this). Job names must never equal a required check or a status context
 * (`checks`, `tests`, `risk-gate`, `merge-queue`, …): a job is a check run under that name.
 */
export const WORKFLOW_STRINGS = {
  zh: {
    setupNode: "准备 Node",
    installAiCli: "安装 AI CLI",
    // ci.yml
    ciInputPr: "合并队列正在验证的 PR 号（队列自动填）",
    ciInputBase: "比版本号用的基线提交（队列自动填：试合所基于的默认分支提交，或合入后补跑时合并前的提交）",
    forkGuard: "fork 来的 PR 不在自托管 runner 上跑",
    forkGuardError: "fork 来的 PR 不在自托管 runner 上跑，请从本仓库的分支提 PR。",
    detectReleaseJob: "判断是否发版",
    detectReleaseStep: "比较版本号与发版标签",
    detectFailed: "判断发版失败时直接判红",
    detectFailedError: "判断是否发版这一步没有成功，无法确认这是不是发版，按发版处理并判红。修好后重跑。",
    // risk-gate.yml / risk-gate-events.yml
    gateInputPr: "要重判的 PR 号（合并队列自动填）",
    classifyJob: "AI 第二分类器",
    classifyPrompt: "组提示词（经 API 取 diff 文本）",
    classifyRun: "AI 第二意见（不放行任何工具）",
    gateJob: "判定",
    gateJudge: "判定并写回状态、标签与说明评论",
    wakeQueue: "重判通过后叫醒合并队列",
    relayJob: "中转",
    relayStep: "交给默认分支上的风险门重判",
    relayMessage: "评审有动静，风险门会经 workflow_run 重判",
    // merge-queue.yml
    queueJob: "处理合并队列",
    queueRun: "测试并合并排在最前、已就绪的 PR",
    // nightly-review.yml
    sweepInputArea: "指定巡检范围（glob），不填按日期轮",
    sweepJob: "只读巡检",
    sweepPrompt: "组提示词（选定今晚的范围）",
    readOnlyWorkspace: "工作区设为只读",
    sweepRun: "AI 只读巡检",
    sweepFailed: "AI CLI 运行失败，今晚不开 issue",
    fileJob: "开 issue",
    fileIssues: "解析、校验、去重后开 issue",
    // review-eval.yml
    evalRunJob: "跑用例",
    fetchPrHeads: "取各 PR 的 head，取完删掉凭据",
    credentialsLeft: "checkout 留下的凭据没删掉，不跑 AI",
    evalRun: "逐个用例在只读检出里让 AI 评 diff",
    evalNoPrompt: "这个用例取 diff 或 head 失败",
    evalAiFailed: "这个用例的 AI CLI 运行失败",
    evalReportJob: "打分",
    evalScore: "打分并更新结果 issue",
    // review-metrics.yml
    metricsJob: "评审指标周报",
    metricsRun: "统计上周并写进周报 issue",
  },
  en: {
    setupNode: "Set up Node",
    installAiCli: "Install the AI CLI",
    // ci.yml
    ciInputPr: "PR the merge queue is verifying (filled in by the queue)",
    ciInputBase: "Base commit to compare version fields with (filled in by the queue; the default-branch commit the trial merge is based on, or the pre-merge commit for a run after merging)",
    forkGuard: "Fork PRs do not run on self-hosted runners",
    forkGuardError: "Fork PRs do not run on self-hosted runners. Open the PR from a branch of this repository.",
    detectReleaseJob: "Detect release",
    detectReleaseStep: "Compare version fields and the release label",
    detectFailed: "Fail when the release detection failed",
    detectFailedError: "The release detection did not succeed, so it is unknown whether this is a release. Failing closed. Fix it and re-run.",
    // risk-gate.yml / risk-gate-events.yml
    gateInputPr: "PR to re-judge (filled in by the merge queue)",
    classifyJob: "AI second classifier",
    classifyPrompt: "Build the prompt (diff text through the API)",
    classifyRun: "AI second opinion (no tools allowed)",
    gateJob: "Judge",
    gateJudge: "Judge and write back the status, label and comment",
    wakeQueue: "Wake the merge queue after a passing re-judge",
    relayJob: "Relay",
    relayStep: "Hand over to the risk gate on the default branch",
    relayMessage: "Review activity; the risk gate re-judges through workflow_run",
    // merge-queue.yml
    queueJob: "Process the merge queue",
    queueRun: "Test and merge the first ready PR",
    // nightly-review.yml
    sweepInputArea: "Area to sweep (a glob); empty means by date in turn",
    sweepJob: "Read-only sweep",
    sweepPrompt: "Build the prompt (pick tonight's area)",
    readOnlyWorkspace: "Make the workspace read-only",
    sweepRun: "Read-only AI sweep",
    sweepFailed: "The AI CLI failed; no issues tonight",
    fileJob: "File issues",
    fileIssues: "Parse, validate, dedupe and file issues",
    // review-eval.yml
    evalRunJob: "Run the cases",
    fetchPrHeads: "Fetch the PR heads, then drop the credentials",
    credentialsLeft: "The checkout credentials are still in the git configuration; not running the AI",
    evalRun: "Review each case's diff with the AI in a read-only checkout",
    evalNoPrompt: "Could not get the diff or head of this case",
    evalAiFailed: "The AI CLI failed on this case",
    evalReportJob: "Score",
    evalScore: "Score and update the report issue",
    // review-metrics.yml
    metricsJob: "Weekly review metrics",
    metricsRun: "Measure the last week and post to the report issue",
  },
};
