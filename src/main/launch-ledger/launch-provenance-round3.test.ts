import { describe, expect, it } from 'vitest'
import {
  recordLaunch,
  findLaunchRecord,
  findLaunchHistory,
  flushLaunchLedger
} from './launch-ledger'
import { ledgerIdentifier } from './launch-ledger-identifiers'
import { registerLaunchLedgerTestDirectory } from './launch-ledger-test-directory'
import { rpcTerminalLaunchCause } from '../runtime/rpc/terminal-launch-cause'
import { createHash } from 'node:crypto'
const uuid = '11111111-1111-4111-8111-111111111111'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const readRows = registerLaunchLedgerTestDirectory()
describe('round three launch provenance', () => {
  it.each([
    `${uuid}::OPENAI_API_KEY=sk-example`,
    `${uuid}::/Users/private/secret-project`,
    `folder:/Users/private/secret-project`,
    `folder:${uuid}::/Users/private/secret-project`
  ])('never retains a path-bearing workspace id: %s', async (worktreeId) => {
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: uuid,
      worktreeId,
      cause: { trigger: 'cli' },
      hasStartupCommand: false,
      process: 'created'
    })
    await flushLaunchLedger()
    const rows = await readRows()
    expect(JSON.stringify(rows)).not.toContain(worktreeId.split('::').at(-1))
    expect(rows[0].worktreeId).toBe(ledgerIdentifier('worktreeId', worktreeId))
  })
  it.each(['create-1', 'x'.repeat(128), 'OPENAI_API_KEY=sk-example', '/private/path'])(
    'keeps opaque mutation correlation separately from the transport id: %s',
    (mutation) => {
      const cause = rpcTerminalLaunchCause({ requestId: uuid }, undefined, mutation)
      expect(cause).toEqual({
        trigger: 'cli',
        actor: { kind: 'local-cli' },
        requestId: uuid,
        clientMutationIdHash: hash(mutation)
      })
    }
  )
  it('keeps an opaque transport request id as a hash', () => {
    expect(rpcTerminalLaunchCause({ requestId: 'transport-1' })).toMatchObject({
      requestIdHash: hash('transport-1')
    })
  })
  it.each([
    'restore-interrupted',
    'hibernation-wake',
    'capacity-recovery',
    'automation',
    'orchestration-worker',
    'steward-resume',
    'outcome',
    'workflow',
    'coordinator-shell',
    'session-transfer',
    'session-handoff',
    'worktree-create',
    'worktree-background-terminals',
    'codex-pane-restart',
    'ssh-pane-recovery',
    'agent-team',
    'browser-lease',
    'mobile-wake',
    'paired-client'
  ])('cannot treat RPC reason %s or owner ids as host-derived', (trigger) => {
    expect(
      rpcTerminalLaunchCause({ requestId: uuid }, 'agent-session-create', 'create-1', {
        trigger,
        reference: { automationId: uuid }
      })
    ).toEqual({
      trigger: 'agent-session-create',
      claimedTrigger: trigger,
      claimedReferenceHashes: {
        automationId: `hash_${createHash('sha256').update(uuid).digest('hex').slice(0, 12)}`
      },
      actor: { kind: 'local-cli' },
      requestId: uuid,
      clientMutationIdHash: hash('create-1')
    })
  })
  it('keeps the original creation visible after an unfinished attachment', async () => {
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: uuid,
      cause: { trigger: 'automation' },
      hasStartupCommand: true,
      process: 'created'
    })
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: uuid,
      launchId: uuid,
      cause: { trigger: 'cli' },
      hasStartupCommand: false,
      process: 'prepared',
      intent: 'attach'
    } as never)
    expect(await findLaunchRecord({ ptyId: uuid })).toMatchObject({
      cause: 'automation',
      process: 'created'
    })
  })
})

describe('retained creation with later attachment history', () => {
  it('returns the created row first and lists subsequent attachment attempts after it', async () => {
    const first = {
      pipeline: 'runtime-controller',
      ptyId: uuid,
      cause: { trigger: 'automation' },
      hasStartupCommand: true,
      process: 'created',
      ts: '2026-10-03T00:00:00.000Z'
    } as const
    recordLaunch(first)
    recordLaunch({
      ...first,
      ts: '2026-10-03T01:00:00.000Z',
      launchId: uuid,
      process: 'attachment-intent',
      intent: 'attach',
      cause: { trigger: 'cli' }
    })
    const history = await findLaunchHistory({ ptyId: uuid })
    expect(history.launch).toMatchObject({ cause: 'automation', process: 'created' })
    expect(history.attachments).toEqual([
      expect.objectContaining({ process: 'attachment-intent', intent: 'attach', cause: 'cli' })
    ])
  })
  it('keeps free-text caller cause declarations only as claimed hashes', async () => {
    const claim = 'OPENAI_API_KEY=sk-example'
    const cause = rpcTerminalLaunchCause({ requestId: uuid }, 'terminal-create', 'create-1', {
      trigger: claim
    })
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: uuid,
      hasStartupCommand: false,
      process: 'created',
      cause
    })
    const row = (await readRows())[0]
    expect(row).toMatchObject({
      cause: 'terminal-create',
      claimedTriggerHash: hash(claim),
      requestId: uuid,
      clientMutationIdHash: hash('create-1')
    })
    expect(JSON.stringify(row)).not.toContain(claim)
  })
})

describe('current process incarnation history', () => {
  it('never presents the previous process start as the current one after a lost reply', async () => {
    const priorIncarnation = '22222222-2222-4222-8222-222222222222'
    const currentIncarnation = '33333333-3333-4333-8333-333333333333'
    const input = {
      pipeline: 'runtime-controller',
      ptyId: uuid,
      cause: { trigger: 'automation' },
      hasStartupCommand: true,
      process: 'created',
      incarnationId: priorIncarnation
    } as const
    recordLaunch(input)
    recordLaunch({
      ...input,
      incarnationId: undefined,
      process: 'unknown',
      cause: { trigger: 'cli' }
    })
    recordLaunch({
      ...input,
      incarnationId: currentIncarnation,
      process: 'attached',
      cause: { trigger: 'cli' }
    })
    const stored = await readRows()
    expect(stored[0]).toEqual({ v: 1, ts: expect.any(String), ...input, cause: 'automation' })
    expect(
      await findLaunchHistory({ ptyId: uuid, incarnationId: currentIncarnation } as never)
    ).toEqual({
      launch: null,
      currentStartUnrecorded: true,
      attachments: [stored[2]],
      previousCreations: [stored[0]]
    })
  })
  it('selects the current incarnation creation and keeps older creations as history', async () => {
    const input = {
      pipeline: 'runtime-controller',
      ptyId: uuid,
      cause: { trigger: 'automation' },
      hasStartupCommand: true,
      process: 'created',
      incarnationId: '22222222-2222-4222-8222-222222222222'
    } as const
    recordLaunch(input)
    recordLaunch({ ...input, incarnationId: uuid, cause: { trigger: 'cli' } })
    const stored = await readRows()
    expect(await findLaunchHistory({ ptyId: uuid, incarnationId: uuid } as never)).toEqual({
      launch: stored[1],
      previousCreations: [stored[0]]
    })
  })
})
