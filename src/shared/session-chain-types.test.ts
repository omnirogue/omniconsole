import { describe, expect, it } from 'vitest'
import {
  isLiveSessionChain,
  isSessionFollowUpChain,
  normalizeSessionChains,
  sessionChainPredecessors,
  sessionChainStepOutputDir,
  sessionFollowUpStep
} from './session-chain-types'
import { isHostWaitingFollowUp, shouldKeepSessionChainRecord } from './session-chain-retention'

const step = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent: 'claude',
  prompt: `do ${id}`,
  status: 'queued',
  ...extra
})

describe('session chain types', () => {
  it('builds the .omni/runs output folder for a step on any workspace', () => {
    expect(sessionChainStepOutputDir('/Users/me/Webinar/', 'chn_1', 'step_2')).toBe(
      '/Users/me/Webinar/.omni/runs/chn_1/step_2'
    )
    expect(sessionChainStepOutputDir('C:\\Work\\Webinar', 'chn_1', 'step_2')).toBe(
      'C:\\Work\\Webinar\\.omni\\runs\\chn_1\\step_2'
    )
  })

  it('normalizes persisted chains, dropping broken ones and de-duplicating ids', () => {
    const chains = normalizeSessionChains([
      {
        id: 'chn_1',
        workspacePath: '/w',
        worktreeId: 'folder:f1',
        hostId: 'local',
        sourcePaneKey: 'tab-1:leaf-1',
        sourceRowKey: '["local","folder:f1","tab-1:leaf-1"]',
        auto: true,
        steps: [
          step('s1', { presetId: 'improve', model: 'opus', effort: 'max' }),
          step('s2', { presetId: 'bogus' }),
          'junk'
        ],
        currentIndex: 7,
        state: 'launching',
        createdAt: 5
      },
      {
        id: 'chn_1',
        workspacePath: '/dup',
        worktreeId: 'x',
        sourcePaneKey: 'p',
        sourceRowKey: 'r',
        steps: [step('a')]
      },
      {
        id: 'chn_2',
        workspacePath: '/w',
        worktreeId: 'x',
        sourcePaneKey: 'p',
        sourceRowKey: 'r',
        steps: []
      },
      null
    ])
    expect(chains).toHaveLength(1)
    expect(chains[0]).toMatchObject({
      id: 'chn_1',
      auto: true,
      currentIndex: 2,
      // Why: a launch that was in flight at shutdown cannot be trusted to have happened.
      state: 'waiting',
      updatedAt: 5
    })
    expect(chains[0]?.steps).toEqual([
      {
        id: 's1',
        agent: 'claude',
        prompt: 'do s1',
        presetId: 'improve',
        model: 'opus',
        effort: 'max',
        status: 'queued'
      },
      { id: 's2', agent: 'claude', prompt: 'do s2', status: 'queued' }
    ])
  })

  it('treats waiting, ready and launching chains as live', () => {
    const base = normalizeSessionChains([
      {
        id: 'c',
        workspacePath: '/w',
        worktreeId: 'x',
        sourcePaneKey: 'p',
        sourceRowKey: 'r',
        steps: [step('a')]
      }
    ])[0]!
    expect(isLiveSessionChain(base)).toBe(true)
    expect(isLiveSessionChain({ ...base, state: 'ready' })).toBe(true)
    expect(isLiveSessionChain({ ...base, state: 'done' })).toBe(false)
    expect(isLiveSessionChain({ ...base, state: 'cancelled' })).toBe(false)
  })
})

const chainBase = {
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: 'row',
  createdAt: 1,
  updatedAt: 1
}

const handoffStep = (extra: Record<string, unknown> = {}) => ({
  kind: 'handoff',
  id: 'step_h',
  status: 'queued',
  handoff: {
    revision: 2,
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      { employeeId: 'emp_iris', name: 'Iris', operationId: 'fu_0123456789', delivery: 'sending' }
    ],
    action: 'review',
    deliverables: { kind: 'files', paths: ['/w/out/report.md'] },
    includeSummary: true,
    note: 'Please review',
    dueAt: '2026-09-11T21:00:00.000Z',
    savedAt: 5,
    capturedAt: 9,
    files: [
      {
        sourcePath: '/w/out/report.md',
        name: 'report.md',
        sha256: 'a'.repeat(64),
        size: 10,
        taskPath: 'handoffs/report.md'
      },
      { sourcePath: null, name: 'draft-final-summary.md', sha256: 'b'.repeat(64), size: 5 }
    ],
    summaryMarkdown: '# Webinar intro',
    ...extra
  }
})

describe('session chain handoff steps', () => {
  it('keeps chains persisted before step kinds byte-compatible', () => {
    const persisted = {
      id: 'chn_old',
      workspacePath: '/w',
      worktreeId: 'folder:f1',
      hostId: 'local',
      sourcePaneKey: 'tab-1:leaf-1',
      sourceRowKey: 'row',
      auto: false,
      steps: [
        {
          id: 's1',
          agent: 'claude',
          prompt: 'go',
          status: 'launched',
          launchedPaneKey: 'tab-2:leaf-1',
          launchedAt: 3
        }
      ],
      currentIndex: 1,
      state: 'done',
      createdAt: 1,
      updatedAt: 2
    }
    const [loaded] = normalizeSessionChains([persisted])
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(persisted))
    expect(isSessionFollowUpChain(loaded!)).toBe(false)
    // An explicit agent kind loads as the same agent step, without adding the field.
    const [explicit] = normalizeSessionChains([
      { ...persisted, steps: [{ ...persisted.steps[0], kind: 'agent' }] }
    ])
    expect(explicit?.steps[0]).toEqual(persisted.steps[0])
  })

  it('loads a handoff step with its persisted delivery state', () => {
    const [chain] = normalizeSessionChains([{ ...chainBase, id: 'chn_f', steps: [handoffStep()] }])
    expect(chain?.steps[0]).toMatchObject({
      kind: 'handoff',
      status: 'queued',
      handoff: {
        revision: 2,
        recipients: [{ delivery: 'sending', operationId: 'fu_0123456789' }],
        capturedAt: 9,
        files: [{ taskPath: 'handoffs/report.md' }, { sourcePath: null }]
      }
    })
    expect(isSessionFollowUpChain(chain!)).toBe(true)
    expect(sessionFollowUpStep(chain!)?.id).toBe('step_h')
  })

  it('drops unknown kinds and broken handoffs instead of running them as agents', () => {
    const chains = normalizeSessionChains([
      {
        ...chainBase,
        id: 'chn_future',
        steps: [{ kind: 'webhook', id: 'x', agent: 'claude', prompt: 'p' }]
      },
      {
        ...chainBase,
        id: 'chn_mixed',
        steps: [{ id: 'a', agent: 'claude', prompt: 'do a', status: 'queued' }, { kind: 'webhook' }]
      },
      { ...chainBase, id: 'chn_task', steps: [handoffStep({ taskId: 'not-a-task' })] },
      { ...chainBase, id: 'chn_people', steps: [handoffStep({ recipients: [] })] },
      { ...chainBase, id: 'chn_note', steps: [handoffStep({ note: '  ' })] },
      {
        ...chainBase,
        id: 'chn_nothing',
        steps: [handoffStep({ includeSummary: false, deliverables: { kind: 'files', paths: [] } })]
      }
    ])
    expect(chains.map((chain) => chain.id)).toEqual(['chn_mixed', 'chn_nothing'])
    expect(chains[0]?.steps).toHaveLength(1)
  })

  it('replays a sent person without a thread and restarts a capture it cannot deliver exactly', () => {
    const [chain] = normalizeSessionChains([
      {
        ...chainBase,
        id: 'chn_f',
        steps: [
          handoffStep({
            recipients: [
              {
                employeeId: 'emp_iris',
                name: 'Iris',
                operationId: 'fu_0123456789',
                delivery: 'sent'
              }
            ],
            summaryMarkdown: undefined
          })
        ]
      }
    ])
    const rule = sessionFollowUpStep(chain!)!.handoff
    expect(rule.recipients[0]?.delivery).toBe('sending')
    expect(rule.capturedAt).toBeUndefined()
    expect(rule.files).toBeUndefined()
  })

  it('marks a step delivered only when every person has an acknowledged thread', () => {
    const sent = [
      {
        employeeId: 'emp_iris',
        name: 'Iris',
        operationId: 'fu_0123456789',
        delivery: 'sent',
        threadId: 'hth_abc'
      }
    ]
    const [delivered, pending] = normalizeSessionChains([
      {
        ...chainBase,
        id: 'a',
        steps: [{ ...handoffStep({ recipients: sent }), status: 'delivered' }]
      },
      { ...chainBase, id: 'b', steps: [{ ...handoffStep(), status: 'delivered' }] }
    ])
    expect(delivered?.steps[0]?.status).toBe('delivered')
    expect(pending?.steps[0]?.status).toBe('queued')
  })

  it('keeps handoff provenance and failures while unlaunched queue records are pruned', () => {
    const now = 30 * 24 * 60 * 60 * 1000
    const [followUp] = normalizeSessionChains([
      { ...chainBase, id: 'f', state: 'done', updatedAt: now - 1000, steps: [handoffStep()] }
    ])
    const [queue] = normalizeSessionChains([
      {
        ...chainBase,
        id: 'q',
        state: 'done',
        steps: [{ id: 'a', agent: 'claude', prompt: 'do a', status: 'launched' }]
      }
    ])
    expect(shouldKeepSessionChainRecord(followUp!, now)).toBe(true)
    expect(shouldKeepSessionChainRecord({ ...followUp!, updatedAt: 0 }, now)).toBe(false)
    expect(shouldKeepSessionChainRecord({ ...followUp!, state: 'failed', updatedAt: 0 }, now)).toBe(
      true
    )
    expect(shouldKeepSessionChainRecord(queue!, now)).toBe(false)
    // Why: a finished conversation reads its plan for "Handed to X" until it is archived.
    expect(shouldKeepSessionChainRecord({ ...queue!, updatedAt: now - 60_000 }, now)).toBe(true)
    expect(
      shouldKeepSessionChainRecord({ ...queue!, updatedAt: now - 11 * 60 * 60_000 }, now)
    ).toBe(false)
    expect(shouldKeepSessionChainRecord({ ...queue!, state: 'failed' }, now)).toBe(true)
    expect(
      shouldKeepSessionChainRecord(
        {
          ...queue!,
          steps: [
            {
              id: 'a',
              agent: 'claude',
              prompt: 'do a',
              status: 'launched',
              launchedPaneKey: 'tab:leaf'
            }
          ]
        },
        now
      )
    ).toBe(true)
    const [offline] = normalizeSessionChains([
      {
        ...chainBase,
        id: 'o',
        state: 'failed',
        steps: [
          handoffStep({
            exception: { code: 'host-unreachable', subject: 'devbox', detail: '', at: 3 }
          })
        ]
      }
    ])
    expect(isHostWaitingFollowUp(offline!)).toBe(true)
    expect(isHostWaitingFollowUp({ ...offline!, state: 'cancelled' })).toBe(false)
  })

  it('keeps a fan-out group and a round mark, and drops a malformed round', () => {
    const [chain] = normalizeSessionChains([
      {
        id: 'chn_g',
        workspacePath: '/w',
        worktreeId: 'folder:f1',
        sourcePaneKey: 'tab-1:leaf-1',
        sourceRowKey: 'row',
        steps: [
          step('a', { group: 'g1' }),
          step('b', { group: 'g1', round: { key: 'r', index: 1, total: 2 } }),
          step('c', { round: { key: 'r', index: 3, total: 2 } })
        ]
      }
    ])
    expect(
      chain?.steps.map((entry) => [entry.group, entry.kind !== 'handoff' && entry.round])
    ).toEqual([
      ['g1', undefined],
      ['g1', { key: 'r', index: 1, total: 2 }],
      [undefined, undefined]
    ])
  })

  it('finds what feeds a step: the group before it, or the nearest earlier agent step', () => {
    const steps = [
      step('a', { group: 'g1', launchedPaneKey: 'pa' }),
      step('b', { group: 'g1', launchedPaneKey: 'pb' }),
      {
        kind: 'handoff',
        id: 'h',
        group: 'g1',
        status: 'queued',
        handoff: {
          revision: 1,
          taskId: 'btk_1234',
          taskTitle: 'T',
          sessionLabel: 'S',
          recipients: [
            { employeeId: 'emp_u', name: 'U', operationId: 'op_12345678', delivery: 'pending' }
          ],
          deliverables: { kind: 'files', paths: [] },
          includeSummary: true,
          note: 'n',
          savedAt: 1
        }
      },
      step('c'),
      step('d')
    ]
    const [chain] = normalizeSessionChains([
      {
        id: 'chn_p',
        workspacePath: '/w',
        worktreeId: 'folder:f1',
        sourcePaneKey: 'tab-1:leaf-1',
        sourceRowKey: 'row',
        steps
      }
    ])
    const ids = (index: number) => sessionChainPredecessors(chain!, index).map((entry) => entry.id)
    expect(ids(0)).toEqual([])
    expect(ids(1)).toEqual([])
    expect(ids(2)).toEqual([])
    expect(ids(3)).toEqual(['a', 'b'])
    expect(ids(4)).toEqual(['c'])
  })
})
