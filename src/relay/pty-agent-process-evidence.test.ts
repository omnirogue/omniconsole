import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getFreshProcessTableSnapshot } from '../shared/process-table-snapshot'
import {
  readPosixReceiverRowSync,
  readPosixSpawnRootRowSync
} from '../main/pty/posix-pty-foreground-group'
import {
  captureRelayPtyProcessRoot,
  readRelayPtyAgentProcessEvidence
} from './pty-agent-process-evidence'

vi.mock('../shared/process-table-snapshot', () => ({ getFreshProcessTableSnapshot: vi.fn() }))
vi.mock('../main/pty/posix-pty-foreground-group', () => ({
  readPosixReceiverRowSync: vi.fn(),
  readPosixSpawnRootRowSync: vi.fn(),
  PS_LSTART_TOLERANCE_MS: 1000
}))

function fixture() {
  const owner = {
    id: 'pty-a',
    incarnationId: 'birth-a',
    disposed: false,
    inputGeneration: 0,
    pty: { pid: 100, ptsName: '/dev/pts/3' },
    agentProcessRoot: { pid: 100, startTimeMs: 10000, tty: 'pts/3' }
  }
  const root = {
    pgid: 100,
    tpgid: 200,
    tty: 'pts/3',
    startTimeMs: 10000,
    stat: 'Ss',
    command: '/bin/zsh'
  }
  const receiver = {
    pgid: 200,
    tpgid: 200,
    tty: 'pts/3',
    startTimeMs: 20000,
    stat: 'S+',
    command: '/usr/local/bin/claude'
  }
  const rows = [
    { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
    { pid: 200, ppid: 100, stat: 'S+', command: '/usr/local/bin/claude' }
  ]
  vi.mocked(getFreshProcessTableSnapshot).mockResolvedValue(rows)
  vi.mocked(readPosixReceiverRowSync).mockImplementation((pid) => (pid === 100 ? root : receiver))
  vi.mocked(readPosixSpawnRootRowSync).mockReturnValue(root)
  const getOwner = vi.fn(() => owner)
  const isCurrent = vi.fn(() => true)
  const read = () =>
    readRelayPtyAgentProcessEvidence({ id: 'pty-a', incarnationId: 'birth-a' }, getOwner, isCurrent)
  return { owner, root, receiver, rows, getOwner, isCurrent, read }
}

describe.skipIf(process.platform === 'win32')('relay-owned process evidence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pins the root to the actual PTY at spawn and proves its foreground agent', async () => {
    const { owner, read } = fixture()
    expect(captureRelayPtyProcessRoot(owner.pty)).toEqual(owner.agentProcessRoot)
    expect(await read()).toEqual({
      id: 'pty-a',
      incarnationId: 'birth-a',
      tree: { kind: 'other' },
      proof: {
        ptyId: 'pty-a',
        incarnationId: 'birth-a',
        rootPid: 100,
        pid: 200,
        pgid: 200,
        startTimeMs: 20000,
        agent: 'claude',
        via: 'command-line'
      }
    })
  })

  it('captures birth before TTY acquisition but only proves the same process after acquisition', async () => {
    const { owner, root, read } = fixture()
    vi.mocked(readPosixSpawnRootRowSync).mockReturnValue({ tty: '??', startTimeMs: 10000 })
    const captured = captureRelayPtyProcessRoot(owner.pty)
    expect(captured).toEqual(owner.agentProcessRoot)
    owner.agentProcessRoot = captured!
    root.tty = '??'
    expect(await read()).toBeNull()
    root.tty = 'pts/3'
    expect((await read())?.proof?.pid).toBe(200)
    root.startTimeMs = 11000
    expect(await read()).toBeNull()
  })

  it('cannot recover an unobserved birth by sampling a later process', async () => {
    const { owner } = fixture()
    vi.mocked(readPosixSpawnRootRowSync).mockReturnValue({ tty: '??', startTimeMs: null })
    expect(captureRelayPtyProcessRoot(owner.pty)).toBeNull()
    expect(
      await readRelayPtyAgentProcessEvidence(
        { id: owner.id, incarnationId: owner.incarnationId },
        () => ({ ...owner, agentProcessRoot: null }),
        () => true
      )
    ).toBeNull()
  })

  it('refuses a spawn root from a different terminal', () => {
    const { owner, root } = fixture()
    root.tty = 'pts/4'
    expect(captureRelayPtyProcessRoot(owner.pty)).toBeNull()
  })

  it.each(['birth', 'tty', 'owner', 'incarnation', 'disposed', 'connection', 'input'])(
    'discards evidence when %s changes during inspection',
    async (change) => {
      const { owner, root, rows, getOwner, isCurrent, read } = fixture()
      vi.mocked(getFreshProcessTableSnapshot).mockImplementation(async () => {
        if (change === 'input') {
          owner.inputGeneration++
        }
        if (change === 'birth') {
          root.startTimeMs = 11000
        }
        if (change === 'tty') {
          root.tty = 'pts/4'
        }
        if (change === 'owner') {
          getOwner.mockReturnValue({ ...owner })
        }
        if (change === 'incarnation') {
          owner.incarnationId = 'birth-b'
        }
        if (change === 'disposed') {
          owner.disposed = true
        }
        if (change === 'connection') {
          isCurrent.mockReturnValue(false)
        }
        return rows
      })
      expect(await read()).toBeNull()
    }
  )

  it.each(['tty', 'foreground', 'command', 'stopped'])(
    'does not grant a receiver proof when its %s changed',
    async (change) => {
      const { receiver, read } = fixture()
      if (change === 'tty') {
        receiver.tty = 'pts/4'
      }
      if (change === 'foreground') {
        receiver.tpgid = 300
      }
      if (change === 'command') {
        receiver.command = '/bin/zsh'
      }
      if (change === 'stopped') {
        receiver.stat = 'T+'
      }
      expect(await read()).toMatchObject({ proof: null, tree: { kind: 'other' } })
    }
  )

  it('keeps a suspended agent distinct from a positively observed shell-only tree', async () => {
    const { rows, root, read } = fixture()
    rows[1]!.stat = 'T'
    expect(await read()).toMatchObject({ proof: null, tree: { kind: 'stopped' } })
    rows.pop()
    rows[0]!.stat = 'Ss+'
    root.stat = 'Ss+'
    root.tpgid = 100
    expect(await read()).toMatchObject({ proof: null, tree: { kind: 'agent-gone' } })
  })

  it('cannot infer absence without the captured root or a current host request', async () => {
    const { owner, isCurrent, getOwner } = fixture()
    expect(
      await readRelayPtyAgentProcessEvidence(
        { id: owner.id, incarnationId: 'wrong' },
        getOwner,
        isCurrent
      )
    ).toBeNull()
    isCurrent.mockReturnValue(false)
    expect(
      await readRelayPtyAgentProcessEvidence(
        { id: owner.id, incarnationId: owner.incarnationId },
        getOwner,
        isCurrent
      )
    ).toBeNull()
    expect(getFreshProcessTableSnapshot).not.toHaveBeenCalled()
  })
})
