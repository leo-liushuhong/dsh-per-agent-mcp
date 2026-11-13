# Per-agent MCP isolation

## What it does

DSH loads MCP servers as shared Host plugins: every agent talks to the same
MCP connection. For a *stateful* server like Playwright, that means every agent
shares one browser and one "current tab" pointer, so concurrent agents keep
stealing the current tab from each other.

This plugin mounts a **separate MCP client instance on an agent's scoped
context** for any server marked `perAgent: true`. DSH's own `dsh-mcp-client`
already isolates tools and transports per `scopeOf(ctx)`; this plugin wires
that mechanism to the declarative agent lifecycle.

Subagents do **not** inherit their parent's scope (they join the parent's
preset scope), so isolation is the natural default.

## Mode switch

| mode | behavior |
|------|----------|
| `isolated` / `auto` (default) | every agent (root + subagent) mounts its own instance |
| `root-only` | only the root agent mounts; subagents never do |

`auto` behaves like `isolated`: every agent mounts its own MCP client instance
(so tools are scope-isolated per agent). The key property that makes this cheap
is that **the browser is lazy**: `@playwright/mcp` launches chrome only on the
first `browser_*` tool call. A pure-computation subagent that never touches the
browser costs no chrome process.

## Model-driven decision

The plugin injects a conflict-consequence notice into the system prompt:

- Every agent gets its own browser; a subagent never sees the parent's browser.
- The browser is lazy — chrome launches only on the first `browser_*` call.
- When delegating a subagent that must operate a browser, tell it to use the
  browser tools directly.
- If a subagent task is pure computation, instruct it NOT to use browser tools
  (that costs no chrome process).
- CONFLICT CONSEQUENCE: two agents must never share ONE browser instance, or
  they fight over the single "current tab" pointer — one agent's snapshot/click
  lands on the other's tab (ref not found).

That consequence statement is what lets the model decide, per delegation,
whether a subagent should touch the browser at all.

## Configuration

Edit the plugin row in `cordis.patch.yml`:

```yaml
config:
  mode: auto                       # isolated | root-only | auto
  servers:
    - serverName: playwright
      perAgent: true
      transport: stdio
      command: <node executable>
      args: [<playwright cli>, '--browser', 'chrome', '--isolated', '--idle-timeout', '600000']
      startupTimeoutMs: 15000
      failOnStartupError: false
```

- `mode` — `isolated` / `root-only` / `auto` (default `auto`; `auto` ==
  `isolated` with lazy-browser documentation).
- `perAgent: true` — isolate this server (only for stateful servers).
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
- "Shared browser" between a parent and a subagent is not a DSH capability:
  a subagent does not inherit its parent's scope. The resource-saving option is
  "the subagent never calls browser tools" (lazy browser = no chrome), not "it
  reuses the parent's browser".
