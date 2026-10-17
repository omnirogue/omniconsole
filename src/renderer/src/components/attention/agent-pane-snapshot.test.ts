import { describe, expect, it } from 'vitest'
import { GEMINI_PERMISSION } from '../../../../shared/agent-title-core'
import { buildAgentPaneSnapshot } from './agent-pane-snapshot'
import { withReplyDecisionAttention } from './reply-decision-attention'
import { createNextStepReplyPtyProof } from '../../../../shared/next-step-reply-proof'
import {
  captureLocalReplyDecisionSources,
  projectLocalReplyDecisions
} from '../next-steps/local-reply-decisions'
import {
  ATTENTION_FIXTURE_NOW,
  ATTENTION_FIXTURE_PANE_A,
  ATTENTION_FIXTURE_PANE_B,
  attentionFixtureEntry,
  attentionFixtureInputs
} from './attention-test-fixtures'
import {
  resetAgentPaneSnapshotCacheForTest,
  selectAgentPaneSnapshot,
  selectAgentPaneSnapshotInputs,
  withoutWaitingPanes
} from './use-agent-pane-snapshot'

describe('buildAgentPaneSnapshot', () => {
  it('keeps an owner-confirmed question in attention after Stop while newer work and snooze win', () => {
    const question = 'Should I build and check the picker before the next install?'
    const entry = attentionFixtureEntry(ATTENTION_FIXTURE_PANE_A, 'tab-a', 'w1', {
      state: 'done',
      stateStartedAt: ATTENTION_FIXTURE_NOW - 1_000,
      providerSession: { key: 'session_id', id: 'current-provider' },
      lastAssistantMessage: question
    })
    const inputs = attentionFixtureInputs({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
    const completedAt = entry.stateStartedAt - 10_000 // Lead Stop preceded the child all-clear.
    const decisions = projectLocalReplyDecisions(
      [
        {
          conversation: { worktreeId: 'w1', paneKey: entry.paneKey, kind: 'pty' as const },
          turnKey: 'owner-turn',
          completedAt,
          question,
          ptyProof: createNextStepReplyPtyProof('owner-turn', entry)!
        }
      ],
      captureLocalReplyDecisionSources(inputs),
      inputs
    )
    const before = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW)
    const after = withReplyDecisionAttention(before, decisions, inputs)
    expect(before.attention).toEqual([])
    expect(after.attentionByPaneKey.get(entry.paneKey)).toMatchObject({
      cause: 'waiting',
      askSummary: question,
      stateChangedAt: completedAt
    })
    expect(withoutWaitingPanes(after, new Set([`pane:${entry.paneKey}`])).attention).toEqual([])
    expect(withReplyDecisionAttention(before, [], inputs)).toBe(before)
    for (const change of [
      { state: 'working' as const },
      { stateStartedAt: ATTENTION_FIXTURE_NOW },
      { prompt: 'A different user turn' },
      { providerSession: { key: 'session_id' as const, id: 'replacement' } },
      { lastAssistantMessage: 'All done.' },
      { connectionId: 'remote-host' },
      { failed: true },
      { sessionBoundary: true },
      { worktreeId: 'other-workspace' }
    ]) {
      const changed = {
        ...inputs,
        agentStatusByPaneKey: { [entry.paneKey]: { ...entry, ...change } }
      }
      expect(withReplyDecisionAttention(before, decisions, changed).attention).toEqual([])
    }
  })
  it('lists waiting and blocked panes oldest first and skips working ones', () => {
    const inputs = attentionFixtureInputs({
      agentStatusByPaneKey: {
        [ATTENTION_FIXTURE_PANE_A]: attentionFixtureEntry(ATTENTION_FIXTURE_PANE_A, 'tab-a', 'w1', {
          state: 'blocked',
          stateStartedAt: ATTENTION_FIXTURE_NOW - 1_000
        }),
        [ATTENTION_FIXTURE_PANE_B]: attentionFixtureEntry(ATTENTION_FIXTURE_PANE_B, 'tab-b', 'w2', {
          state: 'waiting',
          stateStartedAt: ATTENTION_FIXTURE_NOW - 30_000,
          interactivePrompt: '{"questions":[{"question":"Deploy to prod?"}]}'
        })
      }
    })
    const snapshot = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW)
    expect(snapshot.attention.map((pane) => pane.paneKey)).toEqual([
      ATTENTION_FIXTURE_PANE_B,
      ATTENTION_FIXTURE_PANE_A
    ])
    expect(snapshot.attention[0]).toMatchObject({
      cause: 'waiting',
      portalPaneKey: ATTENTION_FIXTURE_PANE_B,
      worktreeId: 'w2',
      tabId: 'tab-b',
      askSummary: '{"questions":[{"question":"Deploy to prod?"}]}',
      repoName: 'Repo One',
      worktreeName: 'wt-two'
    })
    expect(snapshot.attention[1]?.cause).toBe('blocked')
    expect([...snapshot.attentionWorktreeIds].sort()).toEqual(['w1', 'w2'])
    expect(snapshot.attentionByPaneKey.get(ATTENTION_FIXTURE_PANE_A)?.cause).toBe('blocked')
  })

  it('lists one conversation’s question once across the panes that show it', () => {
    // Why: a conversation resumed into a second pane (or mirrored from another computer) repeats
    // the same pending question under another pane key; Needs you asks the person once.
    const ask = '{"questions":[{"question":"Did you approve the 12 campaigns?"}]}'
    const session = { key: 'session_id' as const, id: 'claude-b504af61' }
    const asker = attentionFixtureEntry(ATTENTION_FIXTURE_PANE_A, 'tab-a', 'w1', {
      state: 'waiting',
      stateStartedAt: ATTENTION_FIXTURE_NOW - 30_000,
      toolName: 'AskUserQuestion',
      interactivePrompt: ask,
      providerSession: session
    })
    const copy = attentionFixtureEntry(ATTENTION_FIXTURE_PANE_B, 'tab-b', 'w2', {
      state: 'waiting',
      stateStartedAt: ATTENTION_FIXTURE_NOW - 5_000,
      toolName: 'AskUserQuestion',
      interactivePrompt: ask,
      providerSession: session
    })
    const inputs = attentionFixtureInputs({
      agentStatusByPaneKey: { [asker.paneKey]: asker, [copy.paneKey]: copy }
    })
    const snapshot = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW)
    expect(snapshot.attention.map((pane) => pane.paneKey)).toEqual([ATTENTION_FIXTURE_PANE_A])
    expect(snapshot.attention[0]?.mirrorPaneKeys).toEqual([ATTENTION_FIXTURE_PANE_B])
    expect(snapshot.attentionByPaneKey.has(ATTENTION_FIXTURE_PANE_B)).toBe(false)
    expect(snapshot.cards).toHaveLength(2)

    // A live copy outranks a restored one even when the restored one has waited longer.
    const restoredAsker = { ...asker, restoredUnconfirmed: true }
    const restored = buildAgentPaneSnapshot(
      attentionFixtureInputs({
        agentStatusByPaneKey: { [asker.paneKey]: restoredAsker, [copy.paneKey]: copy }
      }),
      ATTENTION_FIXTURE_NOW
    )
    expect(restored.attention.map((pane) => pane.paneKey)).toEqual([ATTENTION_FIXTURE_PANE_B])

    // Different questions, or no conversation id, stay separate rows.
    const other = { ...copy, interactivePrompt: '{"questions":[{"question":"Pause them?"}]}' }
    expect(
      buildAgentPaneSnapshot(
        attentionFixtureInputs({
          agentStatusByPaneKey: { [asker.paneKey]: asker, [copy.paneKey]: other }
        }),
        ATTENTION_FIXTURE_NOW
      ).attention
    ).toHaveLength(2)
    const { providerSession: _unused, ...noSession } = copy
    expect(
      buildAgentPaneSnapshot(
        attentionFixtureInputs({
          agentStatusByPaneKey: { [asker.paneKey]: asker, [copy.paneKey]: noSession }
        }),
        ATTENTION_FIXTURE_NOW
      ).attention
    ).toHaveLength(2)
  })

  it('keeps working panes as cards without attention', () => {
    const inputs = attentionFixtureInputs({
      agentStatusByPaneKey: {
        [ATTENTION_FIXTURE_PANE_A]: attentionFixtureEntry(ATTENTION_FIXTURE_PANE_A, 'tab-a', 'w1')
      }
    })
    const snapshot = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW)
    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]).toMatchObject({ bucket: 'working', dotState: 'working' })
    expect(snapshot.attention).toEqual([])
    expect(snapshot.cardsByTabId.get('tab-a')?.[0]?.paneKey).toBe(ATTENTION_FIXTURE_PANE_A)
  })

  it('treats a stale waiting entry as no longer needing the user', () => {
    const inputs = attentionFixtureInputs({
      agentStatusByPaneKey: {
        [ATTENTION_FIXTURE_PANE_A]: attentionFixtureEntry(ATTENTION_FIXTURE_PANE_A, 'tab-a', 'w1', {
          state: 'waiting',
          updatedAt: ATTENTION_FIXTURE_NOW - 60 * 60 * 1_000
        })
      }
    })
    const snapshot = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW)
    expect(snapshot.attention).toEqual([])
  })

  it('promotes a permission title on a hookless live pane', () => {
    const inputs = attentionFixtureInputs({
      runtimePaneTitlesByTabId: { 'tab-a': { 1: `${GEMINI_PERMISSION} Gemini CLI` } }
    })
    const snapshot = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW)
    expect(snapshot.attention).toHaveLength(1)
    expect(snapshot.attention[0]).toMatchObject({
      worktreeId: 'w1',
      tabId: 'tab-a',
      cause: 'waiting'
    })
  })
})

describe('selectAgentPaneSnapshot', () => {
  it('reuses the projection while every input slice keeps its identity', () => {
    resetAgentPaneSnapshotCacheForTest()
    // Why: the cached selector reads the wall clock, so the fixture must be fresh against it.
    const now = Date.now()
    const inputs = selectAgentPaneSnapshotInputs(
      attentionFixtureInputs({
        agentStatusByPaneKey: {
          [ATTENTION_FIXTURE_PANE_A]: attentionFixtureEntry(
            ATTENTION_FIXTURE_PANE_A,
            'tab-a',
            'w1',
            {
              state: 'waiting',
              updatedAt: now,
              stateStartedAt: now - 1_000
            }
          )
        }
      })
    )
    const first = selectAgentPaneSnapshot(inputs)
    expect(selectAgentPaneSnapshot({ ...inputs })).toBe(first)
    const second = selectAgentPaneSnapshot({ ...inputs, agentStatusEpoch: 1 })
    expect(second).not.toBe(first)
    expect(second.attention).toHaveLength(1)
  })

  it('tolerates a partial store by defaulting every slice', () => {
    resetAgentPaneSnapshotCacheForTest()
    const snapshot = selectAgentPaneSnapshot(selectAgentPaneSnapshotInputs({}))
    expect(snapshot.attention).toEqual([])
    expect(snapshot.cards).toEqual([])
  })
})

it('preserves monitoring and stale execution uncertainty instead of presenting them as idle', () => {
  for (const patch of [
    { workingMode: 'monitoring' as const },
    { restoredUnconfirmed: true as const }
  ]) {
    const inputs = attentionFixtureInputs({
      agentStatusByPaneKey: {
        [ATTENTION_FIXTURE_PANE_A]: attentionFixtureEntry(
          ATTENTION_FIXTURE_PANE_A,
          'tab-a',
          'w1',
          patch
        )
      }
    })
    const card = buildAgentPaneSnapshot(inputs, ATTENTION_FIXTURE_NOW).cards[0]!
    expect(card).toMatchObject(
      'workingMode' in patch ? { workingMode: 'monitoring' } : { activityUnverifiable: true }
    )
  }
})
