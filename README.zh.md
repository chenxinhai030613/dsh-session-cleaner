# dsh-session-cleaner · 会话清理（删除任务 / 一键清理已归档）

一个用于 DeepSeek Harness Web 界面的持久化插件（bundle）：为侧栏里的会话（也就是用户口语中的“任务”）补上官方刻意没有提供的**删除**能力，并把“删除全部已归档”做成一次确认即可完成的操作。

> DSH 官方目前只有「归档 / 取消归档」：归档只是把会话从分组界面隐藏，日志、投影缓存和归档记录都还在。`@deepseek-ai/dsh-session-persistence` 的文档也明确写着“无删除或保留接口，剪枝已存储会话属于带外后端维护”。本插件就是那个受控的带外维护入口。

## 界面

会话行菜单里多出一个删除入口（在「复制 Session ID」之后）：

![会话行菜单](docs/menu.png)

「仅显示已归档」视图里，已归档行同样有删除入口，标签变为「彻底删除会话…」：

![已归档会话行菜单](docs/menu-archived.png)

**删除全部已归档**在「设置 → 会话清理」里，包含归档计数、待删队列状态和一键删除按钮：

![设置中的会话清理](docs/settings.png)

单项删除的确认框：

![删除会话确认](docs/dialog-single.png)

一键删除全部已归档的确认框（列出前几个标题与总数）：

![删除全部已归档确认](docs/dialog-batch.png)

## 能做什么

| 入口 | 位置 | 行为 |
|---|---|---|
| 删除会话… / 彻底删除会话… | 每个会话行 `…` 菜单的最后 | 打开破坏性确认框，永久删除该会话 |
| 垃圾桶悬停按钮 | 每个会话行右侧（归档行也有） | 同上，少点一次 |
| 删除全部已归档（N）… | **设置 → 会话清理** | 一次确认删除**全部已归档会话**；普通会话不受影响 |

删除是**永久**的：确认后不提供撤销，也不进入回收站。

## 使用

1. 安装并启用 bundle `dsh-session-cleaner`（见下文“安装”）。
2. **删除单个会话**：在侧栏任意会话行上点 `…`，选「删除会话…」；已归档的行显示为「彻底删除会话…」。
3. **删除全部已归档**：打开「设置 → 会话清理」，核对归档计数后点「删除全部已归档（N）…」。
4. 确认框会写明影响范围（日志、投影缓存、侧栏/归档记录、子代理会话）和“无法撤销”。
5. 删除成功后底部提示会分别报告：已删除 / 安排到下次启动 / 仍在运行未删除 / 仅清理了残留引用 / 失败 的数量；设置页的计数与待删队列状态也会刷新。

## 删除到底删了什么

对每个被删除的会话，Host 半边会：

1. **会话日志**：删除 `$DSH_HOME/sessions/<项目目录>/<会话 id>/` 整个目录（JSONL 后端的所有代际日志）。
2. **投影缓存**：删除 `$DSH_HOME/storages/session_projcache/sessions/<会话 id>.json`（标题、轮次大纲、token 统计等缓存值）及其 `.bak.*`。
3. **Workspace 注册表引用**：通过公开的 `ctx.workspaceRegistry` 服务移除归档集、置顶集，以及各 Workspace 的 `sessionIds` 顺序中的该 id——**不会**在进程运行时直接改写 `workspace.json`，因此内存状态与磁盘状态保持一致。
4. **子代理会话**：读取持久化会话头，把 `origin: 'subagent'` 且祖先是该会话的子会话一并删除，避免留下看不见的孤儿数据。
5. 会话搜索（SQLite FTS 派生索引）会在下一次搜索时自动对账删除，不需要插件额外处理；附件存储是全局内容寻址并跨会话去重，**不会**删除，以免影响其他会话。

## 打开中 / 运行中的会话与分叉会话

DSH 的 **fork** 在 Host 里通过 `ctx.agents.create()` 创建子会话，但 `session/fork` 没有保存返回的 `AgentHandle`。结果是分叉出的子会话会作为“活会话”一直留在进程里（并持有 JSONL 写句柄），直到进程退出——这正是旧版插件“分叉会话删不掉、只能排到下次启动”的原因。

现在的删除流程：

- **仍有运行工作**（进行中的回合、子代理、后台任务、定时提醒）：直接拒绝并在提示中报告数量，避免静默截断工作。
- **没有运行工作、但仍是活会话**（典型就是分叉子会话、刚归档但尚未释放的会话）：通过 SessionStore / AgentRegistry 的 detach 原语释放该会话（触发 `session/disposed`，关闭持久化写句柄），等投影缓存写完最终检查点后再清一次缓存，然后立即删除日志、缓存与 Workspace 引用。
- **当前正在显示的会话**：浏览器半边先切到新会话（`uiWorkspace.startSession()`），再执行上述删除。若另一个窗口正打开同一个会话，删除会让那个窗口失效。
- 只有当运行时版本没有可用的 detach 原语、或 detach 后仍被占用时，才回退到 `$DSH_HOME/session-cleaner/pending.json`，在下次启动、任何浏览器连接之前清扫。

实际删除一个分叉子会话后的结果（立即删除、行消失、待删队列为空）：

![分叉会话立即删除](docs/fork-delete.png)

## 设计与实现

这是一个完整的 Cordis bundle，Host 与浏览器两个半边各司其职：

### Host 半边（`index.js`）

- 注入 `webServer`、`sessions`、`sessionPersistence`、`workspaceRegistry`。
- 在现有 Web server 上注册 `/session-cleaner/api` 前缀路由：
  - `POST /session-cleaner/api/status` → `{ archived, pending, lastSweep }` 权威归档集、待删队列与最近一次清扫诊断。
  - `POST /session-cleaner/api/probe` → 对指定（或队列中的）会话返回 `{ live, agent, activity, dir, known, canDetach }`，用于排查“为什么删不掉”。
  - `POST /session-cleaner/api/delete` → `{ ids: [...] }` 或 `{ scope: 'archived' }`；默认对无运行工作的活会话立即 detach + 删除，`deferLive: true` 可退回下次启动队列；返回逐会话状态与汇总计数。
  - `POST /session-cleaner/api/sweep` → 立即重试 pending 队列并返回逐会话结果。
- 路由带与 `/api` 网关一致的浏览器信任围栏（loopback/trusted Host、拒绝 `Sec-Fetch-Site: cross-site`、Origin 同源），不是认证层。
- 会话 id 先通过白名单校验，再用 JSONL 后端同款的 `encodeSegment` 转义；日志目录通过扫描 `sessions` 下的项目目录发现，**不接受**任何调用方传入的路径。
- 所有变更（删除、队列写入、清扫）串行执行；队列文件与诊断文件均以临时文件 + rename 原子替换。
- 启动后 800ms 执行一次 pending 清扫（此时任何浏览器都还没连接）；每次清扫结果写入 `$DSH_HOME/session-cleaner/last-sweep.json`。

### 浏览器半边（`client.js`）

- 纯浏览器插件，不新增依赖；只用平台提供的 `react` 与可选的 `@deepseek-ai/dsh-client-ui-primitives`（缺失时有降级实现）。
- 注册四个扩展点：
  - `sidebar.workspaces.session.menu.item`：删除会话（order 500，破坏性、带分隔线）。
  - `sidebar.workspaces.session.row.action`：行尾垃圾桶悬停按钮（order 300）。
  - `settings.section`：设置页的“会话清理”分区（order 40），承载归档计数、待删队列状态与“删除全部已归档”。
  - `shell.overlay`：确认对话框 + 结果提示。
- 归档集与归档标题由 `uiWorkspace.workspaces.list` / `uiWorkspace.sessions.list` 派生，不复制一份状态。
- 删除完成后调用 `ctx.sessions.refresh()` 重新拉取会话列表，行会立即消失，不需要刷新页面。

### 为什么不做“直接改 JSON”

`workspace.json` 与投影缓存都属于运行中的领域数据：绕过服务直接改写会与内存状态分叉，还会在下次写入时被覆盖。插件只删除“日志 / 每记录投影缓存文档”这类由后端按会话自有的磁盘产物，其余全部走公开服务。

## 安装

插件目录（本仓库工作区）：

```text
E:\dsh\session-cleaner
```

把它作为本地 bundle 链接进当前 profile（这里以 `desktop` 为例；Web 部署把 profile 换成 `web`）：

```powershell
cd C:\Users\<you>\.dsh\profiles\desktop
pnpm add link:E:/dsh/session-cleaner
```

然后把 `dsh-session-cleaner` 追加到该 profile `package.json` 的 `dsh.profile.bundles` 列表末尾，重启或等 HMR 重新组合后生效。插件管理页的「插件」列表应能看到“会话清理”。

## 配置（可选）

默认使用 `$DSH_HOME` 下的标准布局；只有当 profile 把 JSONL 存储或投影缓存挪到别处时才需要覆盖：

```yaml
- id: session-cleaner
  name: 'dsh-session-cleaner'
  config:
    sessionsRoot: 'D:\dsh-data\sessions'
    projectionCacheRoot: 'D:\dsh-data\storages\session_projcache\sessions'
```

## 已知限制

- **没有撤销 / 回收站**：确认即永久删除；这是刻意设计，破坏性操作必须只发生在明确确认之后。
- **对活会话的释放是“先 detach 再删除”**：分叉会话/打开中的空闲会话会在进程内被注销；如果另一个窗口正在查看它，该窗口在删除后失效。删除后若进程内仍有残留的循环对象，只会产生诊断日志，不会恢复数据。
- **运行中的会话不删除**：先停止它的工作（停止按钮 / 取消运行）或先归档，再删除。
- **不删除附件对象**：附件是跨会话内容寻址去重的，删除会影响其他会话。
- **不处理其他派生数据**：会话搜索索引在下一次搜索时自动对账移除；遥测/外部日志不在本地清理范围。
- **布局假设**：默认只识别 JSONL 后端按项目分目录的磁盘布局；自定义后端需要自行提供等价维护手段（可用上面的配置覆盖路径）。

## 验证

```powershell
cd E:\dsh\session-cleaner
node test/host-smoke.mjs     # Host：围栏、单个/批量删除、级联、延迟队列、活跃拒绝、启动清扫
node test/client-smoke.mjs   # 浏览器：槽位注册、菜单/按钮渲染、对话框、请求体、刷新、错误路径
```

两个冒烟测试都在临时目录中跑真实代码，不会触碰用户的会话数据。

此外，本插件在真实运行的 Desktop Host 上做过以下验证：

- **Host 路由**：`POST /session-cleaner/api/status` 返回真实归档集；向真实 JSONL 存储写入一对“父 + 子代理”临时会话后，通过路由删除父会话，返回 `deleted: [parent, child]`，两个目录都从磁盘消失，归档集计数不变。
- **分叉会话立即删除（本次修复的核心）**：在真实 GUI 中分叉一个已有会话，再通过行菜单删除分叉出的子会话；返回立即删除（无 pending 队列），子会话行消失，日志目录与投影缓存均不存在。修复前该子会话会报“已安排在下次启动时删除”。
- **积压队列清扫**：修复前遗留的 5 个分叉会话（4 个已归档）在下一次插件重载/启动清扫中被全部 detach + 删除，`last-sweep.json` 记录 5 条 `deleted`，归档计数从 7 降为 3，Workspace 注册表与投影缓存均无残留。
- **浏览器界面**：以带签名的浏览器会话 Cookie 在无头 Edge 中加载真实 GUI；会话行菜单、「设置 → 会话清理」、批量确认框均正常渲染，取消后关闭（对应 `docs/` 下的截图）。
- **HMR**：在 Desktop 应用不重启的情况下，profile 重新组合后插件 Host 路由、清扫逻辑与浏览器 bundle 均立即生效。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：路由、删除核心、活会话 detach、级联、延迟队列、诊断与清扫 |
| `client.js` | 浏览器半边：会话行删除菜单、悬停按钮、设置分区、确认框、结果提示 |
| `cordis.patch.yml` | 把 Host 行插入 profile 的 Loader patch |
| `locale/zh.json`、`locale/en.json` | 插件管理页中的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/host-smoke.mjs`、`test/client-smoke.mjs` | 无浏览器 / 无真实 DSH 的冒烟测试 |
