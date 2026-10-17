import { describe, expect, it } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { workflowView } from '../local-workflows/local-workflow-ui.fixtures'
import { workflowResults } from './workflow-results-candidates'

const claim = (key: string, location: string, tally: 'confirmed' | 'refuted' | 'unverified') => ({
  key,
  title: `Claim ${key}`,
  detail: `Why ${key} holds.`,
  location,
  severity: 'none' as const,
  repeats: 0,
  tally,
  votes: []
})

function view(template: 'investigate' | 'custom'): LocalWorkflowView {
  return {
    ...workflowView(),
    executionId: 'run-1',
    state: 'completed',
    graphRun: {
      spec: { ...workflowTemplate('investigate', ['claude', 'codex', 'grok']), template },
      levels: {},
      gaps: [],
      notes: [],
      steps: [
        {
          id: 'factcheck',
          state: 'done',
          agents: [],
          rounds: [
            {
              round: 1,
              state: 'done',
              calls: [],
              notes: [],
              targets: [
                claim('a', 'src/a.ts:3', 'confirmed'),
                claim('b', '', 'confirmed'),
                claim('c', 'docs/c.md', 'refuted')
              ]
            }
          ]
        }
      ]
    }
  }
}

describe('Investigate results', () => {
  it('lists the fact-checked claims, and a confirmed claim without evidence as unverified', () => {
    const results = workflowResults(view('investigate'))!
    expect(results.kind).toBe('items')
    expect(results.candidates.map((entry) => [entry.key, entry.tally, entry.preselected])).toEqual([
      ['a', 'confirmed', true],
      ['b', 'unverified', false],
      ['c', 'refuted', false]
    ])
    // Other workflows keep the reviewers' verdicts as they are.
    expect(workflowResults(view('custom'))!.candidates.map((entry) => entry.tally)).toEqual([
      'confirmed',
      'confirmed',
      'refuted'
    ])
  })
})
