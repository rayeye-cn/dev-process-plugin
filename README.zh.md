# dev-process

一个 Claude Code 插件：给新仓库一次性装好 **Claude Code 团队式的开发与评审流程**。做法参照《How the Claude Code team does code review》（claude.dev，2026-10-15）：大多数改动最多只需要一个人参与就能合入，同时回滚率和事故率不能上升。

English: [README.md](README.md).

> **状态：预发布（M5）。** 已能装到 GitHub（评审方用 GitHub Copilot 或 Claude）和 GitLab 17.11 及以上（评审方用 Claude），合并都用自建队列。GitHub 已在沙盒仓库上部分验证（M4：Claude 评审相关场景等 API Key）；GitLab 按文档写的 API 做了单元测试，等端到端验证（M6）。原生合并队列与 GitLab 合并列车在后面。

## 装上之后有什么

| 层 | 内容 |
| --- | --- |
| 提 PR 前 | `CLAUDE.md` 约定：跑检查并贴出输出；改动跑 `/code-review`，碰到敏感路径加跑 `/security-review`；PR 保持小；谁合入谁负责 |
| 每个 PR/MR 都有 AI 评审 | GitHub Copilot 代码评审，**或者** Claude（GitHub 上用 `anthropics/claude-code-action`，GitLab 上用 Claude CLI 作业），按仓库里的指令文件评审 |
| 风险门禁 | 一个必过检查：按改到的路径定风险档，AI 分档只能往高调、不能往低调。合入要满足四条：AI 评审过最新提交；作者签署；最新提交上有按档位要求的人工批准数；AI 提的每个讨论串都回过（`fixed:` / `wrong:` / `intended:` / `wontfix:`） |
| 合并队列 | 能用原生功能就用：GitHub 原生合并队列，GitLab Premium 及以上用合并列车。都用不了就用自建队列：先把分支更新到最新，重跑 CI，通过后再合入 |
| 分支保护 | 规则集 / 受保护分支**最后才开**：先让一个测试 PR 走通，再启用 |
| CI | 快检查放托管 runner；完整测试可以放自托管 runner；只给非 fork 的 PR 跑 |
| 回路 | 夜间 AI 巡检，发现问题自动开 issue；拿过去的 bug 回放，检验评审能不能抓到；每周出指标报告 |
| 发版与运维 | 分批推送文档、值班文档、事故复盘模板 |

## 支持范围

- **代码托管**：GitHub.com；GitLab 17.11 及以上（私有化部署或 gitlab.com；Free/CE、Premium、Ultimate，自动识别档位，生成的文档里写明每一档能强制哪些规则；设计见 `docs/design/gitlab.md`）。计划支持：GitHub Enterprise Server。
- **AI 评审**：GitHub Copilot，或者 Claude（GitHub：生成的工作流里跑 `anthropics/claude-code-action`，需要 `ANTHROPIC_API_KEY` 和 Claude GitHub App；GitLab：只读的 Claude Code 作业给出意见，由流程机器人代发）。
- **合并队列**：自建队列（GitLab 上用 GitLab 自己算的合并结果做试合）。计划支持：套餐允许时用 GitHub 原生合并队列，GitLab 用合并列车。
- **语言**：中文或英文，初始化时选。

## 安装（发布后）

```
/plugin marketplace add rayeye-cn/dev-process-plugin
/plugin install dev-process@dev-process-plugin
```

装好后，在要初始化的仓库里运行：`/dev-process:init`。

## 路线图

- [x] M0 仓库骨架、清单文件、CI
- [x] M1 从参照实现中抽出引擎（GitHub、Copilot、中文）
- [x] M2 英文文案、双语模板、确定性渲染器，以及 `init`、`doctor`、`upgrade` 三个技能（GitHub + Copilot + 自建队列）
- [x] M3 GitHub 上的 Claude 评审（评审工作流、评审方适配器、通知）
- [ ] M4 在 GitHub 沙盒仓库里做端到端验证
- [x] M5 GitLab 全部档位（适配器、默认分支上的机器人流水线、Claude 评审作业、队列、设置、doctor；用例集回放暂未移植）
- [ ] M6 在 GitLab 上做端到端验证
- [ ] M7 发布 v1.0.0

## 开发

```
npm test          # node:test，零依赖（Node ≥ 24）
npm run validate  # claude plugin validate --strict .
claude --plugin-dir .   # 只在当前这一次会话里加载插件
```

## 许可证

GPL-3.0-or-later，全文见 [LICENSE](LICENSE)。
