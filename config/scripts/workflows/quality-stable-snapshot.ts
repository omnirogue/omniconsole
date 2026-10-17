import type { WorkflowProgramSnapshot } from '../../../src/main/runtime/workflow-script/workflow-execution-service'
import type { createLocalWorkflowDraft } from '../../../src/shared/local-workflow-draft'
import type { FrozenCase } from './quality-stable-baseline'

/** The frozen revisions the stable quality batch measures. */
export const STABLE_QUALITY_REVISIONS = {
  council: { councilProgramRevision: 4 },
  discover: { discoverProgramRevision: 5 }
} as const

export function createStableQualitySnapshot(input: {
  frozen: FrozenCase
  preset: 'council' | 'discover'
  defaults: ReturnType<typeof createLocalWorkflowDraft>
  fingerprints: Record<string, string>
  expectedHead: string
}): WorkflowProgramSnapshot {
  const { frozen, preset, defaults, fingerprints, expectedHead } = input
  return {
    version: 1,
    ...STABLE_QUALITY_REVISIONS[preset],
    limits: { concurrency: defaults.concurrency },
    task: { prompt: frozen.prompt, evidence: JSON.stringify(frozen.evidence) },
    seats: [
      {
        id: 'claude',
        agent: 'claude',
        accountId: 'system:claude',
        model: 'claude-sonnet-5',
        effort: 'low',
        lineage: 'anthropic',
        policyRevision: `stable-${fingerprints['src/shared/workflow-claude-command.ts']}`
      },
      {
        id: 'codex',
        agent: 'codex',
        accountId: 'system:codex',
        model: 'gpt-5.6-sol',
        effort: 'low',
        lineage: 'openai',
        policyRevision: `stable-${expectedHead}`
      },
      {
        id: 'grok',
        agent: 'grok',
        accountId: 'system:grok',
        model: 'grok-4.6',
        effort: null,
        lineage: 'xai',
        policyRevision: `stable-${expectedHead}`
      }
    ],
    synthesizerId: 'claude',
    discover: defaults.discover
  }
}
