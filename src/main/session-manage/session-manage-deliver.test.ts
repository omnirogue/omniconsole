import { describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { continueSession } from './session-manage-continue'
import { SessionManageRefusal, type SessionDeliveryDeps } from './session-manage-deliver'
import { FREEFORM_NOT_AN_APPROVAL } from './session-manage-freeform'
import { agentProcess, manageEntry } from './session-manage-test-fixtures'

const source: ConversationSource = {
  worktreeId: 'repo::/ads',
  paneKey: 'tab-2:leaf-2',
  kind: 'pty'
}
const manager: SessionManageActor = {
  kind: 'pane',
  paneKey: 'tab-9:leaf-9',
  title: 'Manager [ops]'
}

function ownSet(offered: boolean, titles: string[]): NextStepSuggestionSet {
  return {
    id: 'set-1',
    conversation: source,
    worktreeId: source.worktreeId,
    turnKey: 't1',
    origin: 'parsed',
    createdAt: 1,
    status: 'pending',
    suggestions: titles.map((title, index) => ({
      id: `s${index + 1}`,
      title,
      prompt: `Please go ahead with this next step you suggested: ${title}`,
      risk: 'safe',
      kind: 'fix',
      ...(offered ? { offered: true as const } : {})
    }))
  } as NextStepSuggestionSet
}

function deps(set: NextStepSuggestionSet | null = null) {
  const calls: string[] = []
  const latest = {
    known: true,
    turnKey: 't1',
    text: 'The parser handles nested quotes now.',
    complete: true,
    proposal: set ? JSON.stringify(set.suggestions) : null,
    empty: false
  }
  const value: SessionDeliveryDeps = {
    enqueue: vi.fn(() => {
      calls.push('enqueue')
    }),
    admission: vi.fn(() => null),
    bind: vi.fn(() => {
      calls.push('bind')
      return () => calls.push('release')
    }),
    // Its whole latest reply, read; a proposal of its own when it has one.
    readLatestTurn: vi.fn(async () => latest),
    snapshotLatestTurn: vi.fn(() => latest),
    hasUnresolvedDraft: vi.fn(() => false),
    decideRelayed: vi.fn(async (_setId: string, suggestionId: string) => {
      calls.push('decide')
      return { set: set!, queued: [suggestionId], notQueued: [] }
    }),
    stopKeepGoing: vi.fn(() => {
      calls.push('stop-keep-going')
      return true
    }),
    readOwnSteps: vi.fn(async () =>
      set ? { set, steps: set.suggestions } : { set: null, steps: [] }
    ),
    newId: () => 'id-1'
  }
  return { deps: value, calls }
}

const target = (overrides = {}) => ({
  entry: manageEntry(overrides),
  source,
  agentProcess: agentProcess()
})

describe('session continue --prompt', () => {
  it('queues the text behind a marker naming the acting session, with its provenance', async () => {
    const { deps: d } = deps()
    const { result, entryId } = await continueSession(d, {
      actor: manager,
      target: target(),
      answer: { kind: 'prompt', text: 'Run the unit tests.' },
      dryRun: false
    })
    expect(d.enqueue).toHaveBeenCalledWith(source, {
      id: 'session-manage:id-1',
      text: `[from Manager ops] ${FREEFORM_NOT_AN_APPROVAL}\nRun the unit tests.`,
      requestedBy: { action: 'continue', actor: 'tab-9:leaf-9' }
    })
    // Bound to the agent process holding the target's terminal and to its conversation.
    expect(d.bind).toHaveBeenCalledWith(source, 'session-manage:id-1', {
      receiver: agentProcess(),
      conversationGuard: expect.any(Function),
      conversationStill: expect.any(Function)
    })
    expect(entryId).toBe('session-manage:id-1')
    expect(result).toMatchObject({ dryRun: false, action: 'continue', actor: manager })
  })

  it('names the plain CLI when no pane was proven', async () => {
    const { deps: d } = deps()
    await continueSession(d, {
      actor: { kind: 'cli', unverifiedPaneKey: 'tab-5:leaf-5' },
      target: target(),
      answer: { kind: 'prompt', text: 'Summarize where you are.' },
      dryRun: false
    })
    expect(d.enqueue).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        text: `[from omni CLI] ${FREEFORM_NOT_AN_APPROVAL}\nSummarize where you are.`,
        requestedBy: { action: 'continue', actor: 'cli' }
      })
    )
  })

  it.each([
    ['deploy', 'Deploy the release to production'],
    ['shared-branch', 'git push origin main'],
    ['delete-data', 'Drop the users table'],
    ['send', 'Email the customers about the outage'],
    ['payment', 'Refund the last invoice'],
    ['credentials', 'Print the API keys'],
    ['ad-spend', 'Raise the SD25 daily budget to $300'],
    ['ad-spend', 'Pause ad set 4 and turn ad set 7 back on'],
    ['ad-campaign-pause', 'Pause the SD25 Meta campaign'],
    ['ad-enterprise', 'Pause the Enterprise webinar ad set']
  ])('refuses a %s hard stop and sends nothing', async (category, text) => {
    const { deps: d } = deps()
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'prompt', text },
        dryRun: false
      })
    ).rejects.toThrow(`hard stop: ${category}`)
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
  })

  it('turns the target’s Keep going off before anything is queued', async () => {
    const { deps: d, calls } = deps()
    const { result } = await continueSession(d, {
      actor: manager,
      target: target({ keepGoing: true }),
      answer: { kind: 'prompt', text: 'Carry on with the tests.' },
      dryRun: false
    })
    expect(calls).toEqual(['stop-keep-going', 'bind', 'enqueue'])
    expect(result.keepGoingStopped).toBe(true)
  })

  it('changes nothing on a dry run and says exactly what would be sent', async () => {
    const { deps: d } = deps()
    const { result, entryId } = await continueSession(d, {
      actor: manager,
      target: target({ keepGoing: true }),
      answer: { kind: 'prompt', text: 'Run the lint and fix what it finds.' },
      dryRun: true
    })
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    expect(entryId).toBeUndefined()
    expect(result).toMatchObject({
      dryRun: true,
      sent: `[from Manager ops] ${FREEFORM_NOT_AN_APPROVAL}\nRun the lint and fix what it finds.`,
      keepGoingStopped: true
    })
    expect(result.summary).toContain('dry run')
  })

  it.each([
    [
      'awaiting-user',
      { state: 'awaiting-user', waitingOn: 'Your answer to a permission prompt.' },
      'cannot answer that'
    ],
    ['exited', { verdict: 'exited', state: 'exited' }, 'has exited'],
    ['unverifiable', { verdict: 'unverifiable', state: 'unknown' }, 'cannot be verified'],
    ['unknown', { verdict: 'live', state: 'unknown' }, 'cannot be verified'],
    ['provider-limited', { state: 'provider-limited' }, 'usage limit'],
    ['at a shell or another program', { agentForeground: false }, 'could not be proven'],
    ['unreadable in its foreground', { agentForeground: null }, 'could not be proven'],
    [
      'run by an SSH host',
      { hostId: 'ssh:build-box' },
      'the SSH host build-box, not on this computer'
    ],
    ['run by another OmniConsole', { hostId: 'runtime:env-1' }, 'another OmniConsole']
  ])('refuses a target that is %s', async (_name, overrides, words) => {
    const { deps: d } = deps()
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(overrides),
        answer: { kind: 'prompt', text: 'Run the lint and fix what it finds.' },
        dryRun: false
      })
    ).rejects.toThrow(words)
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('refuses the session running the command', async () => {
    const { deps: d } = deps()
    await expect(
      continueSession(d, {
        actor: { kind: 'pane', paneKey: 'tab-2:leaf-2', title: 'Ads session' },
        target: target(),
        answer: { kind: 'prompt', text: 'Carry on.' },
        dryRun: false
      })
    ).rejects.toBeInstanceOf(SessionManageRefusal)
  })
})

describe('session continue --yes / --choose', () => {
  it('sends the session’s own single proposal through decide, marked and attributed', async () => {
    const set = ownSet(true, ['Add the migration'])
    const { deps: d, calls } = deps(set)
    const { result } = await continueSession(d, {
      actor: manager,
      target: target({ keepGoing: true }),
      answer: { kind: 'yes' },
      dryRun: false
    })
    // Pinned to the exact words that passed the hard stops.
    expect(d.decideRelayed).toHaveBeenCalledWith('set-1', 's1', {
      prefix: '[from Manager ops] ',
      requestedBy: { action: 'continue', actor: 'tab-9:leaf-9' },
      via: 'tab-9:leaf-9',
      pinned: {
        suggestionId: 's1',
        content:
          'Add the migration\nPlease go ahead with this next step you suggested: Add the migration\n'
      }
    })
    // The step's queue entry is bound before decide queues it.
    expect(d.bind).toHaveBeenCalledWith(source, 'next-step:set-1:s1', {
      receiver: agentProcess(),
      conversationGuard: expect.any(Function),
      conversationStill: expect.any(Function)
    })
    expect(calls).toEqual(['stop-keep-going', 'bind', 'decide'])
    expect(result.sent).toBe(
      '[from Manager ops] Please go ahead with this next step you suggested: Add the migration'
    )
  })

  it('refuses --yes when it offered several options, and --choose out of range', async () => {
    const { deps: d } = deps(ownSet(true, ['Option A', 'Option B']))
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('--choose <n>: 1. Option A; 2. Option B')
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'choose', choice: 3 },
        dryRun: false
      })
    ).rejects.toThrow('there is no number 3')
    const chosen = await continueSession(d, {
      actor: manager,
      target: target(),
      answer: { kind: 'choose', choice: 2 },
      dryRun: false
    })
    expect(d.decideRelayed).toHaveBeenCalledWith('set-1', 's2', expect.anything())
    expect(chosen.result.summary).toContain('Option B')
  })

  it('refuses a proposal that hits a hard stop', async () => {
    const { deps: d } = deps(ownSet(true, ['Deploy the release to production']))
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('hard stop: deploy')
    expect(d.decideRelayed).not.toHaveBeenCalled()
  })

  it('refuses --yes on a proposal to raise an ad budget', async () => {
    const { deps: d } = deps(ownSet(true, ['Raise the SD25 daily budget to $300']))
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('hard stop: ad-spend')
    expect(d.decideRelayed).not.toHaveBeenCalled()
  })

  it('refuses when the session proposed nothing', async () => {
    const { deps: d } = deps()
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('no open proposal')
  })

  it('reports a proposal decide could not queue', async () => {
    const set = ownSet(false, ['Write the docs'])
    const { deps: d } = deps(set)
    vi.mocked(d.decideRelayed).mockResolvedValueOnce({
      set,
      queued: [],
      notQueued: [
        { id: 's1', reason: 'This conversation already has the most prompts it can hold.' }
      ]
    })
    await expect(
      continueSession(d, {
        actor: manager,
        target: target(),
        answer: { kind: 'yes' },
        dryRun: false
      })
    ).rejects.toThrow('most prompts it can hold')
  })
})
