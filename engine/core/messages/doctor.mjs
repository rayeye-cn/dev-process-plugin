/** doctor texts (zh/en, same keys). See messages/index.mjs. */
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
};

export default { zh, en };
