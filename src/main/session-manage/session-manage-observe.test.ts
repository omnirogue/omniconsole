import { describe, expect, it, vi } from 'vitest'
import { structuredConversationSource } from '../../shared/conversation-source'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import {
  findSessionManageRow,
  listSessionManageEntries,
  toSessionManageEntry
} from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import { agentEvidence, observeSources, sidebarRow } from './session-manage-test-fixtures'
import { parseSessionPromptScreen } from './session-prompt-screen'
import type { SessionPrompt } from './session-prompt'

async function entryFor(...args: Parameters<typeof observeSession>) {
  return toSessionManageEntry(await observeSession(...args))
}

describe('session list pending prompts', () => {
  const screen = 'Bash command\n  pwd\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel'
  const prompt: SessionPrompt = {
    ...parseSessionPromptScreen('claude', screen)!,
    delivery: { kind: 'pty', handle: 'term_1', ptyId: 'pty-1', screen }
  }

  it('adds ask only for an observed awaiting-user prompt, including folder workspaces', async () => {
    const entry = await entryFor(
      sidebarRow({ workspaceKind: 'folder', repoId: null, branch: null }),
      observeSources({
        agentStatus: async () => ({ running: true, status: 'permission' }),
        prompt: async () => prompt
      })
    )
    expect(entry).toMatchObject({ state: 'awaiting-user', ask: prompt.ask })
    expect(
      await entryFor(sidebarRow(), observeSources({ prompt: async () => prompt }))
    ).not.toHaveProperty('ask')
  })

  it('preserves a visible prompt as contrary evidence even while a hook says working', async () => {
    const observed = await observeSession(
      sidebarRow(),
      observeSources({
        hook: () => ({ state: 'working', updatedAt: 1000, interactivePrompt: null, agentPid: 200 }),
        prompt: async () => prompt
      })
    )
    expect(observed.prompt).toBe(prompt)
    expect(toSessionManageEntry(observed).state).toBe('working')
  })

  it('omits ask for unparseable prompts and disconnected SSH hosts', async () => {
    const sources = observeSources({
      agentStatus: async () => ({ running: true, status: 'permission' }),
      prompt: async () => null
    })
    expect(await entryFor(sidebarRow(), sources)).not.toHaveProperty('ask')
    expect(
      await entryFor(sidebarRow({ hostId: 'ssh:box', hostUnavailable: true }), sources)
    ).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
  })
})

describe('observeSession: execution verdict', () => {
  it('reads a live, idle agent pane', async () => {
    const entry = await entryFor(sidebarRow(), observeSources())
    expect(entry).toMatchObject({ verdict: 'live', state: 'idle', terminal: 'term_1' })
    expect(entry.lastActivityAt).toBe(1_000)
  })

  it('never reads an SSH pane this computer cannot see as exited', async () => {
    const entry = await entryFor(
      sidebarRow({ hostId: 'ssh:box', tabId: null }),
      observeSources({ resolvePane: () => null })
    )
    expect(entry).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
  })

  it('reads a disconnected host as unverifiable', async () => {
    const entry = await entryFor(
      sidebarRow({ hostId: 'ssh:box', hostUnavailable: true }),
      observeSources()
    )
    expect(entry.verdict).toBe('unverifiable')
    expect(entry.waitingOn).toContain('not connected')
  })

  it.each([
    ['conflicting-provenance', 'saved details name more than one computer'],
    ['unresolved-workspace', 'recorded on more than one computer']
  ] as const)(
    'lists a quarantined (%s) row as unverifiable with its reason',
    async (ownershipUnverified, reason) => {
      const entry = await entryFor(sidebarRow({ ownershipUnverified }), observeSources())
      expect(entry).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
      expect(entry.waitingOn).toContain(reason)
    }
  )

  it('reads a session on another OmniConsole as unverifiable', async () => {
    const entry = await entryFor(sidebarRow({ hostId: 'runtime:env-1' }), observeSources())
    expect(entry).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
  })

  it('reads a local row with no tab and no terminal as exited', async () => {
    const entry = await entryFor(
      sidebarRow({ tabId: null, resumable: true }),
      observeSources({ resolvePane: () => null })
    )
    expect(entry).toMatchObject({ verdict: 'exited', state: 'exited', terminal: null })
  })

  it('does not assume an open tab without an attached terminal is dead', async () => {
    const entry = await entryFor(sidebarRow(), observeSources({ resolvePane: () => null }))
    expect(entry.verdict).toBe('unverifiable')
  })

  it('keeps the runtime’s own unverifiable reason', async () => {
    const entry = await entryFor(
      sidebarRow(),
      observeSources({ livenessUnverifiable: () => 'its SSH provider is no longer registered' })
    )
    expect(entry).toMatchObject({
      verdict: 'unverifiable',
      waitingOn: 'its SSH provider is no longer registered'
    })
  })

  it('reads an ended local terminal as exited', async () => {
    const entry = await entryFor(
      sidebarRow(),
      observeSources({
        resolvePane: () => ({ handle: 'term_1', connected: false, ptyId: 'pty-1' })
      })
    )
    expect(entry.verdict).toBe('exited')
  })

  it('needs its provider’s exit receipt: a detached or restoring terminal is unverifiable', async () => {
    const noReceipt = { exitReceipt: () => false }
    const detached = await entryFor(
      sidebarRow(),
      observeSources({
        ...noReceipt,
        resolvePane: () => ({ handle: 'term_1', connected: false, ptyId: 'pty-1' })
      })
    )
    expect(detached).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
    expect(detached.waitingOn).toContain('may be restoring')
    const unattached = await entryFor(
      sidebarRow(),
      observeSources({
        ...noReceipt,
        resolvePane: () => ({ handle: 'term_1', connected: true, ptyId: null })
      })
    )
    expect(unattached.verdict).toBe('unverifiable')
    const gone = await entryFor(
      sidebarRow(),
      observeSources({ ...noReceipt, agentStatus: async () => 'gone' })
    )
    expect(gone.verdict).toBe('unverifiable')
    // A launch still starting is never read as ended, receipt or not.
    const starting = await entryFor(
      sidebarRow({ launchPending: true }),
      observeSources({ resolvePane: () => ({ handle: 'term_1', connected: false, ptyId: null }) })
    )
    expect(starting.verdict).toBe('unverifiable')
  })

  it('calls a live pane’s agent exited only from a process table read now', async () => {
    // No process reading: the window's cached shell mark proves nothing either way.
    const blind = observeSources({
      agentStatus: async () => ({ running: false, status: null }),
      evidence: async () => null
    })
    const cached = await entryFor(sidebarRow({ shellForeground: true }), blind)
    expect(cached).toMatchObject({ verdict: 'unverifiable', state: 'unknown' })
    const gone = observeSources({
      agentStatus: async () => ({ running: false, status: null }),
      evidence: async () =>
        agentEvidence({
          foreground: { kind: 'shell' },
          process: null,
          tree: { kind: 'agent-gone' }
        })
    })
    expect((await entryFor(sidebarRow(), gone)).verdict).toBe('exited')
    const ssh = await entryFor(sidebarRow({ hostId: 'ssh:box' }), gone)
    expect(ssh).toMatchObject({ verdict: 'exited', state: 'exited' })
    expect(await entryFor(sidebarRow({ hostId: 'ssh:box' }), blind)).toMatchObject({
      verdict: 'unverifiable',
      state: 'unknown'
    })
    expect(
      await entryFor(sidebarRow({ hostId: 'ssh:box', launchPending: true }), gone)
    ).toMatchObject({ verdict: 'live', state: 'unknown' })
  })

  it('reads a terminal read failure as unverifiable', async () => {
    const entry = await entryFor(
      sidebarRow(),
      observeSources({
        agentStatus: async () => {
          throw new Error('boom')
        }
      })
    )
    expect(entry.verdict).toBe('unverifiable')
  })
})

describe('observeSession: agent state', () => {
  it('reads working, permission and question from the hook row', async () => {
    const hook = (
      state: 'working' | 'blocked' | 'waiting' | 'done',
      interactivePrompt: string | null = null
    ) => observeSources({ hook: () => ({ state, interactivePrompt, updatedAt: 5, agentPid: 200 }) })
    expect((await entryFor(sidebarRow(), hook('working'))).state).toBe('working')
    expect((await entryFor(sidebarRow(), hook('blocked'))).state).toBe('awaiting-user')
    const asked = await entryFor(sidebarRow(), hook('done', 'Which branch should I use?'))
    expect(asked).toMatchObject({ state: 'awaiting-user' })
    expect(asked.waitingOn).toContain('Which branch should I use?')
  })

  it('reads a live permission prompt even without a hook row', async () => {
    const entry = await entryFor(
      sidebarRow(),
      observeSources({
        hook: () => null,
        agentStatus: async () => ({ running: true, status: 'permission' })
      })
    )
    expect(entry.state).toBe('awaiting-user')
  })

  it('reads its queue, its own steps and its Keep going', async () => {
    const queue = {
      source: { worktreeId: 'repo::/w', paneKey: 'tab-1:leaf-1', kind: 'pty' },
      entries: [
        { id: 'a', text: 'next', createdAt: 1, state: 'queued' },
        { id: 'b', text: 'done', createdAt: 1, state: 'delivered' }
      ]
    } as PromptQueue
    const withQueue = await entryFor(sidebarRow(), observeSources({ queue: () => queue }))
    expect(withQueue).toMatchObject({ state: 'queued', queueLength: 1 })
    const withSteps = await entryFor(
      sidebarRow(),
      observeSources({ ownSteps: async () => ['Add tests', 'Ship it'], keepGoing: () => true })
    )
    expect(withSteps).toMatchObject({
      state: 'waiting-for-yes',
      pendingSteps: ['Add tests', 'Ship it'],
      keepGoing: true
    })
  })

  it('reads a usage-limited recovery as provider-limited', async () => {
    const queue = {
      source: { worktreeId: 'repo::/w', paneKey: 'tab-1:leaf-1', kind: 'pty' },
      entries: [],
      recovery: { phase: 'waiting-capacity', sourceResetAt: 99 }
    } as unknown as PromptQueue
    expect((await entryFor(sidebarRow(), observeSources({ queue: () => queue }))).state).toBe(
      'provider-limited'
    )
  })

  it('reads a chat session from its host, and a missing host as unverifiable', async () => {
    const chat = sidebarRow({
      kind: 'structured',
      structuredSessionId: 'sess-1',
      paneKey: structuredConversationSource('repo::/w', 'sess-1').paneKey
    })
    expect((await entryFor(chat, observeSources())).verdict).toBe('unverifiable')
    for (const reading of [null, { status: null, updatedAt: 7 }]) {
      expect(
        (await entryFor(chat, observeSources({ chat: () => ({ held: true, reading }) }))).verdict
      ).toBe('unverifiable')
    }
    const working = await entryFor(
      chat,
      observeSources({
        chat: () => ({ held: true, reading: { status: 'working', updatedAt: 7 } })
      })
    )
    expect(working).toMatchObject({
      kind: 'chat',
      verdict: 'live',
      state: 'working',
      lastActivityAt: 7
    })
    const asking = await entryFor(
      chat,
      observeSources({
        chat: () => ({ held: true, reading: { status: 'attention', updatedAt: 7 } })
      })
    )
    expect(asking.state).toBe('awaiting-user')
  })
})

describe('listSessionManageEntries', () => {
  const rows = [
    sidebarRow(),
    sidebarRow({ rowKey: 'b', paneKey: 'tab-2:leaf-1', tabId: 'tab-2', archived: true }),
    sidebarRow({
      rowKey: 'c',
      paneKey: 'tab-3:leaf-1',
      tabId: 'tab-3',
      folderId: 'f-1',
      folder: 'Ads'
    })
  ]

  it('leaves archived sessions out unless asked', async () => {
    expect(await listSessionManageEntries(rows, observeSources())).toHaveLength(2)
    expect(
      await listSessionManageEntries(rows, observeSources(), { includeArchived: true })
    ).toHaveLength(3)
  })

  it('lists a conversation once, yet keeps its other panes addressable', async () => {
    const withFolded = [
      ...rows,
      sidebarRow({ rowKey: 'd', paneKey: 'tab-4:leaf-1', tabId: 'tab-4', folded: true })
    ]
    expect(await listSessionManageEntries(withFolded, observeSources())).toHaveLength(2)
    expect(findSessionManageRow(withFolded, { paneKey: 'tab-4:leaf-1' })?.rowKey).toBe('d')
  })

  it('filters by folder and state', async () => {
    const inFolder = await listSessionManageEntries(rows, observeSources(), { folderId: 'f-1' })
    expect(inFolder.map((entry) => entry.folder)).toEqual(['Ads'])
    expect(await listSessionManageEntries(rows, observeSources(), { states: ['working'] })).toEqual(
      []
    )
  })

  it('filters by execution host before observing and keeps unknown provenance separate', async () => {
    const resolvePane = vi.fn(() => ({ handle: 'term_1', connected: true, ptyId: 'pty-1' }))
    const entries = await listSessionManageEntries(
      [
        sidebarRow({ title: 'Local', hostId: 'local' }),
        sidebarRow({ title: 'Unknown', hostId: null }),
        sidebarRow({ title: 'Remote', hostId: 'ssh:box/one' })
      ],
      observeSources({ resolvePane }),
      { hostId: 'ssh:box%2Fone' }
    )
    expect(entries.map((entry) => entry.title)).toEqual(['Remote'])
    expect(resolvePane).toHaveBeenCalledTimes(1)
  })

  it('finds disconnected matching work without promoting its state or searching transcripts', async () => {
    const entries = await listSessionManageEntries(
      [
        sidebarRow({
          title: 'Budget parser',
          hostId: 'ssh:box',
          hostUnavailable: true,
          folder: 'Marketing'
        }),
        sidebarRow({ title: 'Budget parser', hostId: 'local', folder: 'Engineering' })
      ],
      observeSources(),
      { query: 'MARKETING budget' }
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      hostId: 'ssh:box',
      verdict: 'unverifiable',
      state: 'unknown'
    })
    expect(
      await listSessionManageEntries(rows, observeSources(), { query: 'missing-history' })
    ).toEqual([])
  })

  it('finds a named pane exactly, and a bare tab by its own row', () => {
    expect(findSessionManageRow(rows, { paneKey: 'tab-3:leaf-1' })?.rowKey).toBe('c')
    expect(findSessionManageRow(rows, { tabId: 'tab-2' })?.rowKey).toBe('b')
    expect(findSessionManageRow(rows, { paneKey: 'nope' })).toBeNull()
  })

  it('never substitutes a sibling pane of the tab for a named pane that is gone', () => {
    // `--terminal` names both; the split it named closed, its tab still has another conversation.
    expect(findSessionManageRow(rows, { paneKey: 'tab-3:leaf-2', tabId: 'tab-3' })).toBeNull()
    expect(findSessionManageRow(rows, { paneKey: 'tab-3:leaf-1', tabId: 'tab-9' })).toBeNull()
    expect(findSessionManageRow(rows, { paneKey: 'tab-3:leaf-1', tabId: 'tab-3' })?.rowKey).toBe(
      'c'
    )
  })
})
