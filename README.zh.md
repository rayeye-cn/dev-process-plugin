# dev-process

一个 Claude Code 插件：给新仓库一次性装好 **Claude Code 团队式的开发与评审流程**。做法参照《How the Claude Code team does code review》（claude.dev，2026-10-15）：大多数改动最多只需要一个人参与就能合入，同时回滚率和事故率不能上升。

English: [README.md](README.md).

> **状态：1.1.3**（岗位代理，试点中）。能装到 GitHub（评审方用 GitHub Copilot 或 Claude）和 GitLab 17.11 及以上（评审方用 Claude），合并都用自建队列。有些路径还没有端到端跑过，最主要的是真实的 Claude 评审，见[验证情况](#验证情况)。

## 装上之后有什么

| 层 | 内容 |
| --- | --- |
| 提 PR 前 | `CLAUDE.md` 约定：跑检查并贴出输出；改动跑 `/code-review`，碰到敏感路径加跑 `/security-review`；PR 保持小；谁合入谁负责 |
| 每个 PR/MR 都有 AI 评审 | GitHub Copilot 代码评审，**或者** Claude（GitHub 上用 `anthropics/claude-code-action`，GitLab 上用 Claude CLI 作业），按仓库里的指令文件评审 |
| 风险门禁 | 一个必过检查：按改到的路径定风险档，AI 分档只能往高调、不能往低调。合入要满足四条：AI 评审过最新提交；作者签署；最新提交上有按档位要求的人工批准数；AI 提的每个讨论串都回过（`fixed:` / `wrong:` / `intended:` / `wontfix:`） |
| 合并队列 | 自建队列：先把改动放到最新的默认分支上重跑 CI，通过后再合入（GitHub 原生合并队列、GitLab 合并列车在计划中） |
| 分支保护 | 规则集 / 受保护分支**最后才开**：先让一个测试 PR 走通，再启用 |
| CI | 快检查放托管 runner；完整测试可以放自托管 runner；只给非 fork 的 PR 跑 |
| 回路 | 夜间 AI 巡检，发现问题自动开 issue；拿过去的 bug 回放，检验评审能不能抓到；每周出指标报告 |
| 发版与运维 | 分批推送文档、值班文档、事故复盘模板 |

## 支持范围

- **代码托管**：GitHub.com；GitLab 17.11 及以上（私有化部署或 gitlab.com；Free/CE、Premium、Ultimate，自动识别档位，生成的文档里写明每一档能强制哪些规则；设计见 `docs/design/gitlab.md`）。计划支持：GitHub Enterprise Server。
- **AI 评审**：GitHub Copilot，或者 Claude（GitHub：生成的工作流里跑 `anthropics/claude-code-action`，需要 `ANTHROPIC_API_KEY` 和 Claude GitHub App；GitLab：只读的 Claude Code 作业给出意见，由流程机器人代发）。
- **合并队列**：自建队列（GitLab 上用 GitLab 自己算的合并结果做试合）。计划支持：套餐允许时用 GitHub 原生合并队列，GitLab 用合并列车。
- **语言**：中文或英文，初始化时选。

## 安装

仓库是私有的：需要读权限，以及不弹提示就能用的 git 凭据（SSH agent，或 `gh auth setup-git`）。更新、固定版本、团队配置见 [docs/install.zh.md](docs/install.zh.md)。

```
/plugin marketplace add rayeye-cn/dev-process-plugin
/plugin install dev-process@dev-process-plugin
```

装好后，在要初始化的仓库里运行：`/dev-process:init`。

## 岗位代理（1.1，试点）

可选功能：每位参与者的电脑可以跑一个**岗位代理**。它是一个定时任务，领取指派给这个人、属于其岗位（产品、UI、研发、市场……）的 GitHub issue，用 Claude Code 干活，再交给下一个岗位。模型拿不到 GitHub 写权限，并在沙箱里运行；所有写操作由固定的运行器以本人身份完成。评审流程仍是人工关口：签署、批准、合并、发版、对外发布永远由人来做。每台电脑用 `/dev-process:agent` 设置；团队、岗位和交接规则写在 `.dev-process/team.json`。设计与目前实测过的安全检查见 [docs/design/agents.md](docs/design/agents.md)。目前只支持 GitHub；电脑可以是 macOS，也可以是 Windows（Windows 上只跑不运行命令的岗位，因为原生 Windows 没有沙箱）；已在一个测试仓库上完整跑通，接下来在正式仓库试点。

## 验证情况

所有路径都有单元测试（577 个），测试里的 API 返回是照各平台文档写的。端到端跑过的：

- **GitLab**（CE 19.6.1，Free，跑在 Docker 里）：一次性设置（`apply-protection`，重复跑不出错）、webhook → 触发器 → 风险门、没有 Key 时评审作业留通知、代发评审（意见挂在改动行上、总结带标记、文字里的快捷命令不执行）、豁免与批准、作者签署、回复 `wrong:` 后再点"已解决"、队列（用 GitLab 算的合并结果做候选、机器人身份跑 CI、按 sha 合入）、语义冲突被队列踢出、GitLab 自动改目标分支的串联 MR、升级流程本身的 MR、每周指标、`doctor --remote`。细节见 [docs/design/gitlab.md](docs/design/gitlab.md)。
- **GitHub**（私有沙盒仓库，Team 套餐）：初始化 PR 渲染并合入、规则集启用、没有 Key 时的通知被风险门引用、队列等风险门、改目标分支后 Claude 评审作业重跑且风险标签跟着变。

还没跑过的：

- 两个平台上的真实 Claude 评审、AI 分档、夜间巡检、用例集回放：测试环境里没有 Anthropic API Key。
- GitHub：一个 PR 完整过风险门并由队列合入（要真实评审和第二个账号）；Copilot 路径；Claude GitHub App 的实际行为。
- GitLab：19.6.1 以外的版本（尤其是 17.11 对 `TRIGGER_PAYLOAD` 的限制）、Premium 与 Ultimate（只有单元测试）、默认语言不是英文的实例。

## 路线图

- [x] M0 仓库骨架、清单文件、CI
- [x] M1 从参照实现中抽出引擎（GitHub、Copilot、中文）
- [x] M2 英文文案、双语模板、确定性渲染器，以及 `init`、`doctor`、`upgrade` 三个技能（GitHub + Copilot + 自建队列）
- [x] M3 GitHub 上的 Claude 评审（评审工作流、评审方适配器、通知）
- [~] M4 在 GitHub 沙盒仓库里做端到端验证（部分完成，见上）
- [x] M5 GitLab 全部档位（适配器、默认分支上的机器人流水线、Claude 评审作业、队列、设置、doctor；含用例集回放）
- [~] M6 在 GitLab 上做端到端验证（部分完成，见上）
- [x] M7 发布 v1.0.0
- [ ] 之后：需要 API Key 的几项实测；GitHub 原生合并队列；GitLab 合并列车与 Ultimate 外部状态检查；GitHub Enterprise Server

## 开发

```
npm test          # node:test，零依赖（Node ≥ 24）
npm run validate  # claude plugin validate --strict .
claude --plugin-dir .   # 只在当前这一次会话里加载插件
```

## 许可证

GPL-3.0-or-later，全文见 [LICENSE](LICENSE)。
