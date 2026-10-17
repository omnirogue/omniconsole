import { describe, expect, it } from 'vitest'
import {
  HANDOFF_OPERATION_ID_PATTERN,
  agentStepDoneOperationId,
  agentStepFailedOperationId,
  agentStepOperationId,
  doneDeliveryOperationId,
  sessionRequestDoneOperationId,
  sessionRequestHandoffOperationId,
  sessionRequestOperationId
} from './handoff-operation-ids'

describe('handoff operation ids', () => {
  it('are deterministic per chain step and match the contract pattern', () => {
    const id = agentStepOperationId('chn_4384380282c0', 'step_1_s9f8e7')
    expect(id).toBe('chain_chn_4384380282c0_step_step_1_s9f8e7')
    expect(agentStepOperationId('chn_4384380282c0', 'step_1_s9f8e7')).toBe(id)
    for (const candidate of [
      id,
      agentStepDoneOperationId('chn_1', 'step_1'),
      agentStepFailedOperationId('chn_1', 'step_1', 2),
      sessionRequestOperationId('ldg_abc', 'emp_sal'),
      sessionRequestHandoffOperationId('hth_abc', 'emp_uma'),
      sessionRequestDoneOperationId('hth_abc'),
      doneDeliveryOperationId('btk_abc', 'tab:1:pane:2')
    ]) {
      expect(candidate).toMatch(HANDOFF_OPERATION_ID_PATTERN)
    }
  })

  it('replaces characters the contract forbids and bounds the length', () => {
    expect(doneDeliveryOperationId('btk_a', 'tab:1/pane 2')).toBe('done_btk_a_tab_1_pane_2')
    expect(agentStepOperationId('x'.repeat(200), 'y'.repeat(200))).toHaveLength(160)
    expect(agentStepFailedOperationId('c', 's', 0)).toMatch(/_failed_1$/)
  })

  it('preserves every short replay key exactly', () => {
    expect([
      agentStepOperationId('c', 's'),
      agentStepDoneOperationId('c', 's'),
      agentStepFailedOperationId('c', 's', 2),
      sessionRequestOperationId('ldg_abc', 'emp_sal'),
      sessionRequestHandoffOperationId('hth_abc', 'emp_uma'),
      sessionRequestDoneOperationId('hth_abc'),
      doneDeliveryOperationId('btk_abc', 'tab:1:pane:2')
    ]).toEqual([
      'chain_c_step_s',
      'chain_c_step_s_done',
      'chain_c_step_s_failed_2',
      'request_ldg_abc_emp_sal',
      'request_hth_abc_handoff_emp_uma',
      'request_hth_abc_done',
      'done_btk_abc_tab_1_pane_2'
    ])
  })

  it('keeps long lifecycle events and retry attempts distinct', () => {
    const chain = 'c'.repeat(200)
    const ids = [
      agentStepOperationId(chain, 'step'),
      agentStepDoneOperationId(chain, 'step'),
      agentStepFailedOperationId(chain, 'step', 1),
      agentStepFailedOperationId(chain, 'step', 2)
    ]
    expect(new Set(ids).size).toBe(4)
    expect(agentStepOperationId(chain, 'step')).toBe(ids[0])
    for (const id of ids) {
      expect(id).toMatch(HANDOFF_OPERATION_ID_PATTERN)
      expect(id).toHaveLength(160)
    }
  })

  it('retains distinguishing tails for every long key builder', () => {
    const prefix = 'x'.repeat(200)
    const builders = [
      (tail: string) => agentStepOperationId(`${prefix}${tail}`, 'step'),
      (tail: string) => sessionRequestOperationId(prefix, tail),
      (tail: string) => sessionRequestHandoffOperationId(prefix, tail),
      (tail: string) => sessionRequestDoneOperationId(`${prefix}${tail}`),
      (tail: string) => doneDeliveryOperationId(prefix, tail)
    ]
    for (const build of builders) {
      expect(build('a')).not.toBe(build('b'))
      expect(build('a')).toMatch(HANDOFF_OPERATION_ID_PATTERN)
    }
  })
})
