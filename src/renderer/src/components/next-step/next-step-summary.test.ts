import { describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  describeNextStepDraft,
  describeSessionChain,
  describeSessionChainStrip
} from './next-step-summary'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    ),
  i18n: { language: 'en' }
}))

function chain(steps: SessionChain['steps']): SessionChain {
  return {
    id: 'chn_1',
    workspacePath: '/w',
    worktreeId: 'folder:f1',
    hostId: null,
    sourcePaneKey: 'tab:leaf',
    sourceRowKey: 'row',
    auto: false,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
}

const uma = {
  kind: 'handoff' as const,
  id: 'h1',
  status: 'queued' as const,
  handoff: {
    revision: 1,
    taskId: 'btk_1',
    taskTitle: 'T',
    sessionLabel: 'S',
    recipients: [
      {
        employeeId: 'emp_u',
        name: 'Uma',
        operationId: 'op_12345678',
        delivery: 'pending' as const
      }
    ],
    deliverables: { kind: 'files' as const, paths: [] },
    includeSummary: true,
    note: 'n',
    savedAt: 1
  }
}

describe('next-step summaries', () => {
  it('a draft reads as one arrow, a fan-out as a fork, rounds as a loop', () => {
    expect(
      describeNextStepDraft({
        end: 'me',
        placement: null,
        recipients: [],
        note: '',
        after: [],
        handoff: { task: null, deliverables: null, includeSummary: true }
      })
    ).toBe('Choose who gets this next.')
    const claude = {
      kind: 'agent' as const,
      key: 'a',
      agent: 'claude' as const,
      presetId: 'improve' as const,
      instructions: '',
      rounds: 3
    }
    const base = {
      end: 'me' as const,
      placement: null,
      note: '',
      after: [] as never[],
      handoff: { task: null, deliverables: null, includeSummary: true }
    }
    expect(describeNextStepDraft({ ...base, recipients: [claude] })).toBe(
      'Current → ✨ Improve · Claude · ↻ 3 rounds → ↩ Back to me · starts 3 sessions'
    )
    expect(
      describeNextStepDraft({
        ...base,
        recipients: [claude, { kind: 'person', key: 'p', id: 'emp_u', name: 'Uma' }]
      })
    ).toBe('Current ⑂ ✨ Improve · Claude and 👤 Uma → ↩ Back to me')
  })

  it('a saved chain says what is still queued, group first, then the rest', () => {
    const a = {
      id: 's1',
      agent: 'claude' as const,
      prompt: 'x',
      group: 'g1',
      status: 'queued' as const
    }
    const b = {
      id: 's2',
      agent: 'codex' as const,
      prompt: 'x',
      group: 'g1',
      status: 'queued' as const
    }
    expect(describeSessionChain(chain([a, b, uma]))).toBe('⑂ Claude and Codex, then Uma')
    expect(
      describeSessionChain(chain([{ ...a, group: undefined, status: 'launched' }, uma]))
    ).toBe('→ Uma')
    expect(
      describeSessionChain(
        chain([
          { ...a, group: undefined, round: { key: 'r', index: 1, total: 2 } },
          { ...a, id: 's3', group: undefined, round: { key: 'r', index: 2, total: 2 } }
        ])
      )
    ).toBe('↻ 2 rounds · Claude')
  })

  it('says a failed plan FAILED, and "needs you" only with an open request to the owner', () => {
    const a = { id: 's1', agent: 'claude' as const, prompt: 'p', status: 'queued' as const }
    // A legacy chain whose reviewer returned no valid verdict: an operational failure.
    expect(describeSessionChain({ ...chain([a]), state: 'failed' })).toBe('Next step failed')
    const outcomeSet = {
      schemaVersion: 1,
      revision: 1,
      outcomes: [
        {
          id: 'o1',
          title: 'Ship it',
          finish: 'complete',
          dependsOn: [],
          conditions: [{ id: 'c1', kind: 'report', target: 'o1' }],
          actions: [],
          revision: 1,
          status: 'blocked',
          blockedReason: 'No activity was observed for 180s.',
          evidence: []
        }
      ],
      removals: [],
      attempts: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: 1
    }
    const pursued = { ...chain([a]), outcomeSet } as unknown as SessionChain
    // Blocked with a reason is NOT a request: it is an unclassified, honest failure.
    expect(describeSessionChain(pursued, 1_000)).toBe('Next step failed')
    const asked = {
      ...pursued,
      outcomeSet: {
        ...outcomeSet,
        attention: [
          {
            id: 'att_1',
            kind: 'decision',
            scope: { outcomeId: 'o1', outcomeRevision: 1 },
            ask: 'Decide what happens to 2 open review findings.',
            why: 'All authorized review rounds are used.',
            recipient: { type: 'owner' },
            source: { type: 'review-findings', ref: 'rounds:2' },
            state: 'open',
            openedAt: 1
          }
        ]
      }
    } as unknown as SessionChain
    expect(describeSessionChain(asked, 1_000)).toBe('Next step needs you')
  })

  it('shows no queue for a plan that is finished or cancelled', () => {
    const a = { id: 's1', agent: 'claude' as const, prompt: 'p', status: 'queued' as const }
    expect(describeSessionChain(chain([a]))).toBe('→ Claude')
    // A step the plan never reached is not still to come once the plan is over.
    expect(describeSessionChain({ ...chain([a]), state: 'done' })).toBe('')
    expect(describeSessionChain({ ...chain([a]), state: 'cancelled' })).toBe('')
  })

  it('a strip reads Current → steps → Done, folding fan-outs and rounds', () => {
    const a = {
      id: 's1',
      agent: 'claude' as const,
      prompt: 'x',
      presetId: 'review' as const,
      group: 'g1',
      status: 'queued' as const
    }
    const b = {
      id: 's2',
      agent: 'codex' as const,
      prompt: 'x',
      presetId: 'review' as const,
      group: 'g1',
      status: 'queued' as const
    }
    const merge = {
      id: 's3',
      agent: 'claude' as const,
      prompt: 'x',
      presetId: 'synthesize' as const,
      status: 'queued' as const
    }
    expect(describeSessionChainStrip(chain([a, b, merge, uma]))).toEqual([
      'Current',
      '🤖🤖 2 × 👀 Review',
      '🧩 Synthesize · Claude',
      '👤 Uma',
      'Done'
    ])
    const r1 = {
      ...a,
      group: undefined,
      presetId: 'improve' as const,
      round: { key: 'r', index: 1, total: 3 }
    }
    const r2 = { ...r1, id: 's4', round: { key: 'r', index: 2, total: 3 } }
    expect(describeSessionChainStrip(chain([r1, r2]))).toEqual([
      'Current',
      '↻ 3 × ✨ Improve · Claude',
      'Done'
    ])
  })
})
