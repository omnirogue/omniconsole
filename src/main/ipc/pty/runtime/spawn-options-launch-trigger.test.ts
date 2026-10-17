// Latency telemetry: the trigger a runtime-controller spawn records on launch.process_spawn.
// Every main-internal launch (capacity-recovery successors, orchestration workers, session
// transfers, worktree-create startups, splits) reaches the provider through this builder,
// so it must record only the cause its caller named and 'unknown' otherwise, never 'cli'.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../provider/registry', () => ({ localProvider: {} }))
vi.mock('../../../providers/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
vi.mock('../host-env/fresh-spawn-routing', () => ({
  routesFreshSpawnsToLocalProvider: () => false,
  beginPtySpawnForWorktree: () => () => {}
}))

import {
  _resetLatencyTelemetryEnabledReaderForTests,
  setLatencyTelemetryEnabledReader
} from '../../../observability/latency-probe-switch'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'

async function spawnOptionsFor(args: Partial<RuntimePtySpawnArgs>) {
  const ctx = createRuntimePtySpawnState({} as never, {
    cols: 80,
    rows: 24,
    command: 'claude',
    worktreeId: 'repo-1::/tmp/wt-runtime',
    ...args
  })
  ctx.env = {}
  ctx.launchCommand = 'claude'
  await expect(buildRuntimePtySpawnOptions(ctx)).resolves.toBeNull()
  return ctx.spawnOptions
}

afterEach(() => {
  _resetLatencyTelemetryEnabledReaderForTests()
})

describe('runtime spawn launch trigger', () => {
  it('records unknown for a runtime spawn whose caller named no cause', async () => {
    const options = await spawnOptionsFor({})
    expect(options.launchTrigger).toBe('unknown')
    expect(options.launchVisible).toBe(false)
  })

  it('records the cause the terminal RPC named', async () => {
    expect((await spawnOptionsFor({ launchCause: { trigger: 'cli' } })).launchTrigger).toBe('cli')
    expect((await spawnOptionsFor({ launchCause: { trigger: 'mobile-wake' } })).launchTrigger).toBe(
      'mobile-wake'
    )
  })

  it('records nothing with the latencyTelemetry kill switch off', async () => {
    setLatencyTelemetryEnabledReader(() => false)
    const options = await spawnOptionsFor({ launchCause: { trigger: 'cli' } })
    expect(options).not.toHaveProperty('launchTrigger')
    expect(options).not.toHaveProperty('launchVisible')
  })
})
