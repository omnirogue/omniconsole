import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { openFramedSession, sleep } from './runtime-rpc-test-harness'

// Why: an agent start can wait minutes for an app-wide admission slot (3 per 10 s). terminal.create
// is a short RPC: no keepalive, and the server drops a socket silent for 30 s (the CLI gives up at
// 60 s), so a CLI or orchestrator create queued behind a restore backlog was reported as failed
// while its agent started later anyway. A create whose agent start waits now keeps its socket alive.

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

type CreateOptions = { onAgentLaunchQueued?: () => void }

async function runTerminalCreate(queued: boolean): Promise<Record<string, unknown>[]> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'omni-runtime-rpc-'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, keepaliveIntervalMs: 30 })
  vi.spyOn(runtime, 'dedupeTerminalCreate').mockImplementation(
    async (_client, worktree, _mutationId, _reconcile, run) => await run(worktree, undefined)
  )
  vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_worktree, opts = {}) => {
    if (queued) {
      // Main's admission queue holds the agent start: the hook fires, then the slot frees.
      ;(opts as CreateOptions).onAgentLaunchQueued?.()
    }
    await sleep(150)
    return { handle: 'term_1', worktreeId: 'wt-1', title: null }
  })
  await server.start()
  try {
    const metadata = readRuntimeMetadata(userDataPath)
    const session = openFramedSession(metadata!.transports[0]!.endpoint, {
      id: 'req_create',
      authToken: metadata!.authToken,
      method: 'terminal.create',
      params: { worktree: 'id:wt-1', command: 'codex' }
    })
    await session.done
    return session.frames
  } finally {
    await server.stop()
  }
}

describe('terminal.create while its agent start waits for admission', () => {
  it('keeps the socket alive while the start is queued', async () => {
    const frames = await runTerminalCreate(true)
    expect(frames.filter((frame) => frame._keepalive === true).length).toBeGreaterThanOrEqual(2)
    expect(frames.filter((frame) => frame.ok !== undefined)).toEqual([
      expect.objectContaining({ id: 'req_create', ok: true })
    ])
  })

  it('stays a plain short RPC when the start is admitted at once', async () => {
    const frames = await runTerminalCreate(false)
    expect(frames.filter((frame) => frame._keepalive === true)).toHaveLength(0)
    expect(frames.filter((frame) => frame.ok !== undefined)).toHaveLength(1)
  })
})
