/**
 * dsh-per-agent-mcp
 *
 * Mounts a separate MCP client instance (and therefore a separate MCP server
 * process / browser) on each agent's scoped context, so agents do not fight
 * over one shared connection. DSH's own mcp-client already isolates tools and
 * transports per `scopeOf(ctx)`; this plugin just wires that mechanism to the
 * declarative agent lifecycle (`agent/created`).
 *
 * Only servers marked `perAgent: true` are mounted per agent. Stateless
 * streamable-http servers (e.g. an API-only MCP) may stay global to save
 * resources.
 */

export const inject = ['agents', 'loader']

export function apply(ctx, config) {
  const servers = Array.isArray(config?.servers) ? config.servers : []
  const perAgent = servers.filter((s) => s && s.perAgent === true)

  // agent id -> mounted fiber handles; plugin unload must dispose them because
  // unloading this plugin does not unwind registrations made on agent.ctx.
  const fibers = new Map()

  // Resolve the shipped mcp-client plugin object through the loader, which
  // imports `name` specifiers from the dsh installation (a plain ESM import
  // cannot resolve packages inside app.asar).
  let mcpClientPromise

  function getMcpClient() {
    mcpClientPromise ??= Promise.resolve()
      .then(() => ctx.loader.import('@deepseek-ai/dsh-mcp-client'))
      .then((ns) => ctx.loader.unwrapExports(ns))
    return mcpClientPromise
  }

  async function mountAgent(agent) {
    if (fibers.has(agent.id)) return
    const list = []
    try {
      const McpClient = await getMcpClient()
      for (const server of perAgent) {
        const fiber = agent.ctx.plugin(McpClient, server)
        list.push(fiber)
      }
      fibers.set(agent.id, list)
      // Await each connection so the agent's first turn sees the tools.
      await Promise.all(list.map((f) => (f && typeof f.await === 'function' ? f.await() : f)))
    } catch (error) {
      ctx.logger.warn(`per-agent-mcp: failed to mount servers for agent ${agent.id}: ${String(error)}`)
      for (const fiber of list) {
        try { void fiber?.dispose?.() } catch {}
      }
    }
  }

  // New agents: mount during serial creation listeners (awaited before the
  // agent publishes), so tools are present before the first step.
  ctx.on('agent/created', async ({ agent }) => {
    await mountAgent(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    fibers.delete(agent.id)
  })

  // Declarative agents started before this plugin loaded are already live;
  // backfill them.
  for (const agent of ctx.agents.list()) {
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
}
