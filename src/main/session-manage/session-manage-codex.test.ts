/**
 * Codex behaves as Claude does under `omni session`: its closing offer ("If you want, I can …")
 * is the one step `continue --yes` sends, and `continue`/`ask` queue into its terminal only while
 * its own process holds that terminal, or into its chat view through the chat host.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  structuredConversationSource,
  type ConversationSource
} from '../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { nextStepsFromReply } from '../next-steps/next-step-turn-answers'
import { queueQuestion } from './session-manage-ask'
import { continueSession } from './session-manage-continue'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import { chooseOwnStep, sessionOwnSteps } from './session-manage-steps'
import { agentProcess, manageEntry } from './session-manage-test-fixtures'

const PTY: ConversationSource = { worktreeId: 'repo::/w', paneKey: 'tab-3:leaf-1', kind: 'pty' }
const CHAT = structuredConversationSource('repo::/w', 'codex-chat-1')
const manager: SessionManageActor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Manager' }

const CODEX_REPLY = [
  'I fixed the empty-input crash in the parser and the focused tests pass.',
  '',
  'If you want, I can add a regression test for the empty-input case.'
].join('\n')

function codexSet(conversation: ConversationSource): NextStepSuggestionSet {
  return {
    id: 'set-codex',
    conversation,
    worktreeId: conversation.worktreeId,
    turnKey: 't1',
    origin: 'parsed',
    createdAt: 1,
    status: 'pending',
    suggestions: nextStepsFromReply(CODEX_REPLY)
  } as NextStepSuggestionSet
}

function deps(set: NextStepSuggestionSet): SessionDeliveryDeps {
  const latest = {
    known: true,
    turnKey: 't1',
    text: CODEX_REPLY,
    complete: true,
    proposal: JSON.stringify(set.suggestions),
    empty: false
  }
  return {
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
    readOwnSteps: vi.fn(async () => sessionOwnSteps({ parsed: set })),
    newId: () => 'id-1'
  } satisfies SessionDeliveryDeps
}

const codexTerminal = (agentForeground: boolean | null) =>
  manageEntry({ agent: 'codex', paneKey: PTY.paneKey, agentForeground, stateBasis: 'screen' })
const codexChat = manageEntry({
  agent: 'codex',
  kind: 'chat',
  paneKey: CHAT.paneKey,
  terminal: null,
  agentForeground: null,
  stateBasis: 'chat-host'
})

describe('Codex under omni session', () => {
  it('reads its "If you want, I can …" offer as the one step --yes sends', () => {
    const own = sessionOwnSteps({ parsed: codexSet(PTY) })
    expect(own.steps.map((step) => [step.title, step.offered])).toEqual([
      ['Add a regression test for the empty-input case', true]
    ])
    const chosen = chooseOwnStep(own, { kind: 'yes' })
    expect('step' in chosen && chosen.step.title).toBe(
      'Add a regression test for the empty-input case'
    )
  })

  it('continues --yes into a Codex terminal whose process holds it, and its chat view', async () => {
    for (const [entry, source, proof] of [
      [codexTerminal(true), PTY, agentProcess({ agent: 'codex' })],
      [codexChat, CHAT, null]
    ] as const) {
      const set = codexSet(source)
      const d = deps(set)
      await continueSession(d, {
        actor: manager,
        target: { entry, source, agentProcess: proof },
        answer: { kind: 'yes' },
        dryRun: false
      })
      expect(d.decideRelayed).toHaveBeenCalledWith('set-codex', 's1', expect.anything())
    }
  })

  it('asks a Codex chat, and never a Codex terminal back at a shell', async () => {
    const d = deps(codexSet(CHAT))
    await queueQuestion(d, {
      actor: manager,
      target: { entry: codexChat, source: CHAT, agentProcess: null },
      question: 'Where are you at?',
      dryRun: false
    })
    expect(d.enqueue).toHaveBeenCalledWith(
      CHAT,
      expect.objectContaining({ id: 'session-ask:id-1' })
    )
    for (const agentForeground of [false, null]) {
      await expect(
        queueQuestion(d, {
          actor: manager,
          target: { entry: codexTerminal(agentForeground), source: PTY, agentProcess: null },
          question: 'Where are you at?',
          dryRun: false
        })
      ).rejects.toThrow('could not be proven to hold its terminal')
    }
  })
})
