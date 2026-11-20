/** doctor texts (zh/en, same keys). See messages/index.mjs. */

/** GitLab setup items (cli/apply-protection.mjs applyGitlab codes). */
const GITLAB_ZH = {
  "gitlab.branch": "默认分支的保护不对（应为：禁止推送、Maintainer 才能合并、禁止强推）",
  "gitlab.settings": "项目设置不对（流水线须成功、讨论须解决、带变量的流水线要 Maintainer）",
  "gitlab.approvals": "审批设置不对（推送后重置、作者与提交者不能批）",
  "gitlab.botToken": "没有机器人令牌变量 DEV_PROCESS_TOKEN",
  "gitlab.botTokenFlags": "DEV_PROCESS_TOKEN 不是受保护、遮蔽、限定 dev-process-bot 环境的变量",
  "gitlab.apiKey": "ANTHROPIC_API_KEY 不是受保护变量：分支流水线也能读到它",
  "gitlab.apiKeyMissing": "缺 ANTHROPIC_API_KEY 变量（受保护、遮蔽）：Claude 评审、分类器与夜间巡检都用它",
  "gitlab.trigger": "缺机器人的流水线触发器",
  "gitlab.schedule": "缺机器人的定时任务",
  "gitlab.webhook": "缺 webhook（MR、评论、流水线事件 → 触发器）：只能靠每 10 分钟的轮询",
  "gitlab.webhookBlocked": "实例拒绝了 webhook（自管 GitLab 默认不许访问本机地址）：请管理员在 管理 → 设置 → 网络 → 出站请求 里允许本地网络请求（或把本机加入白名单），再跑 apply-protection；之前只有每 10 分钟的轮询",
  "gitlab.humanMaintainers": "这些人是 Maintainer 或更高：在 Free 上他们能绕过门直接合并，降为 Developer（只让机器人合并）",
  "gitlab.mrPipelinesProtected": "项目允许 MR 流水线读受保护变量（protect_merge_request_pipelines）：关掉它，否则 MR 的代码可能拿到机器人令牌",
  "gitlab.jobTokenPush": "项目允许用作业令牌推送：关掉它（队列的临时分支流水线里，开发者代码拿的是机器人的作业令牌）",
  "gitlab.wildcardBranch": "有通配的受保护分支规则：17.11 上它可能让 MR 流水线读到受保护变量，改成具体分支名",
};
const GITLAB_EN = {
  "gitlab.branch": "The default branch's protection is wrong (wanted: no pushes, merges by Maintainers, no force push)",
  "gitlab.settings": "Project settings are wrong (pipelines must succeed, threads must be resolved, pipelines with variables need Maintainer)",
  "gitlab.approvals": "Approval settings are wrong (reset on push, no author or committer approval)",
  "gitlab.botToken": "No bot token variable DEV_PROCESS_TOKEN",
  "gitlab.botTokenFlags": "DEV_PROCESS_TOKEN is not a protected, masked variable scoped to environment dev-process-bot",
  "gitlab.apiKey": "ANTHROPIC_API_KEY is not protected: branch pipelines can read it",
  "gitlab.apiKeyMissing": "Missing the ANTHROPIC_API_KEY variable (protected, masked): the Claude review, the classifier and the nightly sweep use it",
  "gitlab.trigger": "Missing the bot's pipeline trigger",
  "gitlab.schedule": "Missing the bot's schedules",
  "gitlab.webhook": "Missing the webhook (MR, comment, pipeline events → the trigger): only the 10-minute poll moves things",
  "gitlab.webhookBlocked": "The instance refused the webhook (self-managed GitLab blocks requests to its own address by default): an admin allows requests to the local network (Admin → Settings → Network → Outbound requests, or allowlists this host), then re-run apply-protection; until then only the 10-minute poll moves things",
  "gitlab.humanMaintainers": "These people are Maintainer or above: on Free they can merge past the gate; make them Developers (only the bot merges)",
  "gitlab.mrPipelinesProtected": "MR pipelines may read protected variables (protect_merge_request_pipelines): turn it off, or MR code may get the bot token",
  "gitlab.jobTokenPush": "Job tokens may push: turn it off (in the queue's candidate pipelines developer code holds the bot's job token)",
  "gitlab.wildcardBranch": "A wildcard protected branch rule: on 17.11 it may hand MR pipelines protected variables; name branches explicitly",
};
const zh = {
  "doctor.ok": "检查通过",
  "doctor.header.local": "本地检查",
  "doctor.header.remote": "远端检查",
  "doctor.noVersion": "缺 .dev-process/VERSION：这个仓库不是用插件渲染的，或渲染没写完",
  "doctor.workflowMissing": (p) => `缺工作流 ${p.file}（按当前配置应当有它）`,
  "doctor.workflowExtra": (p) => `工作流 ${p.file} 还在，但按当前配置已经不需要了`,
  "doctor.engineEdited": (p) => `随包引擎被手改过：${p.files.slice(0, 5).join("、")}${p.files.length > 5 ? ` 等 ${p.files.length} 个` : ""}（升级时会冲突；要改流程请改配置或给插件提改动）`,
  "doctor.noLock": "缺渲染锁 .dev-process/render-lock.json：无法判断哪些文件被手改过",
  "doctor.rulesetMissing": (p) => `还没有启用分支保护（规则集 ${p.name}）：先开一个测试 ${p.pr} 看所有必过检查都能出结果，再跑 apply-protection`,
  "doctor.rulesetDisabled": (p) => `规则集 ${p.name} 存在但没有启用（enforcement=${p.enforcement}）`,
  "doctor.rulesetChecks": (p) => `规则集的必过检查与配置不一致：缺 ${p.missing.join("、") || "无"}；多 ${p.extra.join("、") || "无"}（重新跑 apply-protection）`,
  "doctor.secretMissing": (p) => `缺仓库密钥 ${p.name}（${p.why}）`,
  "doctor.secretUnknown": (p) => `查不了仓库密钥 ${p.name}（需要仓库管理员权限），请人工确认`,
  "doctor.why.claude": "Claude 评审、分类器、夜间巡检与用例集都用它",
  "doctor.claudeAppMissing": (p) => `组织 ${p.owner} 没装 Claude GitHub App：评审作业拿不到 App 的令牌，每次都会失败。到 https://github.com/apps/claude 安装（只选 ${p.repo} 也行）`,
  "doctor.claudeAppUnknown": (p) => `查不了组织 ${p.owner} 装了哪些 GitHub App（需要组织管理员），请人工确认 Claude GitHub App 已装到 ${p.repo}`,
  "doctor.remoteUnreachable": (p) => `连不上 ${p.repo}：${p.message}`,
  "doctor.gitlab.setup": (p) => `${GITLAB_ZH[p.code] ?? p.code}${p.params && Object.keys(p.params).length ? `（${JSON.stringify(p.params)}）` : ""}${p.action === "create" || p.action === "update" ? "：运行 apply-protection 补上" : ""}`,
  "doctor.gitlab.tokenExpiry": (p) => `机器人令牌 ${p.name} 还有 ${p.days} 天过期：到期后门、评审与队列全部停摆。轮换它（项目设置 → 访问令牌 → 轮换），再更新 DEV_PROCESS_TOKEN 变量`,

};

const en = {
  "doctor.ok": "All checks passed",
  "doctor.header.local": "Local checks",
  "doctor.header.remote": "Remote checks",
  "doctor.noVersion": "Missing .dev-process/VERSION: this repository was not rendered by the plugin, or the render did not finish",
  "doctor.workflowMissing": (p) => `Missing workflow ${p.file} (the current configuration needs it)`,
  "doctor.workflowExtra": (p) => `Workflow ${p.file} is still there, but the current configuration no longer needs it`,
  "doctor.engineEdited": (p) => `The vendored engine was edited by hand: ${p.files.slice(0, 5).join(", ")}${p.files.length > 5 ? ` and ${p.files.length - 5} more` : ""} (upgrades will conflict; change the configuration or the plugin instead)`,
  "doctor.noLock": "Missing the render lock .dev-process/render-lock.json: cannot tell which files were edited by hand",
  "doctor.rulesetMissing": (p) => `Branch protection is not enabled yet (ruleset ${p.name}): open a test ${p.pr}, see every required check report, then run apply-protection`,
  "doctor.rulesetDisabled": (p) => `Ruleset ${p.name} exists but is not active (enforcement=${p.enforcement})`,
  "doctor.rulesetChecks": (p) => `The ruleset's required checks don't match the configuration: missing ${p.missing.join(", ") || "none"}; extra ${p.extra.join(", ") || "none"} (re-run apply-protection)`,
  "doctor.secretMissing": (p) => `Missing repository secret ${p.name} (${p.why})`,
  "doctor.secretUnknown": (p) => `Cannot check repository secret ${p.name} (needs repository admin); please confirm by hand`,
  "doctor.why.claude": "used by the Claude review, the classifier, the nightly sweep and the review eval",
  "doctor.claudeAppMissing": (p) => `The Claude GitHub App is not installed on ${p.owner}: the review job cannot get the App's token and fails every time. Install it from https://github.com/apps/claude (selecting only ${p.repo} is enough)`,
  "doctor.claudeAppUnknown": (p) => `Cannot list the GitHub Apps installed on ${p.owner} (needs an organization admin); check by hand that the Claude GitHub App is installed on ${p.repo}`,
  "doctor.remoteUnreachable": (p) => `Cannot reach ${p.repo}: ${p.message}`,
  "doctor.gitlab.setup": (p) => `${GITLAB_EN[p.code] ?? p.code}${p.params && Object.keys(p.params).length ? ` (${JSON.stringify(p.params)})` : ""}${p.action === "create" || p.action === "update" ? ": run apply-protection" : ""}`,
  "doctor.gitlab.tokenExpiry": (p) => `The bot token ${p.name} expires in ${p.days} day(s): then the gate, the review and the queue all stop. Rotate it (project settings → Access tokens → Rotate) and update the DEV_PROCESS_TOKEN variable`,

};

export default { zh, en };
