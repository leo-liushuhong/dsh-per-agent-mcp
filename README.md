# dsh-per-agent-mcp

[DSH](https://github.com/deepseek-ai/deepseek-harness) 插件：让每个 Agent 拥有**独立的 MCP 实例**（例如独立浏览器），解决多个 Agent 共享同一 MCP 连接导致的资源冲突。

> DeepSeek Harness (DSH) plugin: give every agent its own isolated MCP server instance (e.g. a dedicated browser), so concurrent agents no longer fight over one shared connection.

---

## 解决的问题（Why）

DSH 默认把 MCP 服务器作为**全局 Host 插件**加载——所有 Agent 共享同一个 MCP 连接。

- 对**无状态** MCP（如 `streamable-http` 的 API 类服务）这没问题，每次调用都是独立请求。
- 但对**有状态** MCP（如 Playwright 浏览器），这个「共享」就是冲突根源：
  - 所有 Agent 共享**同一个浏览器**
  - 共享**同一个「当前 tab」指针**（current tab 是浏览器进程内全局唯一的）

于是两个 Agent 并发操作浏览器时，会互相抢占 `current tab`——A 刚 `select` 自己的窗口，B 紧接着 `select` 走，A 的下一步 `snapshot`/`click` 就落到了 B 的窗口上（`ref not found`）。

本插件把「有状态 MCP 的对话隔离」做成通用能力：**每个 Agent 一个独立实例，天然互不干扰**。

---

## 原理（How）

DSH 本身已经内置了 per-agent 隔离机制，本插件只是把它「接线」到声明式 Agent 生命周期：

- `@deepseek-ai/dsh-scope` 提供 per-agent 作用域原语（「a tool registered through `agent.ctx` is visible only to that agent」）
- `@deepseek-ai/dsh-mcp-client` 本身按 `scopeOf(ctx)` 隔离 `serverName` 与工具注册（源码注释明确「Agent-scoped MCP servers may reuse a namespace in another Agent」）
- 但这两者只通过 **programmatic API**（`ctx.agents.create({ setup })`）暴露，**没有接上声明式/preset 启动的普通 Agent**

本插件在 `agent/created` 监听器里，对每个 Agent 执行：

```js
agent.ctx.plugin(McpClient, serverConfig)
```

从而在 **Agent 作用域**内动态挂载一个独立的 mcp-client 实例（独立的 MCP 子进程 / 浏览器）。生命周期完全自动：

| 阶段 | 行为 |
|------|------|
| Agent 创建 | `agent/created` → 挂载 per-agent MCP 实例 |
| Agent 运行 | 工具只对该 Agent 可见（scope 隔离） |
| Agent 销毁 | scope 自动 dispose → 关闭 transport → 释放 serverName |
| 插件卸载 | 主动 dispose 所有存活实例（防止泄漏） |

---

## 安装（Install）

1. 将本仓库 clone 到本地（或用 DSH 的插件市场添加本仓库地址）。
2. 在 DSH 的 **Plugins → Add plugin** 选择本地目录（本仓库根目录）。
3. 重启 DSH（MCP client 是 Host 插件，安装后需重启加载）。

---

## 配置（Configuration）

在 DSH 的 `cordis.patch.yml`（或插件配置）里声明需要 per-agent 隔离的服务器：

```yaml
config:
  servers:
    - serverName: playwright            # 有状态 → perAgent: true
      perAgent: true
      transport: stdio
      command: <node 可执行文件绝对路径>
      args:
        - <@playwright/mcp cli.js 绝对路径>
        - '--browser'
        - 'chrome'
        - '--isolated'                   # 内存 profile，进程退出即回收
        - '--idle-timeout'
        - '600000'                       # 空闲 10 分钟自动关浏览器，防泄漏
      startupTimeoutMs: 15000            # 防 MCP 挂起阻塞 Agent 创建
      failOnStartupError: false          # 启动失败只告警，不阻断 Agent
```

字段说明：

| 字段 | 含义 |
|------|------|
| `serverName` | MCP 命名空间（工具名 `mcp__<serverName>__*`），所有 Agent 可复用同名（靠 scope 隔离） |
| `perAgent` | `true` = 每个 Agent 独立实例；`false`/省略 = 保持全局共享 |
| `transport` | `stdio` 或 `streamable-http`（与 `dsh-mcp-client` 一致） |
| `startupTimeoutMs` | 连接超时上限，防止 MCP 子进程挂起时阻塞 Agent 创建 |
| `failOnStartupError` | `false` = 启动失败只记录日志，不阻断 Agent |

> 只有**有状态** MCP（Playwright 等）才需要 `perAgent: true`。无状态 API MCP（如你的云效 yunxiao）保持全局共享即可，天然无冲突，还能省资源。

---

## 适用性（Which MCP needs isolation）

| MCP 类型 | 例子 | 需要 per-agent？ |
|---------|------|-----------------|
| 有状态（stdio 长驻进程 + 浏览器） | Playwright | ✅ 需要（共享会抢 current tab） |
| 无状态（streamable-http API） | yunxiao、figma | ❌ 不需要（每次调用独立，共享无冲突） |

---

## 限制（Limitations）

1. **接入新 MCP 仍需配置 + 重启**：DSH 无运行时动态注册 MCP 的机制（MCP client 是 Host 插件），「接入」这个动作无法热加载；但接入后，per-agent 实例是**动态**创建/销毁的，之后无需再重启。
2. **登录态不跨 Agent 共享**：每个 Agent 的浏览器 profile 独立（`--isolated`），token 需各自注入。这是「隔离」的必然代价。
3. **资源占用**：N 个活跃 Agent = N 个浏览器进程。通过 `--idle-timeout` 空闲回收 + 只对有状态 MCP 开启 `perAgent` 来控制。

---

## 文件结构（Repository layout）

```
dsh-per-agent-mcp/
├── package.json          # bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml      # 声明 per-agent-mcp 插件 + 默认 servers 配置
├── index.js              # 插件实现（agent/created 挂载 mcp-client）
├── icon.svg              # 图标
├── locale/
│   ├── en.json           # 英文标题/描述
│   └── zh.json           # 中文标题/描述
└── docs/
    └── DETAIL.md         # 插件详情页文档
```

---

## License

MIT
