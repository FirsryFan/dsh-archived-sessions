# dsh-archived-sessions

DeepSeek Harness Web UI「归档会话管理」插件（bundle：host 路由 + 客户端设置页）。

> English: archived-session management for the DeepSeek Harness Web UI — lists
> archived sessions per workspace under Settings, with restore / permanent
> delete, plus a per-row delete button in the sidebar.

## 功能

- **设置 → 归档会话**：按工作区列出所有已归档会话（含未分组），每条会话提供
  - **恢复**：把会话从注册表级归档集合中移出，恢复其在侧边栏的显示（保留原工作区席位）；
  - **删除**：彻底删除 —— 先做记账清理（从工作区摘除 + 移出归档集合），最后删除日志目录
    （`$DSH_HOME/sessions/<项目>/<sessionId>/`）。运行中的会话拒绝删除；
    **已被本进程打开（加载在内存中）的会话也拒绝删除**——DSH 平台没有卸载已加载会话
    的接口，删日志会在侧栏留下"幽灵"行；重启 DSH 后该类会话变为未加载状态即可删除。
    对已删除的会话重试会直接成功（完成残留记账清理），不再报"会话不存在"。
- **左栏直接删除**：每个会话行（hover）出现垃圾桶按钮，确认后彻底删除该会话；
  若删除的是当前打开的会话，会自动跳回"新建会话"。
- 在 **设置 → 插件 → 第三方插件** 中以 `archived-sessions` 列出（由
  dsh-thirdparty-settings 管理），其「设置」按钮直接导航到 设置 → 归档会话。

## 实现说明

- Host 半部（`index.js`）注册两个包内 HTTP 路由（`ctx.webServer.register`）：
  - `POST /thirdparty/archived-sessions/unarchive`：通过 workspace 域的
    `domain.global.set` 持久化移除归档 id；因为与 WorkspaceRegistry 共享同一
    内存 state 对象，注册表缓存同步更新，`domain/changed` → `host/archived-sessions-changed`
    帧会立即推送给所有客户端。
  - `POST /thirdparty/archived-sessions/delete`：记账清理（`workspaceRegistry`
    摘除 + 归档集合移除）先行、日志目录删除殿后；运行中（`agent.status === 'running'`）
    或已加载（在内存 store 中）的会话返回 409，日志已不存在的重试直接成功。
- Client 半部（`client.js`）：
  - `settings.section` 注册项 `archived-sessions`（nav「归档会话」）；
  - 通过 `window.__DSH_THIRDPARTY__.register()` 挂入第三方插件管理器；
  - 用 MutationObserver 给左栏会话行注入删除按钮（按行标题解析会话 id）。

## 安装

**从 GitHub（推荐，供所有 DSH 使用者）：**

```bash
# 在 profile 目录执行（会自动追加到 dsh.profile.bundles）
dsh plugin --profile web add github:FirsryFan/dsh-archived-sessions
```

然后**重启 DSH**。建议同时安装 `dsh-thirdparty-settings`
（`dsh plugin --profile web add github:FirsryFan/dsh-thirdparty-settings`），
以在 设置 → 插件 → 第三方插件 中获得统一的设置入口。

**本地开发**：加入 `$DSH_HOME/profiles/<profile>/package.json` 的 `dependencies`
（`"dsh-archived-sessions": "link:D:\\dsh\\plugins\\dsh-archived-sessions"`）与
`dsh.profile.bundles`（排在 `dsh-thirdparty-settings` 之后），然后 `pnpm install`
并**重启 DSH**。

## License

MIT
