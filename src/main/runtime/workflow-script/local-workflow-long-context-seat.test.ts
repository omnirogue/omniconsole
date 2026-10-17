import { describe, expect, it } from 'vitest'
import { estimateCostUsd } from '../../claude-usage/claude-model-pricing'
import { localWorkflowModelLabel } from '../../../shared/local-workflow-model-label'
import { localWorkflowRunSpec } from '../../../shared/local-workflow-run-request'
import {
  resolveLocalWorkflowSeat,
  type LocalWorkflowSeatCatalog
} from '../../../shared/local-workflow-seats'
import { buildWorkflowClaudeStreamArgs } from '../../../shared/workflow-claude-command'
import { workflowModelContextTokens } from '../../../shared/workflow-model-context-window'
import { quickDiscoverBudget } from '../../../shared/workflow-quick-discover-budget'
import { workflowCatalogModels, workflowCliModel } from './local-workflow-models'

const LONG = 'claude-opus-5-5[1m]'

const claude: LocalWorkflowSeatCatalog = {
  agent: 'claude',
  accountId: 'system:claude',
  accountLabel: 'Claude',
  accountHome: '/home/.claude',
  policyRevision: 'claude-test-v1',
  models: workflowCatalogModels('claude')
}

describe('the 1M-context Opus workflow seat', () => {
  it('is accepted as a spec-file model override and keeps the default seat unchanged', () => {
    const spec = localWorkflowRunSpec(
      {
        template: 'discover',
        prompt: 'Find the bugs',
        spec: { steps: { find: { agents: [{ route: 'claude', model: LONG }] } } }
      },
      ['claude', 'codex']
    )
    expect(spec.steps.find((step) => step.id === 'find')?.agents).toEqual([
      { route: 'claude', model: LONG }
    ])
    const choice = { id: `claude:${LONG}`, agent: 'claude' as const, accountId: 'system:claude' }
    expect(resolveLocalWorkflowSeat({ ...choice, model: LONG }, [claude])).toMatchObject({
      model: LONG,
      effort: 'high',
      lineage: 'anthropic'
    })
    expect(resolveLocalWorkflowSeat({ ...choice, id: 'claude' }, [claude]).model).toBe(
      'claude-opus-5-5'
    )
  })

  it('reaches the Claude argv as the exact model with high effort', () => {
    const args = buildWorkflowClaudeStreamArgs({
      model: workflowCliModel('claude', LONG),
      effort: 'high',
      attemptId: 'attempt-1',
      access: 'workspace-read'
    })
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      LONG
    ])
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual([
      '--effort',
      'high'
    ])
  })

  it('has a 1M window, a distinct label and a price', () => {
    expect(workflowModelContextTokens('claude', LONG)).toBe(1_000_000)
    expect(workflowModelContextTokens('claude', 'claude-opus-5')).toBe(200_000)
    expect(workflowModelContextTokens('claude', 'claude-sonnet-5')).toBe(200_000)
    expect(workflowModelContextTokens('gemini', 'gemini-3.8-flash')).toBe(1_000_000)
    expect(workflowModelContextTokens('codex', 'gpt-5.6-sol')).toBe(200_000)
    // The measured ~513k-token package fits the 1M seat's Quick Discover budget.
    expect(quickDiscoverBudget('claude', LONG).budgetTokens).toBe(600_000)
    expect(localWorkflowModelLabel('claude', LONG)).toBe('Claude Opus 5.5 (1M context)')
    expect(localWorkflowModelLabel('claude', 'claude-opus-5')).toBe('Claude Opus 5')
    // Priced from the Opus 5.5 row ($4 in / $20 out / $0.20 cache read), not Opus 5.
    expect(estimateCostUsd(LONG, 1_000_000, 0, 0, 0)).toBeCloseTo(4)
    expect(estimateCostUsd(LONG, 0, 1_000_000, 0, 0)).toBeCloseTo(20)
    expect(estimateCostUsd(LONG, 0, 0, 1_000_000, 0)).toBeCloseTo(0.2)
    expect(estimateCostUsd('claude-opus-5', 1_000_000, 0, 0, 0)).toBeCloseTo(5)
  })
})
