import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  advanceSshConnectionGeneration,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import { buildCompleteSessionTranscript } from '../transcripts/complete-session-transcript'
import { captureSshSessionHandoff } from './session-handoff-capture'

vi.mock('../transcripts/complete-session-transcript', () => ({
  buildCompleteSessionTranscript: vi.fn()
}))

const connectionId = 'handoff-source'
const transcriptBuilder = vi.mocked(buildCompleteSessionTranscript)
type Entry = { bytes?: Buffer; link?: string; ino: number }

function fixture(windows = false) {
  const api = windows ? win32 : posix
  const workspace = windows ? 'C:\\remote\\workspace' : '/remote/workspace'
  const destination = api.join(api.dirname(workspace), 'handoff')
  const source = api.join(workspace, 'result.bin')
  const bytes = Buffer.from([0, 255, 128, 42])
  const entries = new Map<string, Entry>([
    [workspace, { ino: 1 }],
    [destination, { ino: 2 }],
    [source, { ino: 3, bytes }]
  ])
  const entry = (path: string): Entry => {
    const value = entries.get(path)
    if (!value) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
        code: 'ENOENT'
      })
    }
    return value
  }
  const provider = {
    realpath: vi.fn(async (path: string) => entry(path).link ?? path),
    lstat: vi.fn(async (path: string): Promise<FileStat> => {
      const value = entry(path)
      return {
        type: value.link ? 'symlink' : value.bytes ? 'file' : 'directory',
        size: value.bytes?.length ?? 128,
        mode: value.link ? 0o120755 : value.bytes ? 0o100644 : 0o040755,
        mtime: 1,
        mtimeMs: 1,
        ctimeMs: 1,
        ino: value.ino,
        dev: 1,
        exactReadIdentity: 1
      }
    }),
    readDir: vi.fn(async (path: string) =>
      [...entries.entries()]
        .filter(([key]) => key !== path && api.dirname(key) === path)
        .map(([key, value]) => ({
          name: api.basename(key),
          isDirectory: !value.bytes && !value.link,
          isSymlink: Boolean(value.link)
        }))
    ),
    readExactFile: vi.fn(async (path: string) => ({
      isBinary: true,
      content: entry(path).bytes!.toString('base64')
    })),
    writeFileBase64: vi.fn(async (path: string, content: string) => {
      if (entries.has(path)) {
        throw Object.assign(new Error('Destination exists'), { code: 'EEXIST' })
      }
      entries.set(path, { ino: entries.size + 1, bytes: Buffer.from(content, 'base64') })
    })
  }
  registerSshFilesystemProvider(connectionId, provider as unknown as IFilesystemProvider)
  const rule: SessionFollowUpRule = {
    revision: 1,
    taskId: null,
    taskTitle: 'Current work',
    sessionLabel: 'Current work',
    recipients: [
      { employeeId: 'person', name: 'Person', operationId: 'snapshot', delivery: 'pending' }
    ],
    deliverables: { kind: 'files', paths: [source] },
    destinationDirectory: destination,
    includeSummary: true,
    savedAt: 1,
    note: 'Continue this work'
  }
  return { api, workspace, destination, source, bytes, entries, provider, rule }
}

beforeEach(() => {
  resetSshConnectionGenerations()
  transcriptBuilder.mockReset()
})
afterEach(() => unregisterSshFilesystemProvider(connectionId))

describe('immediate SSH session capture', () => {
  it.each([false, true])(
    'materializes exact host bytes and retains retry pins (Windows: %s)',
    async (windows) => {
      const f = fixture(windows)
      const captured = await captureSshSessionHandoff(
        f.rule,
        f.workspace,
        'Current context',
        connectionId
      )
      expect(captured.files).toHaveLength(2)
      expect(captured.files?.[0]).toMatchObject({
        sourcePath: f.api.join(f.destination, 'result.bin'),
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        size: f.bytes.length
      })
      expect(f.entries.get(captured.files![0]!.sourcePath!)?.bytes).toEqual(f.bytes)
      expect(f.entries.get(captured.files![1]!.sourcePath!)?.bytes?.toString()).toBe(
        'Current context'
      )
      expect(f.provider.readExactFile).toHaveBeenCalledWith(
        f.source,
        expect.any(Number),
        expect.objectContaining({ ino: 3, dev: 1 })
      )
      f.provider.writeFileBase64.mockClear()
      await expect(
        captureSshSessionHandoff(f.rule, f.workspace, 'Current context', connectionId)
      ).resolves.toMatchObject({ files: captured.files })
      expect(f.provider.writeFileBase64).not.toHaveBeenCalled()
    }
  )

  it('keeps the workspace default and captures selected folders as archives', async () => {
    const f = fixture()
    const folder = f.api.join(f.workspace, 'reports')
    f.entries.set(folder, { ino: 4 })
    f.entries.set(f.api.join(folder, 'answer.bin'), { ino: 5, bytes: f.bytes })
    const captured = await captureSshSessionHandoff(
      {
        ...f.rule,
        deliverables: { kind: 'files', paths: [folder] },
        destinationDirectory: f.workspace
      },
      f.workspace,
      'Context',
      connectionId
    )
    expect(captured.files?.[0]?.name).toBe('reports.tar.gz')
    expect(captured.files?.[0]?.sourcePath).toBe(f.api.join(f.workspace, 'reports.tar.gz'))
    expect(f.entries.get(captured.files![0]!.sourcePath!)?.bytes?.subarray(0, 2)).toEqual(
      Buffer.from([31, 139])
    )
  })

  it('resolves relative deliverables against the SSH workspace', async () => {
    const f = fixture()
    const captured = await captureSshSessionHandoff(
      { ...f.rule, deliverables: { kind: 'files', paths: ['result.bin'] } },
      f.workspace,
      'Context',
      connectionId
    )
    expect(f.entries.get(captured.files![0]!.sourcePath!)?.bytes).toEqual(f.bytes)
  })

  it.each(['missing', 'source-symlink', 'destination-symlink', 'different-destination'])(
    'refuses %s without writing',
    async (kind) => {
      const f = fixture()
      if (kind === 'missing') {
        f.entries.delete(f.source)
      }
      if (kind === 'source-symlink') {
        f.entries.set(f.source, { ino: 3, link: '/elsewhere/result.bin' })
      }
      if (kind === 'destination-symlink') {
        f.entries.set(f.api.join(f.destination, 'result.bin'), { ino: 4, link: f.source })
      }
      if (kind === 'different-destination') {
        f.entries.set(f.api.join(f.destination, 'result.bin'), {
          ino: 4,
          bytes: Buffer.from('keep mine')
        })
      }
      await expect(
        captureSshSessionHandoff(f.rule, f.workspace, 'Context', connectionId)
      ).rejects.toThrow()
      expect(f.provider.writeFileBase64).not.toHaveBeenCalled()
    }
  )

  it('refuses a missing provider before reading any local path', async () => {
    const f = fixture()
    unregisterSshFilesystemProvider(connectionId)
    await expect(
      captureSshSessionHandoff(f.rule, f.workspace, 'Context', connectionId)
    ).rejects.toThrow('Reconnect')
    expect(f.provider.realpath).not.toHaveBeenCalled()
  })

  it.each(['provider', 'generation', 'owner'])(
    'rejects %s changes during exact reads before materialization',
    async (change) => {
      const f = fixture()
      let ownerChanged = false
      f.provider.readExactFile.mockImplementationOnce(async () => {
        if (change === 'provider') {
          registerSshFilesystemProvider(connectionId, {
            ...f.provider
          } as unknown as IFilesystemProvider)
        }
        if (change === 'generation') {
          advanceSshConnectionGeneration(connectionId)
        }
        if (change === 'owner') {
          ownerChanged = true
        }
        return { isBinary: true, content: f.bytes.toString('base64') }
      })
      await expect(
        captureSshSessionHandoff(f.rule, f.workspace, 'Context', connectionId, () => {
          if (ownerChanged) {
            throw new Error('Workspace owner changed')
          }
        })
      ).rejects.toThrow(/changed/)
      expect(f.provider.writeFileBase64).not.toHaveBeenCalled()
    }
  )

  it('does not return captured pins if the connection changes during a write', async () => {
    const f = fixture()
    f.provider.writeFileBase64.mockImplementationOnce(async () => {
      advanceSshConnectionGeneration(connectionId)
    })
    await expect(
      captureSshSessionHandoff(f.rule, f.workspace, 'Context', connectionId)
    ).rejects.toThrow('changed')
    expect(f.provider.writeFileBase64).toHaveBeenCalledTimes(1)
  })

  it('rejects mismatched transcript ownership before building or writing', async () => {
    const f = fixture()
    await expect(
      captureSshSessionHandoff(
        {
          ...f.rule,
          transcriptSource: {
            kind: 'provider',
            hostId: 'ssh:another',
            agent: 'codex',
            sessionId: 'history'
          }
        },
        f.workspace,
        'Context',
        connectionId
      )
    ).rejects.toThrow('does not own')
    expect(transcriptBuilder).not.toHaveBeenCalled()
    expect(f.provider.writeFileBase64).not.toHaveBeenCalled()
  })

  it('routes the transcript to the pinned SSH owner and refuses protected content before writes', async () => {
    const f = fixture()
    transcriptBuilder.mockResolvedValue({ kind: 'refused', redactions: 1 })
    await expect(
      captureSshSessionHandoff(
        {
          ...f.rule,
          transcriptSource: {
            kind: 'provider',
            hostId: `ssh:${connectionId}`,
            agent: 'codex',
            sessionId: 'history'
          }
        },
        f.workspace,
        'Context',
        connectionId
      )
    ).rejects.toThrow('protected-data gate')
    expect(transcriptBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConnectionId: connectionId, sessionId: 'history' })
    )
    expect(f.provider.writeFileBase64).not.toHaveBeenCalled()
  })

  it('materializes the complete transcript snapshot with the other SSH attachments', async () => {
    const f = fixture()
    const bytes = Buffer.from('First message\nLast message\n')
    transcriptBuilder.mockResolvedValue({
      kind: 'built',
      earlierMessagesOmitted: false,
      omittedRecords: 0,
      deliverable: {
        name: 'history.md',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        redactions: 0,
        messageCount: 2,
        truncatedBlocks: 0
      }
    })
    const captured = await captureSshSessionHandoff(
      {
        ...f.rule,
        transcriptSource: {
          kind: 'provider',
          hostId: `ssh:${connectionId}`,
          agent: 'codex',
          sessionId: 'history'
        }
      },
      f.workspace,
      'Context',
      connectionId
    )
    const pin = captured.files!.find((file) => file.generatedKind === 'transcript')!
    // Named for the person who receives it: the topic and when it was sent, never the session id.
    expect(pin.name).toMatch(/^Conversation transcript - Current work - \d{4}-\d\d-\d\d \d{6}\.md$/)
    expect(f.entries.get(pin.sourcePath!)?.bytes).toEqual(bytes)
    expect(captured.transcriptFile?.contentBase64).toBe(bytes.toString('base64'))
  })
})
