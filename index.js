/**
 * dsh-per-agent-mcp
 *
 * Mounts a separate MCP client instance (and therefore a separate MCP server
 * process / browser) on each agent's scoped context. DSH's own mcp-client
 * already isolates tools and transports per `scopeOf(ctx)`; this plugin wires
 * that mechanism to the declarative agent lifecycle (`agent/created`).
 *
 * Subagents do NOT inherit their parent's scope (they join the parent's preset
 * scope via `composeFrom`), so isolation is the natural default. The `mode`
 * switch selects whether subagents also get a (lazy) browser.
 *
 * Each agent gets a UNIQUE persistent browser profile directory (a single
 * headed window, no extra blank window), so concurrent agents never fight over
 * a shared profile lock. The profile directory is cleaned up when the agent is
 * disposed and on plugin startup for stale leftovers.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm, readdir } from 'node:fs/promises'

export const inject = ['agents', 'loader', 'systemPrompt']

const PROFILE_PREFIX = 'dsh-pam-'

const CONFLICT_NOTICE = [
  'Browser / MCP isolation policy:',
  '- Every agent gets its OWN browser instance (no shared "current tab"); a subagent never sees the parent\'s browser.',
  '- The browser is lazy: chrome launches only when an agent actually calls a browser_* tool.',
  '- When you delegate a subagent that needs to operate a browser, tell it to use the browser tools directly.',
  '- If a subagent task is pure computation, instruct it NOT to use browser tools — that costs no chrome process.',
  '- CONFLICT CONSEQUENCE: two agents must never share ONE browser instance, or they fight over the single',
  '  "current tab" pointer — one agent\'s snapshot/click lands on the other\'s tab (ref not found).',
  '  Every agent therefore uses its own isolated instance.',
  '- Login state is NOT shared across agents. To reuse a login, pass the token/cookie as DATA (via a message),',
  '  not by sharing the browser instance.',
  '- Do not let two agents concurrently WRITE the same business resource; split responsibilities before delegating.',
  '- The browser may be unavailable if launch failed or chrome crashed; report the limitation in your reply.',
].join('\n')

function profileDirFor(agentId) {
  return join(tmpdir(), `${PROFILE_PREFIX}${agentId}`)
}

export function apply(ctx, config) {
  const servers = Array.isArray(config?.servers) ? config.servers : []
  const perAgent = servers.filter((s) => s && s.perAgent === true)
  // isolated: every agent (root + subagent) mounts its own instance.
  // root-only: only the root agent mounts; subagents never do.
  // auto: same as isolated (every agent mounts), with lazy-browser semantics.
  const mode = config?.mode === 'root-only' ? 'root-only' : (config?.mode === 'isolated' ? 'isolated' : 'auto')

  // agent id -> mounted fiber handles; plugin unload must dispose them because
  // unloading this plugin does not unwind registrations made on agent.ctx.
  const fibers = new Map()
  // agent id -> unique profile directory, cleaned up on disposal.
  const profileDirs = new Map()

  // Resolve the shipped mcp-client plugin object through the loader.
  let mcpClientPromise
  function getMcpClient() {
    mcpClientPromise ??= Promise.resolve()
      .then(() => ctx.loader.import('@deepseek-ai/dsh-mcp-client'))
      .then((ns) => ctx.loader.unwrapExports(ns))
    return mcpClientPromise
  }

  // Inject the conflict-consequence notice so the model can decide per delegation.
  ctx.systemPrompt.section({
    name: 'per-agent-mcp:conflict-notice',
    order: 11000,
    text: CONFLICT_NOTICE,
  })

  function isRoot(agent) {
    const subagents = ctx.get('subagents')
    if (subagents && typeof subagents.rootOf === 'function') {
      try { return subagents.rootOf(agent) === agent } catch { /* fall through */ }
    }
    const depth = agent?.session?.header?.delegationDepth
    return depth === undefined || depth === 0
  }

  // Remove stale profile directories left behind by a previous run (e.g. a
  // crash before the disposal cleanup ran). Only dirs without a live agent.
  async function cleanupStaleProfiles() {
    try {
      const entries = await readdir(tmpdir())
      const active = new Set(ctx.agents.list().map((a) => a.id))
      for (const name of entries) {
        if (!name.startsWith(PROFILE_PREFIX)) continue
        const agentId = name.slice(PROFILE_PREFIX.length)
        if (active.has(agentId)) continue
        await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => {})
      }
    } catch { /* best-effort */ }
  }

  // Build one server config with a per-agent unique --user-data-dir so the
  // browser uses a persistent (single-window) profile without a profile lock
  // conflict across concurrent agents.
  function serverFor(agent, base) {
    const userDataDir = profileDirFor(agent.id)
    profileDirs.set(agent.id, userDataDir)
    return { ...base, args: [...(Array.isArray(base.args) ? base.args : []), '--user-data-dir', userDataDir] }
  }

  async function mountAgent(agent) {
    if (fibers.has(agent.id)) return
    if (perAgent.length === 0) return
    const list = []
    try {
      const McpClient = await getMcpClient()
      for (const base of perAgent) {
        const fiber = agent.ctx.plugin(McpClient, serverFor(agent, base))
        list.push(fiber)
      }
      fibers.set(agent.id, list)
      await Promise.all(list.map((f) => (f && typeof f.await === 'function' ? f.await() : f)))
    } catch (error) {
      ctx.logger.warn(`per-agent-mcp: failed to mount servers for agent ${agent.id}: ${String(error)}`)
      for (const fiber of list) {
        try { void fiber?.dispose?.() } catch {}
      }
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    // root-only: subagents get no browser (the root operates it on their behalf).
    if (mode === 'root-only') {
      if (isRoot(agent)) await mountAgent(agent)
      return
    }
    // isolated and auto both mount every agent (root + subagent). The
    // @playwright/mcp browser is LAZY: chrome launches only on the first
    // browser_* tool call, so a pure-computation subagent that never touches
    // the browser costs no chrome process.
    // AWAIT is load-bearing: the agent loop holds queued input until every
    // `agent/created` listener settles, so the tools must be registered before
    // this listener resolves, or the first step assembles an empty tool set.
    await mountAgent(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    fibers.delete(agent.id)
    const dir = profileDirs.get(agent.id)
    profileDirs.delete(agent.id)
    if (dir) {
      // chrome closes asynchronously after the scope unwinds; delete the
      // profile directory a moment later, ignoring lock-file races.
      setTimeout(() => {
        rm(dir, { recursive: true, force: true }).catch(() => {})
      }, 3000)
    }
  })

  // Backfill declarative agents started before this plugin loaded.
  for (const agent of ctx.agents.list()) {
    if (mode === 'root-only' && !isRoot(agent)) continue
    void mountAgent(agent)
  }

  // Plugin unload: dispose every per-agent MCP instance we still own.
  ctx.effect(() => () => {
    for (const list of fibers.values()) {
      for (const fiber of list) {
        try { void fiber?.dispose?.() } catch {}
      }
    }
    fibers.clear()
  })

  // Best-effort startup cleanup of stale profiles from previous runs.
  void cleanupStaleProfiles()
}
