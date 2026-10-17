import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { rpcTerminalLaunchCause } from '../runtime/rpc/terminal-launch-cause'
import { resolveIpcSpawnLaunchCause } from '../ipc/pty/ipc/spawn-launch-attribution'
import {
  noteLaunchTriggerHint,
  _resetLaunchTriggerHintsForTests
} from '../observability/launch-trigger-hints'
import { findLaunchRecord, recordLaunch } from './launch-ledger'
import { registerLaunchLedgerTestDirectory } from './launch-ledger-test-directory'
const rows = registerLaunchLedgerTestDirectory()
const id = '11111111-1111-4111-8111-111111111111'
const hash = (value: string) =>
  `hash_${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
afterEach(_resetLaunchTriggerHintsForTests)
describe('caller declarations remain private claims', () => {
  it.each(['agent-session-resume', 'cli', 'new', 'dashboard-popout'] as const)(
    'RPC cannot relabel terminal.create as %s',
    (trigger) => {
      expect(rpcTerminalLaunchCause({}, 'terminal-create', undefined, { trigger })).toEqual({
        trigger: 'terminal-create',
        claimedTrigger: trigger,
        actor: { kind: 'local-cli' }
      })
    }
  )
  it.each(['capacity-recovery', 'automation', 'new', 'session-resume'] as const)(
    'renderer cannot assert %s or readable owners',
    async (trigger) => {
      const cause = resolveIpcSpawnLaunchCause({
        hasLaunchCommand: true,
        launchTrigger: trigger,
        launchReference: {
          automationId: id,
          consoleJobId: 'job_privateprompttext',
          sessionPrepBatchId: 'sp_secretpassword'
        }
      })
      recordLaunch({
        pipeline: 'renderer-ipc',
        ptyId: id,
        hasStartupCommand: true,
        process: 'created',
        cause
      })
      expect(await rows()).toMatchObject([
        {
          cause: 'renderer-spawn',
          claimedTrigger: trigger,
          claimedReferenceHashes: {
            automationId: hash(id),
            consoleJobId: hash('job_privateprompttext'),
            sessionPrepBatchId: hash('sp_secretpassword')
          }
        }
      ])
      expect(cause.reference).toBeUndefined()
      const serialized = JSON.stringify(await rows())
      expect(serialized).not.toContain('privateprompttext')
      expect(serialized).not.toContain('secretpassword')
    }
  )
  it('hashes every caller owner value even if its format looks accepted', () => {
    const reference = {
      consoleJobId: 'job_privateprompttext',
      sessionPrepBatchId: 'sp_secretpassword',
      orchestrationTaskId: 'task_0123456789ab',
      automationId: id
    }
    const cause = rpcTerminalLaunchCause({}, 'terminal-create', undefined, {
      trigger: 'automation',
      reference
    })
    expect(cause.reference).toBeUndefined()
    expect(cause.claimedReferenceHashes).toEqual(
      Object.fromEntries(Object.entries(reference).map(([key, value]) => [key, hash(value)]))
    )
  })
  it('keeps main reserved automation evidence authoritative', () => {
    noteLaunchTriggerHint({
      tabId: id,
      trigger: 'automation',
      launchCause: { trigger: 'automation', reference: { automationId: id, automationRunId: id } }
    })
    expect(
      resolveIpcSpawnLaunchCause({
        tabId: id,
        hasLaunchCommand: true,
        launchTrigger: 'capacity-recovery'
      })
    ).toMatchObject({
      trigger: 'automation',
      reference: { automationId: id, automationRunId: id },
      claimedTrigger: 'capacity-recovery'
    })
  })
})

describe('private claimed references on retained legacy records', () => {
  it('new appends and rereads expose only hashes for legacy claimedReference values', async () => {
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: id,
      process: 'created',
      hasStartupCommand: false,
      cause: {
        trigger: 'terminal-create',
        claimedReference: {
          consoleJobId: 'job_privateprompttext',
          sessionPrepBatchId: 'sp_secretpassword'
        }
      }
    })
    const row = (await rows())[0]
    expect(row).not.toHaveProperty('claimedReference')
    expect(row.claimedReferenceHashes).toEqual({
      consoleJobId: hash('job_privateprompttext'),
      sessionPrepBatchId: hash('sp_secretpassword')
    })
    expect(await findLaunchRecord({ ptyId: id })).toEqual(row)
  })
  it.each(['dispatched', 'failed'])('a run in %s cannot promote a renderer claim', (status) => {
    expect(
      resolveIpcSpawnLaunchCause(
        {
          hasLaunchCommand: true,
          launchTrigger: 'automation',
          launchReference: { automationId: id, automationRunId: id }
        },
        {
          listAutomationRuns: () => [{ id, automationId: id, status }]
        } as never
      )
    ).toMatchObject({
      trigger: 'renderer-spawn',
      claimedTrigger: 'automation',
      claimedReferenceHashes: { automationId: hash(id), automationRunId: hash(id) }
    })
  })
})
