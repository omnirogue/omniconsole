import { describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageState } from '../../shared/session-manage-types'
import { UNREAD_TURN, type SessionLatestTurn } from '../session-manage/session-manage-freeform'
import {
  archiveSleepReplies,
  readArchiveSleepHost,
  type ArchiveSleepHostDeps
} from './archive-sleep-host-reading'

const target = { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', worktreeId: 'wt' }

function sidebarRow(overrides: Partial<SessionManageSidebarRow> = {}): SessionManageSidebarRow {
  return {
    rowKey: 'row-1',
    viewKey: 'claude:abc',
    paneKey: target.paneKey,
    tabId: target.tabId,
    kind: 'terminal',
    structuredSessionId: null,
    worktreeId: 'wt',
    hostId: 'local',
    hostUnavailable: false,
    title: 'Fix the build',
    agent: 'claude',
    workspace: 'repo',
    worktreePath: '/repo',
    repoId: null,
    repoLabel: null,
    branch: null,
    workspaceKind: 'git',
    folderId: null,
    folder: null,
    saved: false,
    archived: true,
    archivedByHand: true,
    pinned: false,
    launchPending: false,
    resumable: true,
    shellForeground: false,
    folded: false,
    ...overrides
  }
}

/** A latest turn the next-steps host established and holds whole. */
function turn(text: string | null, overrides: Partial<SessionLatestTurn> = {}): SessionLatestTurn {
  return { ...UNREAD_TURN, known: true, turnKey: 'turn-1', text, complete: true, ...overrides }
}

function deps(
  overrides: Partial<ArchiveSleepHostDeps> & { stateIs?: SessionManageState } = {}
): ArchiveSleepHostDeps {
  return {
    rows: vi.fn(async () => [sidebarRow()]),
    state: vi.fn(async () => overrides.stateIs ?? 'idle'),
    replies: vi.fn(() => archiveSleepReplies(turn('Build fixed and pushed.'), { state: 'done' })),
    nothingPending: vi.fn(async () => true),
    ...overrides
  }
}

describe('the host reading before an archive sleeps an agent', () => {
  it('is clear only for a local terminal Stage A1 reads idle, with no open ask and nothing pending', async () => {
    const reading = deps()
    expect(await readArchiveSleepHost(reading, target)).toEqual({ clear: true, state: 'idle' })
    expect(reading.nothingPending).toHaveBeenCalledWith({
      worktreeId: 'wt',
      paneKey: target.paneKey,
      kind: 'pty'
    })
  })

  it.each<SessionManageState>(['awaiting-user', 'waiting-for-yes'])(
    'G1: keeps an agent Stage A1 reads %s',
    async (stateIs) => {
      const reading = deps({ stateIs })
      expect(await readArchiveSleepHost(reading, target)).toEqual({
        clear: false,
        keep: 'open-ask',
        state: stateIs
      })
      expect(reading.nothingPending).not.toHaveBeenCalled()
    }
  )

  it('G1: keeps an agent whose last reply asks, though Stage A1 reads it idle', async () => {
    for (const text of ['Ship it now?', 'Two things:\n1. Rebase first\n2. Or merge as is']) {
      const reading = deps({
        replies: () =>
          archiveSleepReplies(UNREAD_TURN, { state: 'done', lastAssistantMessage: text })
      })
      expect(await readArchiveSleepHost(reading, target)).toEqual({
        clear: false,
        keep: 'open-ask',
        state: 'idle'
      })
    }
  })

  it.each<[string, SessionLatestTurn, Parameters<typeof archiveSleepReplies>[1]]>([
    ['no turn read and no hook row', UNREAD_TURN, null],
    ['no turn read and a done hook without the message', UNREAD_TURN, { state: 'done' }],
    [
      'no turn read and only a tool’s output',
      UNREAD_TURN,
      { state: 'done', lastAssistantMessage: 'exit 0', lastAssistantMessageIsToolOutput: true }
    ],
    ['a turn known without its reply', turn(null), { state: 'done', lastAssistantMessage: ' ' }],
    ['only a trimmed preview of the turn', turn('Build fixed', { complete: false }), null],
    [
      'only a hook row that is not Done',
      UNREAD_TURN,
      { state: 'working', lastAssistantMessage: 'Build fixed and pushed.' }
    ]
  ])('G1 fails closed: keeps an idle agent with %s', async (_name, latest, hook) => {
    const reading = deps({ replies: () => archiveSleepReplies(latest, hook) })
    expect(await readArchiveSleepHost(reading, target)).toEqual({
      clear: false,
      keep: 'unreadable',
      state: 'idle'
    })
    expect(reading.nothingPending).not.toHaveBeenCalled()
  })

  it('G1: reads a whole reply from either source, and an ask in any source keeps it', async () => {
    for (const replies of [
      archiveSleepReplies(turn('Build fixed and pushed.'), null),
      archiveSleepReplies(UNREAD_TURN, { state: 'done', lastAssistantMessage: 'Pushed.' })
    ]) {
      expect(await readArchiveSleepHost(deps({ replies: () => replies }), target)).toEqual({
        clear: true,
        state: 'idle'
      })
    }
    for (const replies of [
      archiveSleepReplies(turn('Pushed. Merge it too?', { complete: false }), null),
      archiveSleepReplies(turn('Pushed.'), {
        state: 'done',
        lastAssistantMessage: 'Continue?',
        lastAssistantMessageIsToolOutput: true
      })
    ]) {
      expect(await readArchiveSleepHost(deps({ replies: () => replies }), target)).toEqual({
        clear: false,
        keep: 'open-ask',
        state: 'idle'
      })
    }
  })

  it.each<[SessionManageState, string]>([
    ['working', 'not-idle'],
    ['unknown', 'not-idle'],
    ['exited', 'not-idle'],
    ['provider-limited', 'not-idle'],
    ['queued', 'pending']
  ])('keeps an agent Stage A1 reads %s', async (stateIs, keep) => {
    expect(await readArchiveSleepHost(deps({ stateIs }), target)).toMatchObject({
      clear: false,
      keep
    })
  })

  it('keeps an agent up next still holds (a prompt the queue just typed in, a plan, Keep going)', async () => {
    expect(
      await readArchiveSleepHost(deps({ nothingPending: async () => false }), target)
    ).toEqual({ clear: false, keep: 'pending', state: 'idle' })
  })

  it.each<[string, Partial<SessionManageSidebarRow>]>([
    ['an SSH host', { hostId: 'ssh:devbox' }],
    ['a paired runtime', { hostId: 'runtime:env-1' }],
    ['a disconnected host', { hostUnavailable: true }],
    ['a chat session', { kind: 'structured' }]
  ])('never reads %s as clear', async (_name, overrides) => {
    const reading = deps({ rows: async () => [sidebarRow(overrides)] })
    expect(await readArchiveSleepHost(reading, target)).toEqual({ clear: false, keep: 'not-local' })
    expect(reading.state).not.toHaveBeenCalled()
  })

  it('keeps the agent when its row is missing, elsewhere, or a reading fails', async () => {
    for (const reading of [
      deps({ rows: async () => [] }),
      deps({ rows: async () => [sidebarRow({ worktreeId: 'other' })] }),
      deps({
        state: async () => {
          throw new Error('terminal unreadable')
        }
      }),
      deps({
        nothingPending: async () => {
          throw new Error('up next unreadable')
        }
      })
    ]) {
      expect(await readArchiveSleepHost(reading, target)).toEqual({
        clear: false,
        keep: 'unreadable'
      })
    }
  })
})
