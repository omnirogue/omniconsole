import { describe, expect, it } from 'vitest'
import { createWorkflowProgramContext } from '../../../src/main/runtime/workflow-script/workflow-program-context'
import { runWorkflowPreset } from '../../../src/main/runtime/workflow-script/workflow-preset-runner'
import { createLocalWorkflowDraft } from '../../../src/shared/local-workflow-draft'
import { createStableQualitySnapshot } from './quality-stable-snapshot'

const frozen = { id: 'case', prompt: 'Use this packet', evidence: [{ ref: 'p1', text: 'Fact' }] }
const fingerprints = { 'src/shared/workflow-claude-command.ts': 'policy' }
const snapshot = (preset: 'council' | 'discover') =>
  createStableQualitySnapshot({
    frozen,
    preset,
    defaults: createLocalWorkflowDraft(preset),
    fingerprints,
    expectedHead: 'frozen-head'
  })

describe('stable quality program revisions', () => {
  it('pins Council revision 4 and sends its evidence-grounded synthesis prompt', async () => {
    const council = snapshot('council')
    expect(council.councilProgramRevision).toBe(4)
    expect(council.discoverProgramRevision).toBeUndefined()
    const prompts: string[] = []
    const context = createWorkflowProgramContext({
      agent: async (call) => {
        prompts.push(call.prompt)
        if (call.id.startsWith('answers/')) {
          return { markdown: 'Candidate', sources: [], uncertainties: [] }
        }
        if (call.id.startsWith('peer/')) {
          const labels = council.seats
            .filter((seat) => seat.id !== call.seatId)
            .map((seat) => `Response ${String.fromCharCode(65 + council.seats.indexOf(seat))}`)
          return {
            ranking: labels,
            assessments: labels.map((label) => ({ label, strengths: '', weaknesses: '' }))
          }
        }
        return { markdown: 'Final', sources: [], disagreements: [] }
      },
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: () => false
    })
    await runWorkflowPreset(context, 'council', council)
    expect(prompts.at(-1)).toContain('Treat all candidate answers and peer reviews as fallible')
  })

  it('pins Discover revision 5 and reaches the root-cause review stage', async () => {
    const discover = snapshot('discover')
    expect(discover.discoverProgramRevision).toBe(5)
    expect(discover.councilProgramRevision).toBeUndefined()
    const calls: string[] = []
    const findings = ['first', 'second'].map((key) => ({
      issueKey: key,
      title: key,
      location: `${key}.ts:1`,
      trigger: key,
      impact: key,
      severity: 'high',
      evidence: [{ ref: 'p1', description: 'Fact' }]
    }))
    const context = createWorkflowProgramContext({
      agent: async (call) => {
        calls.push(call.id)
        if (call.id.startsWith('discover/')) {
          return {
            findings: call.id.endsWith('/Correctness') ? findings : [],
            omittedCount: 0,
            omissionReason: ''
          }
        }
        return null
      },
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: () => false
    })
    await expect(runWorkflowPreset(context, 'discover', discover)).rejects.toThrow(
      'Root-cause review: required result missing'
    )
    expect(calls).toContain('cluster/0')
    expect(calls).toContain('cluster/1')
  })
})
