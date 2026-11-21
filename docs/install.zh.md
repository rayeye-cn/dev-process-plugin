# 团队安装 dev-process

English: [install.md](install.md)

## 谁需要装插件

只有在仓库里装流程、维护流程的人需要：他们会运行 `/dev-process:init`、`/dev-process:doctor` 和 `/dev-process:upgrade`。
仓库装好流程之后，运行时不依赖插件：引擎已经复制到 `.dev-process/engine`，其他人只要按 `CLAUDE.md` 和 PR / MR 模板里的规则做。

## 装之前

- Claude Code、Node 24 及以上、git。
- 对 `rayeye-cn/dev-process-plugin`（私有仓库）有读权限。
- **不弹提示就能用**的 git 凭据。Claude Code 运行 `git` 时关掉了交互提示，自己也不带令牌。二选一：
  - SSH：GitHub 的 key 已加载进 `ssh-agent`（不会问密码短语），`known_hosts` 里有 `github.com`；
  - HTTPS：先 `gh auth login`，再 `gh auth setup-git`。设置 `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` 可以跳过 SSH 尝试。

  自检：`git ls-remote https://github.com/rayeye-cn/dev-process-plugin`（或 `git@github.com:` 的写法）要能直接列出 ref，
  不问任何东西。
- 设置流程本身需要：GitHub 上 `gh` 以仓库管理员身份登录；GitLab 上一个 Maintainer 或 Owner 的令牌
  （技能里写了怎么传令牌，不会进对话）。

## 安装

在 Claude Code 里：

```
/plugin marketplace add rayeye-cn/dev-process-plugin
/plugin install dev-process@dev-process-plugin
```

或者在终端里：

```
claude plugin marketplace add rayeye-cn/dev-process-plugin
claude plugin install dev-process@dev-process-plugin
```

开一个新会话（或运行 `/reload-plugins`），然后在要装流程的仓库里运行 `/dev-process:init`。

想固定在某个版本：添加插件市场时带上 tag，写成 `rayeye-cn/dev-process-plugin#dev-process--v1.0.0`。

## 更新

这个插件市场的自动更新**默认关闭**。可以打开它（`/plugin` → Marketplaces → `dev-process-plugin` → auto-update；
后台更新同样需要不弹提示的凭据），也可以手动更新：

```
claude plugin marketplace update dev-process-plugin
claude plugin update dev-process@dev-process-plugin
```

然后重启 Claude Code。插件升级不会自动改动任何仓库：要在每个仓库里运行 `/dev-process:upgrade`，
用新版本重新渲染文件（它会先给出变更计划，再开 PR / MR）。

## 可选：在仓库里登记插件市场

想让每个用 Claude Code 打开这个仓库的人都能看到这个插件市场：在仓库里运行一次下面的命令，
把它写出的 `.claude/settings.json` 提交上去：

```
claude plugin marketplace add rayeye-cn/dev-process-plugin --scope project
```

写出来大致是这样（`autoUpdate` 可选）：

```json
{
  "extraKnownMarketplaces": {
    "dev-process-plugin": {
      "source": { "source": "github", "repo": "rayeye-cn/dev-process-plugin" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "dev-process@dev-process-plugin": true }
}
```

要注意两点：
- 只有信任了这个文件夹的人，这个插件市场才会被登记。
- 登记了也不会自动安装插件。每个人还要运行 `claude plugin install dev-process@dev-process-plugin --scope project`，
  或者用 `--scope user` 装一次，所有仓库都能用。

另外，`.claude/**` 在装好的流程里属于高风险路径，这次提交需要作者签署，再加一个人批准。

## 发布新版本（插件维护者）

`plugin.json` 里写了 `version`，所以**只有改了版本号的提交才会推给已安装的人**。每次发版：

1. 改 `.claude-plugin/plugin.json` 里的 `version`，不要在 `marketplace.json` 的条目里另写版本；在 `CHANGELOG.md` 里加一条。
2. 运行 `npm test` 和 `npm run validate`，然后提交、推送，等插件自己的 CI 通过。
3. 运行 `claude plugin tag --push`，创建并推送 `dev-process--v<版本号>`。

## 排错

- **添加插件市场或安装时克隆失败**：多半是上面的 git 自检过不了，或者 SSH key 要密码短语。先把凭据弄好；
  `/plugin` → Errors 里能看到最近一次的报错。
- **推送后提示 "already at the latest version"**：那次推送没有改 `version`。
- **提示 "Plugin "dev-process" is on in project settings but isn't installed here"**：
  用 `--scope project` 运行上面的 `install` 命令。
