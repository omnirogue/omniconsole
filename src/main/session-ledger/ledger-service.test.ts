import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRead } from './ledger-commit-observer'
import { OMNI_LEDGER_ATTEMPT_ID_ENV, OMNI_LEDGER_SESSION_ID_ENV } from './ledger-identity'
import {
  ledgerServiceHarness as harness,
  memoryPaneStore,
  PANE,
  type GitIdentity
} from './ledger-service-fixture'

// Why: the service is exercised through injected deps; these imports only need to be inert.
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { subscribeEnrichedStatus: () => () => {} }
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('../backoffice/console-workflow-person', () => ({
  currentConsolePublicationScope: () => ({ principal: 'principal-a' })
}))
vi.mock('../backoffice/console-workflow-transport', () => ({
  requestConsoleWorkflow: vi.fn()
}))
vi.mock('./ledger-muted-repos', () => ({ readMutedRepos: () => [], setRepoMuted: () => [] }))

const LEDGER_FLUSH = 15_000
const OTHER_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'

type Harness = ReturnType<typeof harness>

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('session ledger service', () => {
  it('stamps a pane with both env vars and reports the repo once git answers', async () => {
    const h = harness()
    const env = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/Users/maintainer/repo' })
    expect(env[OMNI_LEDGER_SESSION_ID_ENV]).toMatch(/^als_[a-f0-9]{24}$/)
    expect(env[OMNI_LEDGER_ATTEMPT_ID_ENV]).toMatch(/^att_[a-f0-9]{16}$/)
    await vi.advanceTimersByTimeAsync(0)
    h.hook({ hookEventName: 'SessionStart', providerSession: { id: 'claude-uuid' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent[0]).toMatchObject({
      ledger_id: env[OMNI_LEDGER_SESSION_ID_ENV],
      attempt_id: env[OMNI_LEDGER_ATTEMPT_ID_ENV],
      app: 'omni-ide',
      agent: 'claude',
      host: 'test-host',
      native_session_id: 'claude-uuid',
      repo: 'github.com/Org/Repo',
      branch: 'feat/x',
      events: [{ seq: 1, kind: 'session_start', detail: { cwd_kind: 'repo', agent: 'claude' } }]
    })
    expect(h.sent[0]).not.toHaveProperty('employee_id')
    expect(h.service.localSessions()).toEqual([
      expect.objectContaining({ paneId: PANE, ledgerId: env[OMNI_LEDGER_SESSION_ID_ENV] })
    ])
  })

  it('publishes file writes repo-relative and stops on the turn end, PTY exit and tab close', async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/Users/maintainer/repo' })
    h.hook({ hookEventName: 'UserPromptSubmit' })
    h.hook({
      hookEventName: 'PreToolUse',
      payload: { agentType: 'claude', toolName: 'Edit', toolInput: '/Users/maintainer/repo/src/a.ts' }
    })
    h.hook({ hookEventName: 'Stop' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.kinds()).toEqual(['session_start', 'file_write', 'stop'])
    expect(
      h.sent.flatMap((batch) => batch.events).find((event) => event.kind === 'file_write')
    ).toMatchObject({ detail: { path: 'src/a.ts', op: 'edit' } })
    expect(h.service.localSessions()).toHaveLength(1)

    h.teardown(PANE)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent.at(-1)?.events.at(-1)).toMatchObject({ kind: 'stop', detail: { reason: 'exit' } })
    expect(h.service.localSessions()).toEqual([])
    // A second exit for the same attempt is not a second stop.
    h.teardown(PANE)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.kinds().filter((kind) => kind === 'stop')).toHaveLength(2)
  })

  it('keeps the ledger id across a resume in the same pane and sends attempt_start', async () => {
    const h = harness()
    const first = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    h.teardown(PANE)
    const second = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-2', cwd: '/repo' })
    expect(second[OMNI_LEDGER_SESSION_ID_ENV]).toBe(first[OMNI_LEDGER_SESSION_ID_ENV])
    expect(second[OMNI_LEDGER_ATTEMPT_ID_ENV]).not.toBe(first[OMNI_LEDGER_ATTEMPT_ID_ENV])
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    const last = h.sent.at(-1)
    expect(last?.attempt_id).toBe(second[OMNI_LEDGER_ATTEMPT_ID_ENV])
    expect(last?.events[0]).toMatchObject({
      seq: 1,
      kind: 'attempt_start',
      detail: { reason: 'resume' }
    })
  })

  it('gives a pane seen only through hooks (an SSH pane) its own row', async () => {
    const h = harness()
    h.hook({
      paneKey: OTHER_PANE,
      hookEventName: 'UserPromptSubmit',
      source: 'codex',
      payload: { agentType: 'codex' }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent[0]).toMatchObject({ agent: 'codex', events: [{ kind: 'session_start' }] })
    expect(h.service.localSessions()[0]?.paneId).toBe(OTHER_PANE)
  })

  it('closes — never exits — a remote pane on teardown; a local pane exits', async () => {
    const h = harness()
    // Local: spawned here, its PTY exit is its process ending.
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    // Remote: hooks over an SSH connection, never spawned here.
    h.hook({
      paneKey: OTHER_PANE,
      hookEventName: 'UserPromptSubmit',
      connectionId: 'ssh-conn-1',
      source: 'claude',
      payload: { agentType: 'claude' }
    })
    await vi.advanceTimersByTimeAsync(0)
    h.teardown(PANE)
    h.teardown(OTHER_PANE)
    await vi.advanceTimersByTimeAsync(0)
    const stops = h.sent
      .flatMap((batch) => batch.events.map((event) => [batch.ledger_id, event] as const))
      .filter(([, event]) => event.kind === 'stop')
      .map(([ledgerId, event]) => [ledgerId, (event.detail as { reason: string }).reason])
    const local = h.sent[0]!.ledger_id
    const remote = h.sent.find((batch) => batch.ledger_id !== local)!.ledger_id
    expect(stops).toEqual(
      expect.arrayContaining([
        [local, 'exit'],
        [remote, 'close']
      ])
    )
    expect(stops.some(([ledgerId, reason]) => ledgerId === remote && reason === 'exit')).toBe(false)
  })

  it('ends every row of a closed tab with stop{close}', async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'SessionStart' })
    h.service.onTabClosed('tab-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent.at(-1)?.events.at(-1)).toMatchObject({
      kind: 'stop',
      detail: { reason: 'close' }
    })
    expect(h.service.localSessions()).toEqual([])
  })

  it('ignores relay replays and identity-only updates but keeps the native id', async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'UserPromptSubmit', isReplay: true })
    h.hook({
      hookEventName: 'SessionStart',
      providerSessionOnly: true,
      providerSession: { id: 'n-1' }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent).toEqual([])
    h.hook({ hookEventName: 'UserPromptSubmit' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent[0]?.native_session_id).toBe('n-1')
  })

  it('forwards the wait mark as register({waiting})', async () => {
    const h = harness()
    await h.service.setWaiting('als_0123456789abcdef01234567', true)
    await h.service.setWaiting('als_0123456789abcdef01234567', false)
    expect(h.registered).toEqual([])
    // Why: a wait mark only reaches the console for a row this desktop opened (and its account).
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'SessionStart' })
    const ledgerId = h.service.localSessions()[0]!.ledgerId
    await h.service.setWaiting(ledgerId, true)
    await h.service.setWaiting(ledgerId, false)
    expect(h.registered).toEqual([
      [ledgerId, { waiting: true }, 'principal-a'],
      [ledgerId, { waiting: false }, 'principal-a']
    ])
  })

  it('records the task a person put this conversation in, by pane key or by ledger id', async () => {
    const h = harness()
    // A pane this desktop holds no row for is answered, never thrown at.
    expect(await h.service.linkCard('tab-9:missing', { cardId: 'btk_1234', cardTitle: 'X' })).toBe(
      false
    )
    expect(h.registered).toEqual([])

    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'SessionStart' })
    const ledgerId = h.service.localSessions()[0]!.ledgerId
    expect(
      await h.service.linkCard(PANE, { cardId: 'btk_1234abcd', cardTitle: 'Ship the ledger' })
    ).toBe(true)
    expect(h.registered).toEqual([
      [ledgerId, { card_id: 'btk_1234abcd', card_title: 'Ship the ledger' }, 'principal-a']
    ])
    expect(h.service.localSessions()[0]!.cardId).toBe('btk_1234abcd')

    // The renderer may hold the ledger id instead of the pane key; both name the same row.
    expect(
      await h.service.linkCard(ledgerId, { cardId: 'btk_5678efgh', cardTitle: 'Second' })
    ).toBe(true)
    expect(h.registered.at(-1)).toEqual([
      ledgerId,
      { card_id: 'btk_5678efgh', card_title: 'Second' },
      'principal-a'
    ])
  })

  it('never lets a workspace without a link of its own clear the task a person chose', async () => {
    const h = harness()
    const meta = new Map<
      string,
      { linkedWorkItem?: { hubTaskId?: string; title: string } | null }
    >()
    let notify: (() => void) | null = null
    h.service.attachWorkspaceLinks({
      source: { getWorktreeMeta: (id) => meta.get(id) as never },
      subscribeWorkspaceChanges: (listener) => {
        notify = listener
        return () => {}
      }
    })
    meta.set('wt-unlinked', {})
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', worktreeId: 'wt-unlinked' })
    h.hook({ hookEventName: 'SessionStart', worktreeId: 'wt-unlinked' })
    await h.service.linkCard(PANE, { cardId: 'btk_person01', cardTitle: 'Person link' })
    expect(h.service.localSessions()[0]!.cardId).toBe('btk_person01')

    // The workspace answering "no link" is silence, not an instruction to unfile the work.
    notify!()
    expect(h.service.localSessions()[0]!.cardId).toBe('btk_person01')

    // An explicit workspace link still wins.
    meta.set('wt-unlinked', { linkedWorkItem: { hubTaskId: 'btk_work0001', title: 'Workspace' } })
    notify!()
    expect(h.service.localSessions()[0]!.cardId).toBe('btk_work0001')
    expect(h.registered.at(-1)).toEqual([
      h.service.localSessions()[0]!.ledgerId,
      { card_id: 'btk_work0001', card_title: 'Workspace' },
      'principal-a'
    ])
  })

  it('waits for the task registration before returning a link for context recovery', async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    let accept!: () => void
    vi.mocked(h.client.register).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = () => resolve({ ok: true })
        })
    )
    let settled = false
    const link = h.service
      .linkCard(PANE, { cardId: 'btk_parent', cardTitle: 'Parent' })
      .then((value) => {
        settled = true
        return value
      })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    accept()
    expect(await link).toBe(true)
  })

  it("refuses another account's pane without rewriting its local task link", async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'SessionStart' })
    await h.service.linkCard(PANE, { cardId: 'btk_original', cardTitle: 'Original' })
    h.account.current = 'principal-b'
    expect(await h.service.linkCard(PANE, { cardId: 'btk_wrong', cardTitle: 'Wrong' })).toBe(false)
    h.account.current = 'principal-a'
    expect(h.service.localSessions()[0]!.cardId).toBe('btk_original')
    expect(
      h.registered.some(([, body]) => (body as { card_id?: string }).card_id === 'btk_wrong')
    ).toBe(false)
  })

  it('does not acknowledge a task link to the replacement account after a slow write', async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    await vi.advanceTimersByTimeAsync(0)
    let accept!: () => void
    vi.mocked(h.client.register).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = () => resolve({ ok: true })
        })
    )
    const link = h.service.linkCard(PANE, { cardId: 'btk_parent', cardTitle: 'Parent' })
    h.account.current = 'principal-b'
    accept()
    expect(await link).toBe(false)
  })

  it('resolves a quit within two seconds while the console hangs, spilling stop{quit}', async () => {
    const h = harness({ hang: true })
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'SessionStart' })
    let settled = false
    const shutdown = h.service.shutdown().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await shutdown
    expect(settled).toBe(true)
    const spilled = JSON.stringify(h.spill.value)
    expect(spilled).toContain('"quit"')
    expect(spilled).toContain('principal-a')
  })

  it('sends the explicitly linked card, null without one, and registers a link added later', async () => {
    const h = harness()
    const meta = new Map<
      string,
      { linkedWorkItem?: { hubTaskId?: string; title: string } | null }
    >()
    let notify: (() => void) | null = null
    h.service.attachWorkspaceLinks({
      source: { getWorktreeMeta: (id) => meta.get(id) as never },
      subscribeWorkspaceChanges: (listener) => {
        notify = listener
        return () => {}
      }
    })
    meta.set('wt-linked', {
      linkedWorkItem: { hubTaskId: 'btk_abcd1234', title: 'Ship the ledger' }
    })
    meta.set('wt-branchy', { linkedWorkItem: { title: 'admitted nowhere' } })

    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', worktreeId: 'wt-linked' })
    h.hook({ hookEventName: 'SessionStart', worktreeId: 'wt-linked' })
    h.service.stampPaneEnv({ paneKey: OTHER_PANE, ptyId: 'pty-2', worktreeId: 'wt-branchy' })
    h.hook({ paneKey: OTHER_PANE, hookEventName: 'SessionStart', worktreeId: 'wt-branchy' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent[0]).toMatchObject({ card_id: 'btk_abcd1234', card_title: 'Ship the ledger' })
    expect(h.sent[1]).toMatchObject({ card_id: null, card_title: null })
    expect(h.registered).toEqual([])

    // The link lands on the second workspace while its pane is live.
    meta.set('wt-branchy', { linkedWorkItem: { hubTaskId: 'btk_late9999', title: 'Late link' } })
    notify!()
    expect(h.registered).toEqual([
      [h.sent[1]!.ledger_id, { card_id: 'btk_late9999', card_title: 'Late link' }, 'principal-a']
    ])
    expect(h.service.localSessions().find((row) => row.paneId === OTHER_PANE)?.cardId).toBe(
      'btk_late9999'
    )
  })

  it('binds every batch to the account the row was opened under', async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1' })
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sentAccounts).toEqual(['principal-a'])
  })

  it('holds a repo register that resolves after the account flipped, and sends it once that account is back', async () => {
    let resolveGit: (identity: GitIdentity) => void = () => {}
    const h = harness({
      resolveGitIdentity: () =>
        new Promise<GitIdentity>((resolve) => {
          resolveGit = resolve
        })
    })
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent).toHaveLength(1)

    h.account.current = 'principal-b'
    resolveGit({ repo: 'github.com/Org/Repo', branch: 'main' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.registered).toEqual([])

    h.account.current = 'principal-a'
    h.hook({ hookEventName: 'UserPromptSubmit' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.registered).toEqual([
      [h.sent[0]!.ledger_id, { repo: 'github.com/Org/Repo', branch: 'main' }, 'principal-a']
    ])
  })

  it('keeps a row bound to the account it was opened under across an account switch', async () => {
    const h = harness()
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/Users/maintainer/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sentAccounts).toEqual(['principal-a'])

    h.account.current = 'principal-b'
    h.hook({
      hookEventName: 'PreToolUse',
      payload: { agentType: 'claude', toolName: 'Edit', toolInput: '/Users/maintainer/repo/src/a.ts' }
    })
    h.hook({ hookEventName: 'Stop' })
    await vi.advanceTimersByTimeAsync(60_000)
    // Nothing of A's row travels under B; it waits on disk, bound to A, and B does not see the row.
    expect(h.sentAccounts).toEqual(['principal-a'])
    expect(
      (h.spill.value as { batches: { account: string }[] }).batches.map((b) => b.account)
    ).toEqual(['principal-a'])
    expect(h.service.localSessions()).toEqual([])

    h.account.current = 'principal-a'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sentAccounts).toEqual(['principal-a', 'principal-a'])
    expect(h.kinds()).toEqual(['session_start', 'file_write', 'stop'])
    expect(h.service.localSessions()).toHaveLength(1)
  })

  it('restores a pane with the account it was opened under; another sign-in gets its own row, never a resume', async () => {
    const paneStore = memoryPaneStore()
    const first = harness({ paneStore })
    const env = first.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    first.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(first.sentAccounts).toEqual(['principal-a'])
    expect(paneStore.load()[0]).toMatchObject({ paneKey: PANE, account: 'principal-a' })

    // Same person after a restart: the row resumes.
    const again = harness({ paneStore })
    const resumed = again.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-2', cwd: '/repo' })
    expect(resumed[OMNI_LEDGER_SESSION_ID_ENV]).toBe(env[OMNI_LEDGER_SESSION_ID_ENV])
    again.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(again.sent[0]?.events[0]).toMatchObject({ kind: 'attempt_start' })
    expect(again.sentAccounts).toEqual(['principal-a'])

    // Another person after a restart: A's row is not continued; B's spawn is B's own row.
    const second = harness({ paneStore, account: 'principal-b' })
    const fresh = second.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-3', cwd: '/repo' })
    expect(fresh[OMNI_LEDGER_SESSION_ID_ENV]).not.toBe(env[OMNI_LEDGER_SESSION_ID_ENV])
    second.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(second.sent).toHaveLength(1)
    expect(second.sent[0]).toMatchObject({
      ledger_id: fresh[OMNI_LEDGER_SESSION_ID_ENV],
      events: [{ kind: 'session_start' }]
    })
    expect(second.sentAccounts).toEqual(['principal-b'])
    expect(second.service.localSessions()).toHaveLength(1)
  })

  it('lets only the first principal seen claim a row this run spawned while signed out, while its PTY lives', async () => {
    // The startup race: the pane spawns before console auth resolves, then the same person signs in.
    const h = harness({ account: null })
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/Users/maintainer/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    h.hook({
      hookEventName: 'PreToolUse',
      payload: { agentType: 'claude', toolName: 'Edit', toolInput: '/Users/maintainer/repo/src/a.ts' }
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.client.events).not.toHaveBeenCalled()
    expect((h.spill.value as { batches: { account: null }[] }).batches[0]?.account).toBeNull()
    // Signed out, the ownerless row is not listed as anyone's to mark.
    expect(h.service.localSessions()).toHaveLength(1)

    h.account.current = 'principal-a'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sentAccounts).toEqual(['principal-a'])
    expect(h.kinds()).toEqual(['session_start', 'file_write'])
    expect(h.spill.value).toBeNull()
    expect(h.service.localSessions()).toHaveLength(1)
  })

  it('never releases an ownerless row once another principal was seen or it was restored (B1)', async () => {
    // Two principals were seen since the row was spawned: neither can take what the other might own.
    const seen = harness({ account: null })
    seen.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    seen.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    seen.account.current = 'principal-a'
    seen.service.localSessions()
    seen.account.current = 'principal-b'
    seen.hook({ hookEventName: 'Stop' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    seen.account.current = 'principal-a'
    seen.hook({ hookEventName: 'UserPromptSubmit' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(seen.client.events).not.toHaveBeenCalled()
    expect(seen.registered).toEqual([])
    // A signed-in person never sees, and so can never mark, an ownerless row.
    expect(seen.service.localSessions()).toEqual([])
    expect(
      (seen.spill.value as { batches: { account: null }[] }).batches.every(
        (b) => b.account === null
      )
    ).toBe(true)

    // Restored from a previous run with no owner: never claimed, and a new spawn gets its own row.
    const paneStore = memoryPaneStore()
    const before = harness({ account: null, paneStore })
    const old = before.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    before.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    const spilled = before.spill.value
    const after = harness({ account: 'principal-b', paneStore, start: false })
    after.spill.value = spilled
    after.service.start({ userDataPath: '/unused' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(after.client.events).not.toHaveBeenCalled()
    const fresh = after.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-2', cwd: '/repo' })
    expect(fresh[OMNI_LEDGER_SESSION_ID_ENV]).not.toBe(old[OMNI_LEDGER_SESSION_ID_ENV])
    after.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(after.sent.map((batch) => batch.ledger_id)).toEqual([fresh[OMNI_LEDGER_SESSION_ID_ENV]])
    expect(after.sentAccounts).toEqual(['principal-b'])
  })

  it('gives up ownerless batches whose row is gone, so they cannot pin the queue or starve the signed-in account', async () => {
    const h = harness({ account: null })
    h.service.stampPaneEnv({ paneKey: OTHER_PANE, ptyId: 'pty-9', cwd: '/repo' })
    h.hook({ paneKey: OTHER_PANE, hookEventName: 'SessionStart' })
    for (let index = 0; index < 250; index += 1) {
      h.hook({
        paneKey: OTHER_PANE,
        hookEventName: 'PreToolUse',
        payload: { agentType: 'claude', toolName: 'Read', toolInput: 'x' }
      })
    }
    // The tab closes before anyone signs in: stop{close} joins the ownerless batch, the pane is gone.
    h.service.onTabClosed('tab-2')
    await vi.advanceTimersByTimeAsync(0)

    h.account.current = 'principal-a'
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    h.hook({ hookEventName: 'Stop' })
    await vi.advanceTimersByTimeAsync(60_000)
    // A's own start and stop went out; the orphan batch costs A nothing and is never A's.
    expect(h.sentAccounts).toEqual(['principal-a', 'principal-a'])
    expect(h.kinds()).toEqual(['session_start', 'stop'])
    expect(
      (h.spill.value as { batches: { account: string | null }[] }).batches.map((b) => b.account)
    ).toEqual([null])
    // Only age gives it up — not the removal itself.
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000)
    expect(h.spill.value).toBeNull()
  })

  it('delivers a row opened and ended while signed out once the sole principal signs in and spawns again (C1)', async () => {
    const h = harness({ account: null })
    const first = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/Users/maintainer/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    h.hook({
      hookEventName: 'PreToolUse',
      payload: { agentType: 'claude', toolName: 'Edit', toolInput: '/Users/maintainer/repo/src/a.ts' }
    })
    h.teardown(PANE)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.client.events).not.toHaveBeenCalled()

    // A signs in and immediately spawns again in the same pane, before any flush ran.
    h.account.current = 'principal-a'
    const again = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-2', cwd: '/Users/maintainer/repo' })
    expect(again[OMNI_LEDGER_SESSION_ID_ENV]).toBe(first[OMNI_LEDGER_SESSION_ID_ENV])
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sentAccounts.every((account) => account === 'principal-a')).toBe(true)
    expect(h.kinds()).toEqual(['session_start', 'file_write', 'stop', 'attempt_start'])
    expect(h.sent.every((batch) => batch.ledger_id === first[OMNI_LEDGER_SESSION_ID_ENV])).toBe(
      true
    )
    expect(h.spill.value).toBeNull()
  })

  it("holds — never discards — a signed-out row's batch when two people sign in before the queue runs", async () => {
    const h = harness({ account: null })
    const first = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    h.teardown(PANE)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.client.events).not.toHaveBeenCalled()

    h.account.current = 'principal-a'
    h.service.localSessions()
    h.account.current = 'principal-b'
    const own = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-2', cwd: '/repo' })
    expect(own[OMNI_LEDGER_SESSION_ID_ENV]).not.toBe(first[OMNI_LEDGER_SESSION_ID_ENV])
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(60_000)
    // B's own row went out as B; the old row's batch is still there, nobody's, not dropped.
    expect(h.sent.map((batch) => batch.ledger_id)).toEqual([own[OMNI_LEDGER_SESSION_ID_ENV]])
    const spilled = (
      h.spill.value as { batches: { account: string | null; batch: { ledger_id: string } }[] }
    ).batches
    expect(spilled).toEqual([
      expect.objectContaining({
        account: null,
        batch: expect.objectContaining({ ledger_id: first[OMNI_LEDGER_SESSION_ID_ENV] })
      })
    ])
    h.account.current = 'principal-a'
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.sent.map((batch) => batch.ledger_id)).toEqual([own[OMNI_LEDGER_SESSION_ID_ENV]])
  })

  it('binds nobody when two env builders for one spawn straddle a change of person', async () => {
    const h = harness({ account: null })
    const env = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.account.current = 'principal-a'
    h.service.localSessions()
    h.account.current = 'principal-b'
    const again = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    expect(again).toEqual(env)
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.client.events).not.toHaveBeenCalled()
    expect((h.spill.value as { batches: { account: null }[] }).batches[0]?.account).toBeNull()
  })

  it('binds the first start of a row opened while signed out only through the claim rule', async () => {
    const h = harness({ account: null })
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    // A was seen, then B; the first hook arrives under B: the row stays nobody's.
    h.account.current = 'principal-a'
    h.service.localSessions()
    h.account.current = 'principal-b'
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.client.events).not.toHaveBeenCalled()
    expect(h.service.localSessions()).toEqual([])
    expect((h.spill.value as { batches: { account: null }[] }).batches[0]?.account).toBeNull()
  })

  it("keeps a restored ownerless row's batches held, never deleted, until they age out", async () => {
    const paneStore = memoryPaneStore()
    const before = harness({ account: null, paneStore })
    before.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    before.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    const spilled = before.spill.value

    const after = harness({ account: 'principal-b', paneStore, start: false })
    after.spill.value = spilled
    after.service.start({ userDataPath: '/unused' })
    await vi.advanceTimersByTimeAsync(0)
    after.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-2', cwd: '/repo' })
    after.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(after.sentAccounts).toEqual(['principal-b'])
    expect(
      (after.spill.value as { batches: { account: string | null }[] }).batches.map((b) => b.account)
    ).toEqual([null])
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000)
    expect(after.spill.value).toBeNull()
  })

  it("gives a known principal spawning into a pane whose ownerless row may be someone else's a fresh row (B2)", async () => {
    const h = harness({ account: null })
    const ownerless = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    h.teardown(PANE)
    // A was seen while the row was live: B cannot take what may be A's.
    h.account.current = 'principal-a'
    h.service.localSessions()

    h.account.current = 'principal-b'
    const own = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-2', cwd: '/repo' })
    expect(own[OMNI_LEDGER_SESSION_ID_ENV]).not.toBe(ownerless[OMNI_LEDGER_SESSION_ID_ENV])
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sent.map((batch) => batch.ledger_id)).toEqual([own[OMNI_LEDGER_SESSION_ID_ENV]])
    expect(h.sent[0]?.events[0]).toMatchObject({ kind: 'session_start' })
    expect(h.sentAccounts).toEqual(['principal-b'])
    // The ownerless row's batches never travelled as B; they stay held (nobody's) until they age out.
    expect(h.sent.map((batch) => batch.ledger_id)).not.toContain(
      ownerless[OMNI_LEDGER_SESSION_ID_ENV]
    )
    expect(
      (h.spill.value as { batches: { account: string | null }[] }).batches.map((b) => b.account)
    ).toEqual([null])
  })

  it('fixes the owner at spawn when the principal is known, before any hook', async () => {
    const paneStore = memoryPaneStore()
    const h = harness({ paneStore })
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    expect(paneStore.load()[0]).toMatchObject({ paneKey: PANE, account: 'principal-a' })
    // Re-stamping the same spawn (two env builders) keeps the row and its owner.
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    expect(paneStore.load()).toHaveLength(1)
  })

  it('opens a new attempt when hooks continue after SessionEnd, and still stops on PTY exit', async () => {
    const h = harness()
    const env = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    h.hook({ hookEventName: 'SessionEnd' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.kinds()).toEqual(['session_start', 'stop'])
    expect(h.service.localSessions()).toEqual([])

    // A late Stop for the ended attempt does not reopen it.
    h.hook({ hookEventName: 'Stop' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.kinds()).toEqual(['session_start', 'stop'])

    // `/clear`: the same PTY keeps working on a new attempt of the same row.
    h.hook({ hookEventName: 'SessionStart', providerSession: { id: 'claude-uuid-2' } })
    h.hook({ hookEventName: 'UserPromptSubmit' })
    await vi.advanceTimersByTimeAsync(0)
    const reopened = h.sent.at(-1)
    expect(reopened?.ledger_id).toBe(env[OMNI_LEDGER_SESSION_ID_ENV])
    expect(reopened?.attempt_id).not.toBe(env[OMNI_LEDGER_ATTEMPT_ID_ENV])
    expect(reopened?.events[0]).toMatchObject({
      seq: 1,
      kind: 'attempt_start',
      detail: { reason: 'reconnect' }
    })
    expect(h.service.localSessions()).toHaveLength(1)

    h.teardown(PANE)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent.at(-1)).toMatchObject({
      attempt_id: reopened?.attempt_id,
      events: [{ kind: 'stop', detail: { reason: 'exit' } }]
    })
  })

  it('reports a commit made in the pane as commit{subject, files, sha} — subject only', async () => {
    let head = 'a'.repeat(40)
    const readGit: GitRead = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return head
      }
      if (args[0] === 'log') {
        return 'feat(x): the subject line\n\n 3 files changed, 10 insertions(+), 2 deletions(-)'
      }
      return null
    })
    const h = harness({ readGit })
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    await vi.advanceTimersByTimeAsync(0)
    h.hook({ hookEventName: 'SessionStart' })
    // A git command that did not move HEAD reports nothing.
    h.hook({
      hookEventName: 'PostToolUse',
      payload: { agentType: 'claude', toolName: 'Bash', toolInput: 'git commit -m "secret body"' }
    })
    await vi.advanceTimersByTimeAsync(0)
    head = 'b'.repeat(40)
    h.hook({
      hookEventName: 'PostToolUse',
      payload: { agentType: 'claude', toolName: 'Bash', toolInput: 'git commit -m "secret body"' }
    })
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH)
    const commit = h.sent.flatMap((batch) => batch.events).find((event) => event.kind === 'commit')
    expect(commit).toMatchObject({
      detail: { subject: 'feat(x): the subject line', files: 3, sha: 'b'.repeat(40) }
    })
    expect(h.kinds().filter((kind) => kind === 'commit')).toHaveLength(1)
    expect(JSON.stringify(h.sent)).not.toContain('secret body')
  })

  it('re-publishes the local rows when the signed-in person changes', async () => {
    const h = harness()
    const seen: number[] = []
    h.service.subscribeLocalSessions((rows) => seen.push(rows.length))
    h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.at(-1)).toBe(1)
    h.account.current = 'principal-b'
    h.hook({ hookEventName: 'UserPromptSubmit' })
    expect(seen.at(-1)).toBe(0)
    h.account.current = 'principal-a'
    h.hook({ hookEventName: 'UserPromptSubmit' })
    expect(seen.at(-1)).toBe(1)
  })

  it('keeps a pane stamped and a local-sessions subscription taken before start()', async () => {
    const h = harness({ start: false })
    const seen: number[] = []
    h.service.subscribeLocalSessions((rows) => seen.push(rows.length))
    const env = h.service.stampPaneEnv({ paneKey: PANE, ptyId: 'pty-1', cwd: '/repo' })
    h.service.start({ userDataPath: '/unused' })
    h.hook({ hookEventName: 'SessionStart' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent[0]?.ledger_id).toBe(env[OMNI_LEDGER_SESSION_ID_ENV])
    expect(seen.at(-1)).toBe(1)
  })

  it('answers now/peers through the client and never throws', async () => {
    const h: Harness = harness()
    await expect(h.service.now('live')).resolves.toEqual({
      ok: true,
      rows: [],
      overflow: 0,
      server_time: 't'
    })
    await expect(h.service.peers('als_0123456789abcdef01234567')).resolves.toEqual({
      ok: true,
      peers: []
    })
  })
})
