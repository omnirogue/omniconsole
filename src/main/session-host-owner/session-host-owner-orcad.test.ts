import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runtimeSessionHostProcess,
  runtimeSessionHostStatus,
  setRuntimeSessionHostProcessForTests
} from '../session-host/session-host-runtime'

afterEach(() => {
  setRuntimeSessionHostProcessForTests(null)
})

describe('orcad, a paired runtime with no window', () => {
  it('installs no owner executor at startup, so it advertises no session host control', () => {
    // Why the source: orcad's startup spawns a terminal daemon, so it cannot run in a unit test.
    const startup = readFileSync(join(__dirname, '..', 'orcad', 'orcad-entry.ts'), 'utf8')
    expect(startup).toContain('runtimeSessionHostProcess(runtime.getRuntimeId())')
    expect(startup).not.toMatch(/startSessionHostOwner|installExecutor/)
  })

  it('a runtime whose session host has no executor puts nothing in runtime.status', () => {
    runtimeSessionHostProcess('orcad-runtime-1')
    expect(runtimeSessionHostStatus('orcad-runtime-1')).toBeNull()
  })
})
