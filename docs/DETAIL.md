# Per-agent MCP isolation

## What it does

DSH loads MCP servers as shared Host plugins: every agent talks to the same
MCP connection. For a *stateful* server like Playwright, that means every agent
shares one browser and one "current tab" pointer, so concurrent agents keep
stealing the current tab from each other.

This plugin mounts a **separate MCP client instance on each agent's scoped
context** for any server marked `perAgent: true`. DSH's own `dsh-mcp-client`
already isolates tools and transports per `scopeOf(ctx)`; this plugin wires
that mechanism to the declarative agent lifecycle.

Each agent therefore gets its own MCP server process and, for Playwright, its
own browser and current-tab pointer. Lifecycle is automatic: the instance is
created when the agent is created and disposed when the agent is disposed.

## Configuration

Edit the plugin row in `cordis.patch.yml`:

```yaml
config:
  servers:
    - serverName: playwright
      perAgent: true
      transport: stdio
      command: <node executable>
      args: [<playwright cli>, '--browser', 'chrome', '--isolated', '--idle-timeout', '600000']
      startupTimeoutMs: 15000
      failOnStartupError: false
```

- `perAgent: true` — isolate per agent (only for stateful servers).
- `startupTimeoutMs` — bounds the connection so a hung server cannot block
  agent creation.
- `failOnStartupError: false` — a broken server logs instead of failing the
  agent.

Stateless `streamable-http` servers (e.g. an API-only MCP) should stay global;
do not mark them `perAgent`.

## Limitations

- Installing or changing the server list still requires a DSH restart to load
  the Host plugin; after that, per-agent instances are created dynamically.
- Login state is not shared between agents (each Playwright profile is
  isolated). Inject tokens per agent when needed.
