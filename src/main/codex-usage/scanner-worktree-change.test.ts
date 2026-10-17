import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('node:worker_threads', () => ({ Worker: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import { scanCodexUsageFiles } from './scanner'
import { scanCodexUsageFilesInWorker } from './codex-usage-worker-client'
import { UsageScanStoppedError } from '../usage/usage-scan-stopped-error'
import type { CodexUsageWorktreeRef } from './codex-usage-event-attribution'

const originalCodexHome = process.env.CODEX_HOME
const previousUserDataPath = process.env.ORCA_USER_DATA_PATH
let fakeHomeDir: string
let userDataDir: string

function rollout(cwd: string, timestamp: string, inputTokens: number): string {
  const usage = {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: inputTokens
  }
  return [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: `s-${inputTokens}`, cwd }
    }),
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5-codex',
          last_token_usage: usage,
          total_token_usage: usage
        }
      }
    }),
    ''
  ].join('\n')
}

function worktree(name: string): CodexUsageWorktreeRef {
  return {
    repoId: 'repo',
    worktreeId: `repo::${name}`,
    path: join(fakeHomeDir, name),
    displayName: name
  }
}

beforeEach(() => {
  delete process.env.CODEX_HOME
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'omni-codex-usage-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'omni-codex-usage-user-data-'))
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(fakeHomeDir, name), { recursive: true })
  }
  const sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, 'a-alpha.jsonl'),
    rollout(join(fakeHomeDir, 'alpha'), '2026-09-01T12:00:00.000Z', 10)
  )
  writeFileSync(
    join(sessionsDir, 'b-beta.jsonl'),
    rollout(join(fakeHomeDir, 'beta', 'src'), '2026-09-01T12:00:00.000Z', 20)
  )
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('scanCodexUsageFiles across worktree-list changes', () => {
  it('keeps cached rollouts whose attribution an added worktree does not change', async () => {
    const first = await scanCodexUsageFiles([worktree('alpha')], [])
    const second = await scanCodexUsageFiles(
      [worktree('alpha'), worktree('gamma')],
      first.processedFiles,
      {
        worktreeSetChanged: true
      }
    )

    expect(second.processedFiles[0]).toBe(first.processedFiles[0])
    expect(second.processedFiles[1]).toBe(first.processedFiles[1])
  })

  it('re-parses only the rollout whose cwd moves into a newly added worktree', async () => {
    const first = await scanCodexUsageFiles([worktree('alpha')], [])
    expect(first.processedFiles[1]?.attributionByCwd).toEqual({
      [join(fakeHomeDir, 'beta', 'src')]: null
    })

    const second = await scanCodexUsageFiles(
      [worktree('alpha'), worktree('beta')],
      first.processedFiles,
      {
        worktreeSetChanged: true
      }
    )

    expect(second.processedFiles[0]).toBe(first.processedFiles[0])
    expect(second.processedFiles[1]).not.toBe(first.processedFiles[1])
    expect(
      second.sessions.find((session) => session.sessionId === 's-20')?.primaryProjectLabel
    ).toBe('beta')
  })

  it('re-parses cache entries written before per-cwd attribution only when the list changed', async () => {
    const first = await scanCodexUsageFiles([worktree('alpha')], [])
    const legacy = first.processedFiles.map(({ attributionByCwd: _unused, ...file }) => file)

    const unchanged = await scanCodexUsageFiles([worktree('alpha')], legacy)
    expect(unchanged.processedFiles[0]).toBe(legacy[0])

    const changed = await scanCodexUsageFiles([worktree('alpha')], legacy, {
      worktreeSetChanged: true
    })
    expect(changed.processedFiles[0]).not.toBe(legacy[0])
  })

  it('resumes checkpointed ownership and attribution without reparsing settled files', async () => {
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 120_001))
    const checkpoints: Awaited<ReturnType<typeof scanCodexUsageFiles>>['processedFiles'][] = []
    try {
      const first = await scanCodexUsageFiles([worktree('alpha')], [], {
        onCheckpoint: async (files) => {
          checkpoints.push(files)
        }
      })
      expect(checkpoints).toHaveLength(2)
      const resumed = await scanCodexUsageFiles([worktree('alpha')], checkpoints[0])
      expect(resumed.processedFiles[0]).toBe(checkpoints[0][0])
      expect(resumed.sessions).toEqual(first.sessions)
    } finally {
      clock.mockRestore()
    }
  })

  it('stops parsing as soon as tracking is turned off', async () => {
    await expect(
      scanCodexUsageFiles([worktree('alpha')], [], { shouldStop: () => true })
    ).rejects.toBeInstanceOf(UsageScanStoppedError)
  })
})

describe('Codex usage worker boundary', () => {
  function fakeWorker() {
    const worker = Object.assign(new EventEmitter(), {
      terminate: vi.fn().mockResolvedValue(0),
      postMessage: vi.fn()
    })
    vi.mocked(Worker).mockImplementation(function () {
      return worker as unknown as Worker
    })
    return worker
  }

  it('sends cached attribution and worktrees to the worker and returns its projection', async () => {
    const previous = await scanCodexUsageFiles([worktree('alpha')], [])
    const worker = fakeWorker()
    const pending = scanCodexUsageFilesInWorker([worktree('alpha')], previous.processedFiles, {
      worktreeSetChanged: true
    })
    expect(Worker).toHaveBeenLastCalledWith(
      expect.stringContaining('codex-usage-worker-entry.js'),
      {
        workerData: expect.objectContaining({
          worktrees: [worktree('alpha')],
          previous: previous.processedFiles,
          worktreeSetChanged: true
        })
      }
    )
    worker.emit('message', { type: 'result', result: previous })
    await expect(pending).resolves.toEqual(previous)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('waits for serialized checkpoint persistence before acknowledging it', async () => {
    const worker = fakeWorker()
    let release!: () => void
    const onSerializedCheckpoint = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = scanCodexUsageFilesInWorker([], [], {
      checkpointState: { schemaVersion: 5 },
      onSerializedCheckpoint
    })
    worker.emit('message', { type: 'checkpoint', snapshot: '{"processedFiles":[]}' })
    await vi.waitFor(() => expect(onSerializedCheckpoint).toHaveBeenCalledOnce())
    expect(worker.postMessage).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
    worker.emit('message', {
      type: 'result',
      result: { processedFiles: [], sessions: [], dailyAggregates: [] }
    })
    await pending
  })

  it('terminates a busy worker without recording cancellation as a scan failure', async () => {
    const worker = fakeWorker()
    let disabled = false
    const pending = scanCodexUsageFilesInWorker([], [], { shouldStop: () => disabled })
    const stopped = expect(pending).rejects.toBeInstanceOf(UsageScanStoppedError)
    disabled = true
    await stopped
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects unexpected clean exits instead of hanging the store', async () => {
    const worker = fakeWorker()
    const pending = scanCodexUsageFilesInWorker([], [])
    worker.emit('exit', 0)
    await expect(pending).rejects.toThrow('exited before returning a result (0)')
  })
})
