import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionProviderHandleKey } from '../../shared/agent-session-provider-handle'
import { isAgentSessionRecord, type AgentSessionRecord } from '../../shared/agent-session-record'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCodexCommand, withCliRuntimeOnPath } from '../codex-cli/command'
import { queuePeerInboxCodexHint, type PeerInboxCodexQueueInput } from './peer-inbox-codex-queue'
import { admitsPeerInboxCodexSqliteRouting } from './peer-inbox-codex-sqlite-routing'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot'
import { codexQueueHomeFromOpenFiles, queueCodexTerminalNotice } from './codex-terminal-queue'
import type { TerminalAgentProcessProof } from '../../shared/pty-agent-process-evidence'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../../shared/process-table-snapshot', () => ({ getFreshProcessTableSnapshot: vi.fn() }))
vi.mock('./peer-inbox-codex-sqlite-routing', () => ({ admitsPeerInboxCodexSqliteRouting: vi.fn() }))
vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: vi.fn(),
  withCliRuntimeOnPath: vi.fn((_command, env) => env)
}))

const THREAD = '019a2152-ea25-72c4-b13c-826e98410ed2'
const NEXT_THREAD = '019a2152-ea25-72c4-b13c-826e98410ed3'
const NONCE = '019a2152-ea25-72c4-b13c-826e98410ed4'
const ITEM = '019a2152-ea25-72c4-b13c-826e98410ed5'
const CODEX = resolve('test-bin', 'codex')
const PROFILE = resolve('test-profile', 'codex-work')
const HINT = `Peer inbox work is available for your enrolled task.\nReceiver nonce: ${NONCE}`
const SUCCESS = {
  code: 0,
  signal: null,
  stdout: `Queued message ${ITEM} for thread ${THREAD}.\n`,
  stderr: '',
  timedOut: false
} as const

function record(): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId: 'test-session',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-a',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    providerHandleChain: [
      {
        linkId: 'head',
        handle: { provider: 'codex', threadId: THREAD },
        origin: 'adopted',
        mintedAtFence: 3,
        observedAt: 100
      }
    ],
    accountHome: { variable: 'CODEX_HOME', path: PROFILE },
    lease: {
      sessionId: 'test-session',
      runtimeKind: 'tui',
      runtimeFence: 3,
      handoffStage: null,
      provenHandleLinkId: 'head',
      ownerProcess: { hostId: 'local', pid: 123, processStartTimeMs: 100, spawnToken: 'owner' },
      reservedSpawnToken: null,
      leaseDeadlineAt: 200,
      lastRenewedAt: 100,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'key',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 100,
    updatedAt: 100
  }
}

function input(overrides: Partial<PeerInboxCodexQueueInput> = {}): PeerInboxCodexQueueInput {
  return { record: record(), threadId: THREAD, hint: HINT, correlationNonce: NONCE, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveCodexCommand).mockReturnValue(CODEX)
  vi.mocked(admitsPeerInboxCodexSqliteRouting).mockReturnValue(true)
  vi.mocked(runProcess).mockResolvedValue({ ...SUCCESS })
})

describe('queuePeerInboxCodexHint', () => {
  const proof: TerminalAgentProcessProof = {
    pid: 123,
    rootPid: 100,
    pgid: 123,
    startTimeMs: 100,
    agent: 'codex',
    ptyId: 'pty',
    incarnationId: 'incarnation',
    via: 'command-line'
  }
  const rows = [
    { pid: 123, ppid: 100, stat: 'S+', command: 'node /usr/local/bin/codex' },
    { pid: 124, ppid: 123, stat: 'S+', command: '/usr/local/bin/codex' }
  ]
  const openFiles = (home: string) =>
    `p124\nn${home}/thread-writer-locks/${THREAD}.lock\nn${home}/queue_1.sqlite\n`

  it.skipIf(process.platform === 'win32')(
    'binds the queue to the live terminal writer, not another account or child process',
    () => {
      expect(codexQueueHomeFromOpenFiles(openFiles(PROFILE), THREAD, proof, rows)).toBe(PROFILE)
      expect(codexQueueHomeFromOpenFiles(openFiles(PROFILE), NEXT_THREAD, proof, rows)).toBeNull()
      expect(
        codexQueueHomeFromOpenFiles(
          openFiles(PROFILE).replace('queue_1.sqlite', 'state_5.sqlite'),
          THREAD,
          proof,
          rows
        )
      ).toBeNull()
      expect(
        codexQueueHomeFromOpenFiles(openFiles(PROFILE), THREAD, proof, [{ ...rows[1]!, ppid: 999 }])
      ).toBeNull()
      expect(
        codexQueueHomeFromOpenFiles(openFiles(PROFILE), THREAD, proof, [
          { ...rows[1]!, stat: 'T+' }
        ])
      ).toBeNull()
      expect(
        codexQueueHomeFromOpenFiles(
          openFiles(PROFILE) + openFiles(PROFILE + '-other').replace('p124', 'p125'),
          THREAD,
          proof,
          [...rows, { ...rows[1]!, pid: 125 }]
        )
      ).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the observed account queue for an ordinary terminal and persists before enqueue',
    async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-queue-binding-')))
      writeFileSync(join(home, 'queue_1.sqlite'), '')
      const prepare = vi.fn(() => true)
      const assertCurrent = vi.fn(async () => {})
      const call = {
        terminal: {
          handle: 'h',
          tabId: 't',
          leafId: 'l',
          ptyId: 'pty',
          connected: true,
          executionHostId: 'local' as const
        },
        proof,
        threadId: THREAD,
        hint: HINT,
        correlationNonce: NONCE,
        prepare,
        assertCurrent
      }
      vi.mocked(getFreshProcessTableSnapshot).mockResolvedValue(rows)
      vi.mocked(runProcess).mockImplementation(async (args) => {
        if (args.args?.includes('pn')) {
          return { ...SUCCESS, stdout: openFiles(home) }
        }
        expect(prepare).toHaveBeenCalledOnce()
        expect(assertCurrent).toHaveBeenCalledTimes(2)
        expect(args.args).toEqual([
          'queue',
          '-c',
          `sqlite_home=${JSON.stringify(home)}`,
          '--thread',
          THREAD,
          '--message',
          HINT
        ])
        expect(args.env?.CODEX_HOME).toBe(home)
        return { ...SUCCESS }
      })
      try {
        expect(await queueCodexTerminalNotice(call)).toMatchObject({
          status: 'queued',
          nativeItemId: ITEM
        })
        vi.mocked(runProcess).mockClear()
        expect(
          await queueCodexTerminalNotice({
            ...call,
            terminal: { ...call.terminal, executionHostId: 'ssh:remote' }
          })
        ).toMatchObject({ status: 'not-started' })
        expect(runProcess).not.toHaveBeenCalled()
        assertCurrent.mockRejectedValueOnce(new Error('replacement process'))
        expect(await queueCodexTerminalNotice(call)).toMatchObject({ status: 'not-started' })
        expect(runProcess).not.toHaveBeenCalled()
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it('queues only the exact bound thread in the bound profile and returns native acceptance', async () => {
    const signal = new AbortController().signal
    const bound = record()
    bound.launchArgs = ['--dangerously-bypass-approvals-and-sandbox']
    bound.options = { model: 'must-not-use' }
    const prior = process.env.CODEX_HOME
    process.env.CODEX_HOME = 'must-not-use-ambient-profile'
    try {
      expect(await queuePeerInboxCodexHint(input({ record: bound, signal }))).toEqual({
        status: 'queued',
        nativeItemId: ITEM
      })
      expect(runProcess).toHaveBeenCalledExactlyOnceWith({
        program: CODEX,
        args: ['queue', '--thread', THREAD, '--message', HINT],
        env: expect.objectContaining({ CODEX_HOME: PROFILE }),
        signal,
        timeoutMs: 5000,
        maxOutputBytes: 4096
      })
      expect(withCliRuntimeOnPath).toHaveBeenCalledWith(
        CODEX,
        expect.objectContaining({ CODEX_HOME: PROFILE })
      )
    } finally {
      if (prior === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = prior
      }
    }
  })

  it('refuses unverified SQLite routing before resolving or invoking the queue', async () => {
    vi.mocked(admitsPeerInboxCodexSqliteRouting).mockReturnValue(false)
    expect(await queuePeerInboxCodexHint(input())).toEqual({
      status: 'not-started',
      reason: 'sqlite-routing-unverifiable'
    })
    expect(resolveCodexCommand).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  const invalidBindings: [string, (record: AgentSessionRecord) => void][] = [
    [
      'remote location',
      (r) => {
        r.location.executionHostId = 'ssh:other'
      }
    ],
    [
      'remote owner',
      (r) => {
        r.lease.ownerProcess!.hostId = 'runtime:other'
      }
    ],
    [
      'WSL',
      (r) => {
        r.location.wslDistro = 'Ubuntu'
      }
    ],
    [
      'native owner',
      (r) => {
        r.lease.runtimeKind = 'native'
      }
    ],
    [
      'unreconciled',
      (r) => {
        r.lease.unreconciled = true
      }
    ],
    [
      'handoff',
      (r) => {
        r.lease.handoffStage = 'preparing'
      }
    ],
    [
      'released claim',
      (r) => {
        r.lease.claimStatus = 'released'
      }
    ],
    [
      'reserved claim',
      (r) => {
        r.lease.claimStatus = 'reserved'
      }
    ],
    [
      'missing process',
      (r) => {
        r.lease.ownerProcess = null
      }
    ],
    [
      'wrong profile variable',
      (r) => {
        r.accountHome.variable = 'CLAUDE_CONFIG_DIR'
      }
    ],
    [
      'relative profile',
      (r) => {
        r.accountHome.path = '.codex'
      }
    ],
    [
      'NUL in profile',
      (r) => {
        r.accountHome.path = `${PROFILE}\0`
      }
    ],
    [
      'unproven head',
      (r) => {
        r.lease.provenHandleLinkId = 'old-head'
      }
    ],
    [
      'stale head fence',
      (r) => {
        r.providerHandleChain[0]!.mintedAtFence = 2
      }
    ],
    [
      'other provider',
      (r) => {
        r.provider = 'claude'
      }
    ],
    [
      'mismatching thread',
      (r) => {
        r.providerHandleChain[0]!.handle = { provider: 'codex', threadId: NEXT_THREAD }
      }
    ],
    [
      'malformed record',
      (r) => {
        r.schemaVersion = 1 as 2
      }
    ]
  ]

  it.each(invalidBindings)('rejects %s before spawning', async (_name, mutate) => {
    const bound = record()
    mutate(bound)
    expect(await queuePeerInboxCodexHint(input({ record: bound }))).toEqual({
      status: 'not-started',
      reason: 'invalid-binding'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('does not use an earlier chain entry that matches the requested thread', async () => {
    const bound = record()
    bound.providerHandleChain.push({
      ...bound.providerHandleChain[0]!,
      linkId: 'new-head',
      origin: 'forked',
      forkedFromKey: agentSessionProviderHandleKey(bound.providerHandleChain[0]!.handle),
      handle: { provider: 'codex', threadId: NEXT_THREAD }
    })
    bound.lease.provenHandleLinkId = 'new-head'
    expect(isAgentSessionRecord(bound)).toBe(true)
    expect(await queuePeerInboxCodexHint(input({ record: bound }))).toMatchObject({
      status: 'not-started'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('refuses a named thread even when it is the proven record head', async () => {
    const bound = record()
    bound.providerHandleChain[0]!.handle = { provider: 'codex', threadId: 'named-thread' }
    expect(isAgentSessionRecord(bound)).toBe(true)
    expect(
      await queuePeerInboxCodexHint(input({ record: bound, threadId: 'named-thread' }))
    ).toEqual({ status: 'not-started', reason: 'invalid-binding' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it.each(['named-thread', '--thread', `${THREAD}\n`, ''])(
    'rejects non-UUID target %j',
    async (threadId) => {
      expect(await queuePeerInboxCodexHint(input({ threadId }))).toMatchObject({
        status: 'not-started'
      })
      expect(runProcess).not.toHaveBeenCalled()
    }
  )

  it.each([
    '',
    ' ',
    `/clear ${NONCE}`,
    ` \n!echo ${NONCE}`,
    `${HINT}\0`,
    `${HINT}\u001b`,
    `${HINT}\t`,
    'x'.repeat(2049) + NONCE,
    'missing nonce'
  ])('rejects routed, unsafe, or uncorrelated hint %j', async (hint) => {
    expect(await queuePeerInboxCodexHint(input({ hint }))).toEqual({
      status: 'not-started',
      reason: 'invalid-hint'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it.each(['nonce', `${NONCE}\n`])(
    'rejects non-UUID correlation nonce %j',
    async (correlationNonce) => {
      expect(
        await queuePeerInboxCodexHint(
          input({
            correlationNonce,
            hint: `${HINT}\n`
          })
        )
      ).toMatchObject({ status: 'not-started' })
      expect(runProcess).not.toHaveBeenCalled()
    }
  )

  it('refuses pre-aborted calls', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await queuePeerInboxCodexHint(input({ signal: controller.signal }))).toEqual({
      status: 'not-started',
      reason: 'aborted'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it.each(['codex', 'relative/codex', `${CODEX}\0`])(
    'refuses unresolved command %j',
    async (command) => {
      vi.mocked(resolveCodexCommand).mockReturnValue(command)
      expect(await queuePeerInboxCodexHint(input())).toEqual({
        status: 'not-started',
        reason: 'command-unavailable'
      })
      expect(runProcess).not.toHaveBeenCalled()
    }
  )

  it('sanitizes resolver failures and preserves uncertainty after runner rejection', async () => {
    vi.mocked(resolveCodexCommand).mockImplementationOnce(() => {
      throw new Error('private-path')
    })
    expect(await queuePeerInboxCodexHint(input())).toEqual({
      status: 'not-started',
      reason: 'command-unavailable'
    })
    vi.mocked(runProcess).mockRejectedValueOnce(new Error('private-profile-and-hint'))
    expect(await queuePeerInboxCodexHint(input())).toEqual({
      status: 'uncertain',
      reason: 'queue-unconfirmed'
    })
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it.each([
    { code: 1, stderr: 'private-profile' },
    { code: null },
    { timedOut: true },
    { signal: 'SIGTERM' as const },
    { stdout: '' },
    { stdout: `${SUCCESS.stdout}\n` },
    { stdout: SUCCESS.stdout.replace('Queued', 'queued') },
    { stdout: SUCCESS.stdout.replace(THREAD, NEXT_THREAD) },
    { stdout: `${SUCCESS.stdout}extra output` },
    { stdout: `prefix ${SUCCESS.stdout}` },
    { stdout: SUCCESS.stdout.replace(ITEM, 'named-item') }
  ])('retains uncertainty without retry on ambiguous completion %j', async (result) => {
    vi.mocked(runProcess).mockResolvedValueOnce({ ...SUCCESS, ...result })
    expect(await queuePeerInboxCodexHint(input())).toEqual({
      status: 'uncertain',
      reason: 'queue-unconfirmed'
    })
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('treats an abort after spawn as uncertain even with a receipt', async () => {
    const controller = new AbortController()
    vi.mocked(runProcess).mockImplementationOnce(async () => {
      controller.abort()
      return { ...SUCCESS }
    })
    expect(await queuePeerInboxCodexHint(input({ signal: controller.signal }))).toEqual({
      status: 'uncertain',
      reason: 'queue-unconfirmed'
    })
    expect(runProcess).toHaveBeenCalledTimes(1)
  })
})
