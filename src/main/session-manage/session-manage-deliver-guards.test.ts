/**
 * The guards on `continue` and `ask`: a free prompt goes only after a whole, finished reply with
 * nothing open, never carries an approval, and is fenced to that reply's content; `--yes`/`--choose`
 * pin the step's exact words; the queue's admission comes before Keep going changes; a failure
 * after that change is partial, never silent; and a terminal target needs its agent's own process.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { queueQuestion } from './session-manage-ask'
import { continueSession } from './session-manage-continue'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import {
  FREEFORM_NOT_AN_APPROVAL,
  UNREAD_TURN,
  type SessionLatestTurn
} from './session-manage-freeform'
import { SessionManagePartialError } from './session-manage-refusal'
import { agentProcess, manageEntry } from './session-manage-test-fixtures'
import { hardStopOf } from '../next-steps/next-step-keep-going-hard-stops'

const source: ConversationSource = { worktreeId: 'repo::/w', paneKey: 'tab-2:leaf-2', kind: 'pty' }
const manager: SessionManageActor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Manager' }

function proposals(titles: string[], turnKey = 't1'): NextStepSuggestionSet {
  return {
    id: 'set-1',
    conversation: source,
    worktreeId: source.worktreeId,
    turnKey,
    origin: 'parsed',
    createdAt: 1,
    status: 'pending',
    suggestions: titles.map((title, index) => ({
      id: `s${index + 1}`,
      title,
      prompt: `Please go ahead with this next step you suggested: ${title}`,
      risk: 'safe',
      kind: 'other',
      offered: true as const
    }))
  } as NextStepSuggestionSet
}

const SAFE_REPLY = 'The parser handles nested quotes now; the unit tests pass.'
const DEPLOY_QUESTION = 'Everything is green on staging. Should I deploy it to production now?'
// Actual refused peer report, 2026-09-26: only its artifact names matched deployment words.
const VERIFIED_REPORT = [
  'BOTH MACS VERIFIED on 77cf6a4060988e1a89ff50b89ca460ed0eacd01f (build 1.12.18-77cf6a406098-arm64).',
  'Identical payload digest b02d1796ceddd76eabafa41668569cc1774d68788904a55207baca09116b276a on the Mac Studio and laptop.',
  'codesign deep strict passes, including the nested helper. Installer checks all ok; no new crash or bootstrap-fatal lines.',
  'Runtime and graph ready on both. CDP 9334 is up on the Mac Studio (pid 48413).',
  'laptop was asleep 21:00–21:17Z and was installed right after it returned on its normal route.',
  'Evidence: rollout/installed-77cf/ and release-coordinator-status.md. Live capture can start.'
].join(' ')

// Exact code-coordination messages refused on 2026-09-27.
const OVERLAP_REPORT = [
  'From the Session Focus coordinator (b3974e): heads-up on overlap.',
  'PR #815 (laptop:bulk-selection-remote-sessions, branch fix/fleet-rows-bulk-select-0926, head ec622064f) edits the same files your fix/archive-bulk-cleanup-0926 changes: FleetDispatchRows.tsx, SessionBulkActionBar.tsx and SessionSidebar.tsx, plus SessionBulkActions.tsx and the selection hooks.',
  'Both change bulk select/archive/delete.',
  'Whichever lands second must merge main-next and re-run verify.',
  'Please open your PR against main-next when ready and coordinate with that session.',
  'The reliability audit (codex-omniconsole-reliability-audit-repairs) decides which PRs go into the next combined build; your request and owner refs are recorded in ~/Work/Ops/Projects/OmniConsole-Reliability-2026-09-26/rollout/release-coordinator-status.md.'
].join(' ')
const BRANCH_REPORT = [
  'Relayed from laptop:bulk-selection-remote-sessions (owner of #815), about your fix/archive-bulk-cleanup-0926: #815 (fix/fleet-rows-bulk-select-0926, head ec622064f) lands first. What it changes:',
  '(1) visibleSessionSelection walks group.fleetRows and returns fleetByKey.',
  '(2) useSelectedSidebarRows returns {sessions, fleet, routines, count}.',
  '(3) FleetDispatchRow gains an optional selection prop: Checkbox keyed by conversationFleetRowKey, data-session-key, role=option, roving tabIndex, and the modified-click gesture.',
  '(4) SessionSidebarList passes onSelectFleetRow through.',
  '(5) SessionBulkActionBar gains a fleetRows prop. Sourced receipts join items via their source session; sourceless ones join archivable/hideable as receiptItems.',
  '(6) SessionBulkActions acts on every non-routine selected key and reports sourceless receipts on Pause.',
  "(7) A group's Select all includes fleet rows.",
  '(8) SessionSidebar passes fleetRows to the bar.',
  'Please merge main-next after #815 lands and re-run verify, keeping the fleetRows/receiptItems paths intact. Reply to laptop:46a3e277-6ef5-424a-b9a3-12f3b1e0c85b.'
].join('\n')

/** A whole reply the host read, with the proposal parsed from it (none by default). */
const turn = (text: string | null, over: Partial<SessionLatestTurn> = {}): SessionLatestTurn => ({
  known: true,
  turnKey: 't1',
  text,
  complete: text !== null,
  proposal: null,
  empty: false,
  ...over
})

function deps(
  set: NextStepSuggestionSet | null,
  overrides: Partial<SessionDeliveryDeps> = {},
  latest: SessionLatestTurn = turn(SAFE_REPLY, {
    proposal: set ? JSON.stringify(set.suggestions) : null
  })
) {
  return {
    enqueue: vi.fn(),
    admission: vi.fn(() => null),
    bind: vi.fn<SessionDeliveryDeps['bind']>(() => vi.fn()),
    readLatestTurn: vi.fn(async () => latest),
    snapshotLatestTurn: vi.fn(() => latest),
    hasUnresolvedDraft: vi.fn(() => false),
    decideRelayed: vi.fn(async (_setId: string, id: string) => ({
      set: set!,
      queued: [id],
      notQueued: []
    })),
    stopKeepGoing: vi.fn(() => true),
    readOwnSteps: vi.fn(async () => ({ set, steps: set?.suggestions ?? [] })),
    newId: () => '3f9a1c2e-0000-4000-8000-000000000000',
    ...overrides
  } satisfies SessionDeliveryDeps
}

const target = (overrides = {}) => ({
  entry: manageEntry({ paneKey: source.paneKey, ...overrides }),
  source,
  agentProcess: agentProcess()
})

const prompt = (d: SessionDeliveryDeps, text: string, entry = {}) =>
  continueSession(d, {
    actor: manager,
    target: target(entry),
    answer: { kind: 'prompt', text },
    dryRun: false
  })

/** The conversation guard bound to the last queued prompt. */
const boundGuard = (d: SessionDeliveryDeps) =>
  vi.mocked(d.bind).mock.calls.at(-1)![2].conversationGuard!

const refused = async (d: SessionDeliveryDeps, text: string, words: RegExp, entry = {}) => {
  await expect(prompt(d, text, entry)).rejects.toThrow(words)
  expect(d.enqueue).not.toHaveBeenCalled()
  expect(d.stopKeepGoing).not.toHaveBeenCalled()
}

describe('a free prompt goes only after a whole reply with nothing open (review 3, R4-2)', () => {
  // Not one of these is on the approval list; each is refused by what the target proposed or asked.
  const unlisted = ['I approve', 'okay, do the recommended thing', 'yes, and keep me updated']

  it.each(unlisted)('refuses %j against a pending deploy proposal', async (text) => {
    const set = proposals(['Add the regression test', 'Deploy to production'])
    await refused(deps(set), text, /proposes next steps|use --yes or --choose/)
  })

  it.each(unlisted)('refuses %j after a reply asking to deploy, with no proposal', async (text) => {
    await refused(deps(null, {}, turn(DEPLOY_QUESTION)), text, /hard stop: deploy|use --yes/)
  })

  it.each(unlisted)(
    'refuses %j when the latest reply is unread, partial or missing',
    async (text) => {
      for (const latest of [UNREAD_TURN, turn(SAFE_REPLY, { complete: false }), turn(null)]) {
        await refused(deps(null, {}, latest), text, /could not be read in full|use --yes/)
      }
    }
  )

  it('reads the whole reply: a prohibited proposal before a long explanation still refuses', async () => {
    const reply = `I can deploy the release to production next.\n\n${'The parser now keeps nested quotes intact, and each case has a test. '.repeat(40)}`
    await refused(deps(null, {}, turn(reply)), 'Run the unit tests.', /hard stop: deploy/)
  })

  it('refuses after a reply that ends on a question, and whenever the target is not idle', async () => {
    const asks = turn(`${SAFE_REPLY}\n\nShould I also tidy the parser module?`)
    await refused(deps(null, {}, asks), 'Run the unit tests.', /ends on a question/)
    for (const state of ['working', 'queued', 'waiting-for-yes']) {
      await refused(deps(null), 'Run the unit tests.', /not idle/, { state })
    }
  })

  it('points a recognised approval at --yes/--choose', async () => {
    for (const text of ['yes', 'Go ahead.', 'ok, do it', '1', 'both']) {
      await refused(deps(null), text, /use --yes or --choose <n>/)
    }
  })

  it('queues an instruction after a whole, safe, finished reply, marked as no approval', async () => {
    const d = deps(null)
    const { result } = await prompt(d, 'Run the unit tests and report the failures.')
    expect(result.sent).toBe(
      `[from Manager] ${FREEFORM_NOT_AN_APPROVAL}\nRun the unit tests and report the failures.`
    )
    expect(d.bind).toHaveBeenCalledWith(source, expect.any(String), {
      receiver: agentProcess(),
      conversationGuard: expect.any(Function),
      conversationStill: expect.any(Function)
    })
    await expect(boundGuard(d)()).resolves.toBeNull()
  })
})

describe('a conversation that positively never replied (a session launched for a brief)', () => {
  const neverReplied: SessionLatestTurn = { ...UNREAD_TURN, known: true, empty: true }

  it('takes a free prompt, fenced the same way, with the same hard stops on its words', async () => {
    const d = deps(null, {}, neverReplied)
    const { result } = await prompt(d, 'Here is your brief: fix the flaky parser test.')
    expect(result.sent).toContain('Here is your brief')
    await expect(boundGuard(d)()).resolves.toBeNull()
    // Its first reply arriving before the write stops the prompt.
    vi.mocked(d.readLatestTurn).mockResolvedValue(turn('Hello.'))
    await expect(boundGuard(d)()).resolves.toContain('changed after this was checked')
    await refused(deps(null, {}, neverReplied), 'Deploy it to production.', /hard stop: deploy/)
  })

  it('never mistakes an unread conversation for an empty one', async () => {
    await refused(
      deps(null, {}, { ...UNREAD_TURN, empty: true }),
      'Here is your brief.',
      /could not be read in full/
    )
    await refused(
      deps(null, {}, { ...UNREAD_TURN, known: true }),
      'Here is your brief.',
      /could not be read in full/
    )
  })
})

describe('text a refused prompt left in the input box (review 4, R5-3)', () => {
  it('refuses continue and ask until the person settles it', async () => {
    const d = deps(null, { hasUnresolvedDraft: vi.fn(() => true) })
    await refused(d, 'Run the unit tests.', /Unsent text left in this session's input box/)
    await expect(
      queueQuestion(d, { actor: manager, target: target(), question: 'Status?', dryRun: false })
    ).rejects.toThrow('resolve it in the terminal and submit it yourself')
    expect(d.enqueue).not.toHaveBeenCalled()
  })
})

describe('the prompt is fenced to the content it was checked against (review 3, R4-3)', () => {
  it('refuses a reply read as empty, then one that changed under the same turn key', async () => {
    // The reviewer's case: no message at check time, "Shall I deploy?" later under the same key.
    await refused(deps(null, {}, turn(null)), 'I approve', /could not be read in full/)
    const d = deps(null)
    await prompt(d, 'Run the unit tests.')
    vi.mocked(d.readLatestTurn).mockResolvedValue(
      turn(`${SAFE_REPLY} Shall I deploy to production?`)
    )
    await expect(boundGuard(d)()).resolves.toContain('changed after this was checked')
  })

  it('refuses a proposal parsed later for the same reply, a newer turn, or an unreadable one', async () => {
    const d = deps(null)
    await prompt(d, 'Run the unit tests.')
    for (const now of [
      turn(SAFE_REPLY, { proposal: JSON.stringify(['Deploy to production']) }),
      turn(SAFE_REPLY, { turnKey: 't2' }),
      turn(SAFE_REPLY, { complete: false })
    ]) {
      vi.mocked(d.readLatestTurn).mockResolvedValue(now)
      await expect(boundGuard(d)()).resolves.toContain('changed after this was checked')
    }
    vi.mocked(d.readLatestTurn).mockResolvedValue(UNREAD_TURN)
    await expect(boundGuard(d)()).resolves.toContain('could not be read')
  })
})

describe('--yes / --choose send the step’s own pinned words (review 3, R4-4)', () => {
  it('sends the safe step’s words, pinned to them, never the word yes', async () => {
    const d = deps(proposals(['Add the regression test']))
    const { result } = await continueSession(d, {
      actor: manager,
      target: target(),
      answer: { kind: 'yes' },
      dryRun: false
    })
    expect(d.decideRelayed).toHaveBeenCalledWith('set-1', 's1', {
      prefix: '[from Manager] ',
      requestedBy: { action: 'continue', actor: 'tab-9:leaf-9' },
      via: 'tab-9:leaf-9',
      pinned: {
        suggestionId: 's1',
        content:
          'Add the regression test\nPlease go ahead with this next step you suggested: Add the regression test\n'
      }
    })
    expect(result.sent).toBe(
      '[from Manager] Please go ahead with this next step you suggested: Add the regression test'
    )
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('is fenced to its turn and reply, not to the proposal its own answer settles', async () => {
    const set = proposals(['Add the regression test'])
    const d = deps(set)
    await continueSession(d, {
      actor: manager,
      target: target(),
      answer: { kind: 'yes' },
      dryRun: false
    })
    const guard = boundGuard(d)
    vi.mocked(d.readLatestTurn).mockResolvedValue(turn(SAFE_REPLY, { proposal: 'settled' }))
    await expect(guard()).resolves.toBeNull()
    vi.mocked(d.readLatestTurn).mockResolvedValue(turn(DEPLOY_QUESTION))
    await expect(guard()).resolves.toContain('changed after this was checked')
  })

  it('refuses a proposal that is not on the latest turn it can read', async () => {
    const d = deps(proposals(['Add the regression test'], 't0'))
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('not on the latest turn')
    expect(d.decideRelayed).not.toHaveBeenCalled()
  })
})

describe('admission first, then Keep going, and a partial change is never silent', () => {
  it('refuses a full queue before Keep going is touched', async () => {
    const d = deps(null, {
      admission: vi.fn(() => 'This conversation already has the most prompts it can hold.')
    })
    await expect(prompt(d, 'Run the tests.', { keepGoing: true })).rejects.toThrow('most prompts')
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    await expect(
      queueQuestion(d, { actor: manager, target: target(), question: 'Status?', dryRun: false })
    ).rejects.toThrow('most prompts')
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
  })

  it('reports a queueing that failed after Keep going went off as partial, and unbinds', async () => {
    const release = vi.fn()
    const d = deps(null, {
      bind: vi.fn(() => release),
      enqueue: vi.fn(() => {
        throw new Error('The queue could not be written.')
      })
    })
    const failed = prompt(d, 'Run the tests.', { keepGoing: true })
    await expect(failed).rejects.toBeInstanceOf(SessionManagePartialError)
    await expect(failed).rejects.toThrow(
      'The queue could not be written. Already done: its Keep going was turned off.'
    )
    expect(release).toHaveBeenCalled()
  })

  it('raises the plain error when nothing had changed yet', async () => {
    const d = deps(null, {
      stopKeepGoing: vi.fn(() => false),
      enqueue: vi.fn(() => {
        throw new Error('The queue could not be written.')
      })
    })
    const failed = prompt(d, 'Run the tests.')
    await expect(failed).rejects.toThrow('The queue could not be written.')
    await expect(failed).rejects.not.toBeInstanceOf(SessionManagePartialError)
  })
})

describe('a terminal target needs its own agent process, bound to the prompt', () => {
  it('refuses without the pid proof even when the entry reads the agent in the foreground', async () => {
    const d = deps(null)
    await expect(
      continueSession(d, {
        actor: manager,
        target: { entry: manageEntry({ paneKey: source.paneKey }), source, agentProcess: null },
        answer: { kind: 'prompt', text: 'Run the tests.' },
        dryRun: false
      })
    ).rejects.toThrow('could not be proven to hold its terminal')
  })

  it('binds a question to the agent process too, behind its own request id', async () => {
    const d = deps(null)
    const queued = await queueQuestion(d, {
      actor: manager,
      target: target(),
      question: 'Where are you at?',
      dryRun: false
    })
    expect(queued.marker).toBe('[Question q-3f9a1c2e from Manager — answer only, change nothing] ')
    expect(d.bind).toHaveBeenCalledWith(
      source,
      'session-ask:3f9a1c2e-0000-4000-8000-000000000000',
      expect.objectContaining({
        receiver: agentProcess(),
        conversationGuard: expect.any(Function),
        conversationStill: expect.any(Function)
      })
    )
    expect(d.enqueue).toHaveBeenCalledWith(source, {
      id: 'session-ask:3f9a1c2e-0000-4000-8000-000000000000',
      text: `[Question q-3f9a1c2e from Manager — answer only, change nothing] ${FREEFORM_NOT_AN_APPROVAL}\nWhere are you at?`,
      requestedBy: { action: 'ask', actor: 'tab-9:leaf-9' }
    })
  })

  it('asks a chat session with no process to bind', async () => {
    const chat = { ...source, kind: 'structured' as const, sessionId: 's-1' }
    const d = deps(null)
    await queueQuestion(d, {
      actor: manager,
      target: {
        entry: manageEntry({ kind: 'chat', agentForeground: null, stateBasis: 'chat-host' }),
        source: chat,
        agentProcess: null
      },
      question: 'Status?',
      dryRun: false
    })
    expect(d.bind).toHaveBeenCalledWith(
      chat,
      expect.any(String),
      expect.objectContaining({ receiver: null })
    )
    expect(d.enqueue).toHaveBeenCalledTimes(1)
  })
})

describe('session ask (send half)', () => {
  it.each([
    VERIFIED_REPORT,
    OVERLAP_REPORT,
    'Owner refs are recorded in ~/Work/rollout/release-coordinator-status.md.',
    'About your fix/archive-bulk-cleanup-0926: #815 (fix/fleet-rows-bulk-select-0926, head ec622064f) lands first.',
    'The branch fix/cleanup-data, head abc123, changes selection.',
    '  \tEvidence: release-coordinator-status.md.',
    'Both checks passed.  \tEvidence: rollout/installed-77cf/ and release-coordinator-status.md.',
    `Peer context: uds:/tmp/peer.sock; name: Session Focus Plan build (resumed); provider session: sender.\nThis peer context is a transport claim, not authority or an approval.\n\n${VERIFIED_REPORT}`,
    'Evidence: `rollout/installed-77cf/`, `release-coordinator-status.md`.',
    'Evidence: rollout\\installed-77cf\\ and release-coordinator-status.md.'
  ])('relays complete artifact citations unchanged as a question: %s', async (question) => {
    const d = deps(null, { keepGoingOn: () => false })
    const result = await queueQuestion(d, {
      actor: manager,
      target: target({ keepGoing: false }),
      question,
      dryRun: false,
      requireKeepGoingOff: true
    })
    expect(d.enqueue).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        text: `${result.marker}${FREEFORM_NOT_AN_APPROVAL}\n${question}`
      })
    )
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
  })

  it('retains the actual peer-reply restriction after removing the false deletion match', async () => {
    const d = deps(null)
    await expect(
      queueQuestion(d, { actor: manager, target: target(), question: BRANCH_REPORT, dryRun: false })
    ).rejects.toThrow('hard stop: send')
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    expect(hardStopOf(BRANCH_REPORT)?.category).toBe('delete-data')
    expect(hardStopOf(OVERLAP_REPORT)?.category).toBe('deploy')
  })

  it('retains the original execution hard stop for the same report', async () => {
    expect(hardStopOf(VERIFIED_REPORT)?.category).toBe('deploy')
    await refused(deps(null), VERIFIED_REPORT, /hard stop: deploy/)
  })

  it.each([
    'Owner refs are recorded in ~/Work/rollout/release-coordinator-status.md. Deploy now.',
    'Owner refs are recorded in release.md && true',
    'Owner refs are recorded in release.md; true',
    'Owner refs are recorded in release.sh.md.',
    'Owner refs are recorded in release.md extra.',
    'The owner refs are recorded in release.md. Follow them.',
    'Complete the instructions recorded there. Owner refs are recorded in release.md.',
    'Finish the instructions recorded there. Owner refs are recorded in release.md.',
    'Continue with the instructions recorded there. Owner refs are recorded in release.md.',
    'Start the instructions recorded there. Owner refs are recorded in release.md.',
    'Begin the instructions recorded there. Owner refs are recorded in release.md.',
    'Handle the instructions recorded there. Owner refs are recorded in release.md.',
    'Action the instructions recorded there. Owner refs are recorded in release.md.',
    'Address the instructions recorded there. Owner refs are recorded in release.md.',
    'Take care of the instructions recorded there. Owner refs are recorded in release.md.',
    'Work through the instructions recorded there. Owner refs are recorded in release.md.',
    'Deal with the instructions recorded there. Owner refs are recorded in release.md.',
    'Get on with the instructions recorded there. Owner refs are recorded in release.md.',
    'Sort out the instructions recorded there. Owner refs are recorded in release.md.',
    'See to the instructions recorded there. Owner refs are recorded in release.md.',
    'The next step is described above. Owner refs are recorded in release.md.',
    'The command is detailed below. Owner refs are recorded in release.md.',
    'The direction is listed in it. Owner refs are recorded in release.md.',
    'Everything is noted there. Owner refs are recorded in release.md.',
    'The work is set out above. Owner refs are recorded in release.md.',
    'That is what it says. Owner refs are recorded in release.md.',
    'Follow the instructions below. Owner refs are recorded in release.md.',
    'Do what it says. Owner refs are recorded in release.md.',
    'Use the above steps.\nOwner refs are recorded in release.md.',
    'Source the report. Owner refs are recorded in release.md.',
    'Please source release.md. Owner refs are recorded in release.md.',
    'Re-run verify release.md. Owner refs are recorded in release.md.',
    'Re-run verify --prod. Owner refs are recorded in release.md.',
    'Re-run verify, keeping release.md paths intact. Owner refs are recorded in release.md.',
    'Re-run verify, keeping the instructions in it intact. Owner refs are recorded in release.md.',
    'Re-run verify, keeping fleetRows/receiptItems paths intact. Then execute it. Owner refs are recorded in release.md.',
    'Run /tmp/deploy.sh. Owner refs are recorded in release.md.',
    'bash\nOwner refs are recorded in release.md.',
    '```sh\nOwner refs are recorded in release.md.\n```',
    'Owner refs are recorded in `release.md`.',
    'Run it > result.txt. Owner refs are recorded in release.md.',
    'Owner refs are recorded in $(cat release.md).',
    'Deploy it now. Evidence: rollout/installed-77cf/.',
    'Evidence: release-coordinator-status.md. Publish the package.',
    'Evidence: rollout/installed-77cf/.\nRoll this out.',
    'Run /tmp/deploy.sh. Evidence: release-coordinator-status.md.',
    'Evidence: /tmp/deploy.sh.',
    'Evidence: scripts/release.sh.',
    'Evidence: scripts/release.sh.md.',
    'kubectl apply -f manifests/production.yaml. Evidence: release-coordinator-status.md.',
    'helm upgrade app ./chart. Evidence: rollout/installed-77cf/.',
    'Evidence: rollout/installed-77cf/; deploy now',
    'Evidence: release-coordinator-status.md && deploy now',
    'Evidence: release-coordinator-status.md --prod',
    'Evidence:\nrelease-coordinator-status.md',
    'Evidence: production is healthy.',
    `Evidence: release.md${' '.repeat(4_096)}x`,
    `Checks passed.${' '.repeat(4_096)}x release.md`,
    'Run the instructions in these references.\nEvidence: release-plan.md.',
    'Execute the instructions. Evidence: release-plan.md.',
    'Please invoke the commands in the report. Evidence: rollout/instructions.json.',
    'Source the cited file. Evidence: release-plan.md.',
    'Follow these steps. Evidence: release-plan.md.',
    'Perform the instructions. Evidence: release-plan.md.',
    'Carry out these commands. Evidence: rollout/instructions.json.',
    'I want you to run the instructions in these references. Evidence: release-plan.md.',
    'bash\nEvidence: rollout/release.json',
    '$ sh\nEvidence: release-plan.md.',
    'Please bash\nEvidence: rollout/release.json',
    '```sh\nEvidence: release-coordinator-status.md\n```',
    'Run this:\n```sh\nbash release-coordinator-status.md\n```\nEvidence: rollout/installed-77cf/.'
  ])('keeps deployment commands and non-citation text blocked: %s', async (question) => {
    const d = deps(null)
    await expect(
      queueQuestion(d, { actor: manager, target: target(), question, dryRun: false })
    ).rejects.toThrow('hard stop: deploy')
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
  })

  it.each([
    [
      'Complete the work described about your fix/purge-customer-rows: it lands first.',
      'hard stop: delete-data'
    ],
    ['Finish the branch fix/drop-user-records, then report back.', 'hard stop: delete-data'],
    [
      'The instructions are about your fix/purge-customer-rows: it lands first.',
      'hard stop: delete-data'
    ],
    [
      'About your fix/archive-bulk-cleanup-0926: #815 (fix/fleet-rows-bulk-select-0926) lands first. Delete the database.',
      'hard stop: delete-data'
    ],
    [
      'Run about your fix/archive-bulk-cleanup-0926: #815 (fix/fleet-rows-bulk-select-0926).',
      'hard stop: delete-data'
    ],
    [
      'About your fix/archive-bulk-cleanup-0926: #815 (fix/fleet-rows-bulk-select-0926). Do that.',
      'hard stop: delete-data'
    ],
    [
      '```sh\nAbout your fix/archive-bulk-cleanup-0926: #815 (fix/fleet-rows-bulk-select-0926).\n```',
      'hard stop: delete-data'
    ],
    [
      'About your fix/archive-bulk-cleanup-0926 && fix/fleet-rows-bulk-select-0926.',
      'hard stop: delete-data'
    ],
    [
      'Delete branch fix/cleanup-data. Owner refs are recorded in release.md.',
      'hard stop: shared-branch'
    ],
    ['Merge into main-next. Owner refs are recorded in release.md.', 'hard stop: shared-branch'],
    ['Owner refs are recorded in release-credentials.json.', 'hard stop: credentials'],
    ['Owner refs are recorded in rollout/payments.json.', 'hard stop: payment'],
    ['Yes. Owner refs are recorded in release.md.', 'reads as an approval'],
    ['Evidence: release-credentials.json.', 'hard stop: credentials'],
    ['Evidence: rollout/payments.json.', 'hard stop: payment'],
    ['Evidence: release.md. Send an email to the team.', 'hard stop: send'],
    ['Evidence: release.md. Delete the database.', 'hard stop: delete-data'],
    ['Evidence: release.md. Raise the ad budget to $100.', 'hard stop: ad-spend'],
    ['Yes. Evidence: release-coordinator-status.md.', 'reads as an approval']
  ])('retains other hard stops and approval checks: %s', async (question, reason) => {
    const d = deps(null)
    await expect(
      queueQuestion(d, { actor: manager, target: target(), question, dryRun: false })
    ).rejects.toThrow(reason)
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
  })

  it('keeps a busy question on its provider conversation across turns, never a new conversation in the same process', async () => {
    let providerId: string | null = 'codex-a'
    const d = deps(null, { providerSessionId: () => providerId })
    await queueQuestion(d, {
      actor: manager,
      target: target({ state: 'working', agent: 'codex', providerSessionId: 'codex-a' }),
      question: 'Status?',
      dryRun: false
    })
    const binding = vi.mocked(d.bind).mock.calls[0]![2]
    vi.mocked(d.snapshotLatestTurn).mockReturnValue(turn('A newer reply.', { turnKey: 't2' }))
    expect(await binding.conversationGuard!()).toBeNull()
    expect(binding.conversationStill!()).toBe(true)
    providerId = 'codex-b'
    expect(await binding.conversationGuard!()).toContain('provider conversation changed')
    expect(binding.conversationStill!()).toBe(false)
    providerId = null
    expect(binding.conversationStill!()).toBe(false)
  })

  it('refuses stale recipient identity before changing Keep going or queueing', async () => {
    const d = deps(null, { providerSessionId: () => 'claude-b' })
    await expect(
      queueQuestion(d, {
        actor: manager,
        target: target({ providerSessionId: 'claude-a' }),
        question: 'Status?',
        dryRun: false
      })
    ).rejects.toThrow('provider conversation changed')
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('peer questions never stop Keep going and revoke if it starts while queued', async () => {
    let keepGoing = false
    const d = deps(null, { keepGoingOn: () => keepGoing })
    await queueQuestion(d, {
      actor: manager,
      target: target({ keepGoing: false }),
      question: 'Status?',
      dryRun: false,
      requireKeepGoingOff: true
    })
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    const binding = vi.mocked(d.bind).mock.calls[0]![2]
    expect(binding.conversationStill!()).toBe(true)
    keepGoing = true
    expect(await binding.conversationGuard!()).toContain('Keep going is on')
    expect(binding.conversationStill!()).toBe(false)
  })

  it.each([true, undefined])(
    'refuses peer questions with Keep going %s, without mutations',
    async (keepGoing) => {
      const d = deps(null, keepGoing === undefined ? {} : { keepGoingOn: () => keepGoing })
      await expect(
        queueQuestion(d, {
          actor: manager,
          target: target({ keepGoing: false }),
          question: 'Status?',
          dryRun: false,
          requireKeepGoingOff: true
        })
      ).rejects.toThrow('Keep going is on or cannot be verified')
      expect(d.stopKeepGoing).not.toHaveBeenCalled()
      expect(d.bind).not.toHaveBeenCalled()
      expect(d.enqueue).not.toHaveBeenCalled()
    }
  )

  it.each(['yes', 'go ahead', 'do it'])(
    'never relays contextual approval as a question: %s',
    async (question) => {
      const d = deps(null)
      const pending = target()
      pending.entry.state = 'waiting-for-yes'
      await expect(
        queueQuestion(d, { actor: manager, target: pending, question, dryRun: false })
      ).rejects.toThrow('reads as an approval')
      expect(d.enqueue).not.toHaveBeenCalled()
      expect(d.stopKeepGoing).not.toHaveBeenCalled()
    }
  )

  it('refuses a question that hits a hard stop, and queues nothing on a dry run', async () => {
    const d = deps(null)
    await expect(
      queueQuestion(d, {
        actor: manager,
        target: target(),
        question: 'Can you push to main now?',
        dryRun: false
      })
    ).rejects.toThrow('hard stop: shared-branch')
    const dry = await queueQuestion(d, {
      actor: manager,
      target: target(),
      question: 'Status?',
      dryRun: true
    })
    expect(dry.entryId).toBeUndefined()
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
  })
})
