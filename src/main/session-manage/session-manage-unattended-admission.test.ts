import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import type { SessionManageActor, SessionTidyRow } from '../../shared/session-manage-types'
import type {
  OrganizationChange,
  OrganizationRelayedOutcome
} from '../../shared/session-organization-change'
import { sessionActionActorKind } from '../../shared/session-organization-readers'
import { configureStewardSwitches } from '../session-steward/steward-switches'
import { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import { OrganizationHistoryStore } from '../session-organization/organization-history-store'
import { relayOrganizationChange } from '../session-organization/organization-relayed-mutation'
import { auditActor, SESSION_ACTIONS_FILE, SessionActionsLog } from './session-actions-log'
import { queueQuestion } from './session-manage-ask'
import { continueSession } from './session-manage-continue'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import { FREEFORM_NOT_AN_APPROVAL } from './session-manage-freeform'
import { assignSession } from './session-manage-assign'
import { answerSession } from './session-manage-answer'
import { consolidateSessions } from './session-manage-consolidate'
import { renameSession, restartSession, stopSession } from './session-manage-control'
import { handoffSession } from './session-manage-handoff'
import { agentProcess, manageEntry, sidebarRow } from './session-manage-test-fixtures'
import { registerUnattendedPane, UNATTENDED_MERGE_REFUSAL } from './session-manage-unattended'
import {
  setStewardPolicyHooks,
  STEWARD_PROMPT_LIMITS_UNAVAILABLE,
  STEWARD_TIER2_UNAVAILABLE,
  unattendedTidyPlan,
  type StewardPromptBudget
} from './session-manage-unattended-admission'

const STEWARD: SessionManageActor = { kind: 'steward', feature: 'rules' }
const MARKER = '[from Session steward] '
const source: ConversationSource = {
  worktreeId: 'repo::/ads',
  paneKey: 'tab-2:leaf-2',
  kind: 'pty'
}

const cleanups: (() => void)[] = []
const ledgers: OrganizationChangeLedger[] = []
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-admission-'))
  cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
})
afterEach(async () => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
  await Promise.all(ledgers.splice(0).map((ledger) => ledger.flush()))
  rmSync(dir, { recursive: true, force: true })
})

function hooks(next: Parameters<typeof setStewardPolicyHooks>[0]): void {
  cleanups.push(setStewardPolicyHooks(next))
}

function ownSet(title: string): NextStepSuggestionSet {
  return {
    id: 'set-1',
    conversation: source,
    worktreeId: source.worktreeId,
    turnKey: 't1',
    origin: 'parsed',
    createdAt: 1,
    status: 'pending',
    suggestions: [
      {
        id: 's1',
        title,
        prompt: `Please go ahead with this next step you suggested: ${title}`,
        risk: 'safe',
        kind: 'fix',
        offered: true
      }
    ]
  } as NextStepSuggestionSet
}

function deps(options: { keepGoingOn?: boolean | null; proposal?: boolean } = {}) {
  const set = ownSet('Add the migration')
  const latest = {
    known: true,
    turnKey: 't1',
    text: 'The parser handles nested quotes now.',
    complete: true,
    proposal: options.proposal === false ? null : JSON.stringify(set.suggestions),
    empty: false
  }
  const value: SessionDeliveryDeps = {
    enqueue: vi.fn(),
    admission: vi.fn(() => null),
    bind: vi.fn(() => () => {}),
    readLatestTurn: vi.fn(async () => latest),
    snapshotLatestTurn: vi.fn(() => latest),
    hasUnresolvedDraft: vi.fn(() => false),
    decideRelayed: vi.fn(async (_setId: string, suggestionId: string) => ({
      set,
      queued: [suggestionId],
      notQueued: []
    })),
    stopKeepGoing: vi.fn(() => false),
    ...(options.keepGoingOn === null
      ? {}
      : { keepGoingOn: vi.fn(() => options.keepGoingOn ?? false) }),
    readOwnSteps: vi.fn(async () => ({ set, steps: set.suggestions })),
    newId: () => 'id-1'
  }
  return value
}

const target = (overrides = {}) => ({
  entry: manageEntry(overrides),
  source,
  agentProcess: agentProcess()
})

function budget() {
  const settle = vi.fn()
  const fn = vi.fn<StewardPromptBudget>(async () => ({ ok: true, settle }))
  return { fn, settle }
}

describe('a steward prompt', () => {
  it('presses Yes behind the [from Session steward] marker, inside the steward’s limits', async () => {
    const limits = budget()
    hooks({ promptBudget: limits.fn })
    const d = deps()
    const { result } = await continueSession(d, {
      actor: STEWARD,
      target: target(),
      answer: { kind: 'yes' },
      dryRun: false
    })
    const sent = `${MARKER}Please go ahead with this next step you suggested: Add the migration`
    expect(result.sent).toBe(sent)
    expect(d.decideRelayed).toHaveBeenCalledWith('set-1', 's1', {
      prefix: MARKER,
      requestedBy: { action: 'continue', actor: 'steward' },
      via: 'steward',
      pinned: expect.objectContaining({ suggestionId: 's1' })
    })
    expect(limits.fn).toHaveBeenCalledWith({
      context: { source: 'rules' },
      kind: 'yes',
      entry: expect.objectContaining({ paneKey: 'tab-2:leaf-2' }),
      source,
      text: sent
    })
    expect(limits.settle).toHaveBeenCalledWith(true)
    // Keep going was read, never turned off.
    expect(d.keepGoingOn).toHaveBeenCalledWith(source)
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    expect(result.summary).toContain('from Session steward')
  })

  it('nudges and asks behind the same marker', async () => {
    const limits = budget()
    hooks({ promptBudget: limits.fn })
    const d = deps({ proposal: false })
    await continueSession(d, {
      actor: STEWARD,
      target: target(),
      answer: { kind: 'prompt', text: 'You stopped with work remaining. Continue.' },
      dryRun: false
    })
    expect(d.enqueue).toHaveBeenCalledWith(source, {
      id: 'session-manage:id-1',
      text: `${MARKER}${FREEFORM_NOT_AN_APPROVAL}\nYou stopped with work remaining. Continue.`,
      requestedBy: { action: 'continue', actor: 'steward' }
    })
    const asked = await queueQuestion(deps(), {
      actor: STEWARD,
      target: target(),
      question: 'In two lines: is your task complete, and what is left?',
      dryRun: false
    })
    expect(asked.marker).toMatch(/^\[Question q-[0-9a-f]{8} from Session steward — answer only/)
    expect(limits.fn.mock.calls.map(([request]) => request.kind)).toEqual(['prompt', 'ask'])
  })

  it('sends nothing until the steward’s limits are in place', async () => {
    const d = deps()
    await expect(
      continueSession(d, {
        actor: STEWARD,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow(`${STEWARD_PROMPT_LIMITS_UNAVAILABLE}. Nothing was sent.`)
    expect(d.decideRelayed).not.toHaveBeenCalled()
    expect(d.bind).not.toHaveBeenCalled()
  })

  it('sends nothing past a cap, and says which', async () => {
    hooks({
      promptBudget: async () => ({ ok: false, reason: '3 steward Yes today for this session' })
    })
    const d = deps()
    await expect(
      continueSession(d, {
        actor: STEWARD,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('3 steward Yes today for this session. Nothing was sent.')
    expect(d.decideRelayed).not.toHaveBeenCalled()
  })

  it('never prompts a Keep going session, even one that turned on after it was read', async () => {
    const limits = budget()
    hooks({ promptBudget: limits.fn })
    const observed = deps()
    await expect(
      continueSession(observed, {
        actor: STEWARD,
        target: target({ keepGoing: true }),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('is driven by Keep going')
    expect(limits.fn).not.toHaveBeenCalled()
    for (const keepGoingOn of [true, null]) {
      const d = deps({ keepGoingOn })
      await expect(
        continueSession(d, {
          actor: STEWARD,
          target: target(),
          answer: { kind: 'yes' },
          dryRun: false
        })
      ).rejects.toThrow('a steward run never turns it off')
      expect(d.stopKeepGoing).not.toHaveBeenCalled()
      expect(d.bind).not.toHaveBeenCalled()
      expect(d.decideRelayed).not.toHaveBeenCalled()
    }
    expect(limits.settle).toHaveBeenCalledWith(false)
  })

  it('spends no budget on a dry run, and leaves a person’s prompt alone', async () => {
    const limits = budget()
    hooks({ promptBudget: limits.fn })
    const dry = await continueSession(deps(), {
      actor: STEWARD,
      target: target(),
      answer: { kind: 'yes' },
      dryRun: true
    })
    expect(dry.result.sent?.startsWith(MARKER)).toBe(true)
    const d = deps()
    await continueSession(d, {
      actor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Manager' },
      target: target(),
      answer: { kind: 'yes' },
      dryRun: false
    })
    expect(limits.fn).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).toHaveBeenCalled()
  })
})

describe('a steward archive through the change path', () => {
  function openLedger(): OrganizationChangeLedger {
    const store = new OrganizationHistoryStore({ directory: join(dir, 'session-organization') })
    store.load()
    const ledger = new OrganizationChangeLedger({ trail: new SessionActionsLog(dir), store })
    ledgers.push(ledger)
    return ledger
  }
  function trail(): Record<string, unknown>[] {
    try {
      return readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const archive = (extra: Partial<OrganizationChange> = {}): OrganizationChange => ({
    opId: 'steward-archive-1',
    kind: 'archive',
    targets: [{ paneKey: 'tab-4:leaf-1' }],
    value: true,
    executor: { kind: 'app', feature: 'steward' },
    reason: 'finished, not verified',
    ...extra
  })
  const window = () =>
    vi.fn(async (request: SessionFolderRelayRequest): Promise<OrganizationRelayedOutcome> => {
      if (request.kind !== 'applyOrganizationChange') {
        throw new Error(`unexpected ${request.kind}`)
      }
      return {
        opId: request.change.opId,
        targets: [{ sessionKey: 'k4', paneKey: 'tab-4:leaf-1' }],
        value: true,
        before: [false],
        after: [true]
      }
    })

  it('archives nothing, and records nothing, without a Tier 2 check in place', async () => {
    const relay = window()
    await expect(
      relayOrganizationChange(openLedger(), relay, archive(), { actor: auditActor(STEWARD) })
    ).rejects.toThrow(`Not archived by a steward run: ${STEWARD_TIER2_UNAVAILABLE}.`)
    expect(relay).not.toHaveBeenCalled()
    expect(trail()).toEqual([])
  })

  it('archives nothing Tier 2 refuses', async () => {
    hooks({ tier2Eligibility: async () => ({ ok: false, reason: 'an open recorded commitment' }) })
    const relay = window()
    await expect(
      relayOrganizationChange(openLedger(), relay, archive(), { actor: auditActor(STEWARD) })
    ).rejects.toThrow('Not archived by a steward run: an open recorded commitment.')
    expect(relay).not.toHaveBeenCalled()
  })

  it('archives what Tier 2 passes, recording `actor: steward` with the evidence', async () => {
    const check = vi.fn(async () => ({
      ok: true as const,
      evidence: 'JEV resolved 0.91 · quiet 7 h'
    }))
    hooks({ tier2Eligibility: check })
    const relay = window()
    await relayOrganizationChange(openLedger(), relay, archive(), { actor: auditActor(STEWARD) })
    expect(check).toHaveBeenNthCalledWith(1, {
      target: { paneKey: 'tab-4:leaf-1' },
      context: { source: 'rules' }
    })
    // Why twice: the same check runs again once the window has applied it, as a recheck.
    expect(check).toHaveBeenNthCalledWith(2, {
      target: { paneKey: 'tab-4:leaf-1' },
      context: { source: 'rules' },
      recheck: { granted: 'JEV resolved 0.91 · quiet 7 h' }
    })
    expect(relay).toHaveBeenCalledTimes(1)
    const lines = trail()
    expect(lines.map((line) => [line.phase, line.actor, line.steward])).toEqual([
      ['prepared', 'steward', { feature: 'rules' }],
      ['applied', 'steward', { feature: 'rules' }]
    ])
    expect(lines[1]).toMatchObject({
      executor: { kind: 'app', feature: 'steward' },
      action: 'session.archive',
      reason: 'finished, not verified',
      organization: { evidence: 'JEV resolved 0.91 · quiet 7 h' }
    })
    expect(lines.map((line) => sessionActionActorKind(line as never))).toEqual([
      'steward',
      'steward'
    ])
  })

  it('refuses any steward change but an archive, before anything is recorded', async () => {
    hooks({ tier2Eligibility: async () => ({ ok: true, evidence: 'ok' }) })
    for (const change of [
      archive({ kind: 'move', value: 'folder-x' }),
      archive({ kind: 'title', value: 'New name' }),
      archive({ kind: 'archive', value: false }),
      archive({ kind: 'hide', value: true })
    ]) {
      const relay = window()
      await expect(relayOrganizationChange(openLedger(), relay, change)).rejects.toThrow(
        /A steward run cannot .*; that needs the person/
      )
      expect(relay).not.toHaveBeenCalled()
    }
    expect(trail()).toEqual([])
  })

  it('holds an automatic cleanup session’s own pane to the same rule', async () => {
    cleanups.push(registerUnattendedPane('tab-7:leaf-1', { source: 'cleanup-run' }))
    const relay = window()
    await expect(
      relayOrganizationChange(
        openLedger(),
        relay,
        archive({ executor: { kind: 'pane', paneKey: 'tab-7:leaf-1', title: 'Session cleanup' } })
      )
    ).rejects.toThrow(STEWARD_TIER2_UNAVAILABLE)
    expect(relay).not.toHaveBeenCalled()
  })
})

describe('unattendedTidyPlan', () => {
  const row = (paneKey: string, action: SessionTidyRow['action']): SessionTidyRow => ({
    paneKey,
    tabId: paneKey.split(':')[0]!,
    title: paneKey,
    folder: null,
    hostId: 'local',
    state: 'idle',
    verdict: 'live',
    action,
    reason: 'Idle with no pending steps, no queue and nothing waiting on the person.'
  })
  const plan = {
    rows: [
      row('tab-1:leaf-1', 'archive'),
      row('tab-2:leaf-1', 'archive'),
      row('tab-3:leaf-1', 'skip')
    ],
    counts: { archive: 2, hold: 0, skip: 1, junkTitles: 0 }
  }

  it('holds every archive row without Tier 2, saying why', async () => {
    const result = await unattendedTidyPlan(plan, { source: 'cleanup-run' })
    expect(result.rows.map((entry) => entry.action)).toEqual(['hold', 'hold', 'skip'])
    expect(result.rows[0]!.reason).toBe(
      `Not archived by a steward run: ${STEWARD_TIER2_UNAVAILABLE}.`
    )
    expect(result.counts).toEqual({ archive: 0, hold: 2, skip: 1, junkTitles: 0 })
  })

  it('keeps an archive row only when Tier 2 passes it now', async () => {
    hooks({
      tier2Eligibility: async ({ target }) =>
        target.paneKey === 'tab-2:leaf-1'
          ? { ok: true, evidence: 'JEV resolved 0.9' }
          : { ok: false, reason: 'quiet for 2 h, not 6' }
    })
    const result = await unattendedTidyPlan(plan, { source: 'cleanup-run' })
    expect(result.rows.map((entry) => [entry.action, entry.reason])).toEqual([
      ['hold', 'Not archived by a steward run: quiet for 2 h, not 6.'],
      ['archive', plan.rows[1]!.reason],
      ['skip', plan.rows[2]!.reason]
    ])
    expect(result.counts).toEqual({ archive: 1, hold: 1, skip: 1, junkTitles: 0 })
  })

  it('never archives a session another computer runs, whatever Tier 2 says', async () => {
    const check = vi.fn(async () => ({ ok: true as const, evidence: 'ok' }))
    hooks({ tier2Eligibility: check })
    const remote = { ...plan, rows: [{ ...plan.rows[0]!, hostId: 'ssh:build-box' }] }
    const result = await unattendedTidyPlan(remote, { source: 'cleanup-run' })
    expect(result.rows[0]).toMatchObject({ action: 'hold' })
    expect(result.rows[0]!.reason).toContain('runs on the SSH host build-box, not on this computer')
    expect(check).not.toHaveBeenCalled()
  })

  it('archives nothing with both archive switches off, whatever Tier 2 says', async () => {
    hooks({ tier2Eligibility: async () => ({ ok: true, evidence: 'ok' }) })
    cleanups.push(
      configureStewardSwitches({
        readSettings: () => ({ tier2Archive: 'off', emptySessionArchive: false })
      })
    )
    const result = await unattendedTidyPlan(plan, { source: 'cleanup-run' })
    expect(result.counts.archive).toBe(0)
    expect(result.rows[0]!.reason).toContain('“Archive finished sessions” switch is off')
  })
})

describe('what a steward run never does', () => {
  it('refuses a handoff or merge (D5) before touching anything', async () => {
    const input = { actor: STEWARD, sources: [], target: 'new', dryRun: true } as never
    await expect(handoffSession({} as never, input)).rejects.toThrow(UNATTENDED_MERGE_REFUSAL)
    await expect(consolidateSessions({} as never, input)).rejects.toThrow(UNATTENDED_MERGE_REFUSAL)
  })

  it('refuses a stop, restart, rename, an answer to the person’s question, or a new task', async () => {
    const control = {
      actor: STEWARD,
      target: { entry: manageEntry(), row: sidebarRow(), source, agentProcess: agentProcess() },
      dryRun: true
    }
    const needsPerson = /A steward run cannot .*; that needs the person\. Nothing changed\./
    await expect(stopSession({} as never, { ...control, force: false })).rejects.toThrow(
      needsPerson
    )
    await expect(restartSession({} as never, control)).rejects.toThrow(needsPerson)
    await expect(renameSession({} as never, { ...control, title: 'Better' })).rejects.toThrow(
      needsPerson
    )
    const lock = { bindPrompt: vi.fn() } as never
    const read = vi.fn()
    await expect(
      answerSession({ read } as never, {
        actor: STEWARD,
        expect: 'a'.repeat(64),
        answer: { kind: 'allow' },
        dryRun: false,
        lock
      })
    ).rejects.toThrow(needsPerson)
    expect(read).not.toHaveBeenCalled()
    const d = deps()
    await expect(
      assignSession(d, {
        actor: STEWARD,
        target: target(),
        task: 'Ship it',
        bound: false,
        dryRun: false
      })
    ).rejects.toThrow(needsPerson)
    expect(d.enqueue).not.toHaveBeenCalled()
  })
})
