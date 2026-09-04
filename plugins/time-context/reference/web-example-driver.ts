#!/usr/bin/env node
/**
 * Two-turn driver over a shipped profile plus the time-context Web example
 * overlay: the first prompt carries a browser zone, the second does not.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [exampleOverlay, companionOverlay] = process.argv.slice(2)
if (exampleOverlay === undefined || companionOverlay === undefined) {
  throw new Error('time-context example driver requires example and companion overlay paths')
}

function onlyRootAgent(ctx: Context): Agent {
  const agents = ctx.get('agents')?.roots() ?? []
  const [agent] = agents
  if (agent === undefined || agents.length !== 1) {
    throw new Error(`fixture turn requires exactly one top-level agent, found ${agents.length}`)
  }
  return agent
}

async function followupTurn(ctx: Context, agent: Agent, text: string, source: Parameters<typeof createUserMessage>[0]['source']): Promise<void> {
  await agent.whenIdle()
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source,
  }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
}

const ctx = await bootProductionProfile({
  binName: 'time-context-web-example-e2e',
  profile: 'headless',
  overlayPaths: [
    resolveConfigPath(exampleOverlay, undefined),
    resolveConfigPath(companionOverlay, undefined),
  ],
})
try {
  const agent = onlyRootAgent(ctx)
  // Browser-originated prompt: the Web GUI attaches the validated IANA zone.
  await followupTurn(ctx, agent, 'first', {
    kind: 'user',
    rpcId: 'time-context-web-example-first',
    clientTimeZone: 'America/New_York',
  } as never)
  // Plain prompt: no zone provenance, so the example's timeZone fallback displays.
  await followupTurn(ctx, agent, 'second', { kind: 'user' })
} finally {
  await ctx.fiber.dispose()
}
