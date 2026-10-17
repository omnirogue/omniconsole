import { describe, expect, it } from 'vitest'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import type { ModelLineage } from '../../../shared/model-lineage'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { withWorkflowStepModels } from '../../../shared/workflow-model-tiers'
import { prepareGraphWorkflowAdmission } from './local-workflow-graph-admission'

const entry = (
  agent: LocalWorkflowSeatCatalog['agent'],
  models: [id: string, lineage: ModelLineage, tools?: boolean, isDefault?: boolean][]
): LocalWorkflowSeatCatalog => ({
  agent,
  accountId: `system:${agent}`,
  accountLabel: agent,
  accountHome: '/home',
  policyRevision: 'v1',
  models: models.map(([id, lineage, tools, isDefault]) => ({
    catalog: { id, label: id, isDefault: isDefault === true, options: [] },
    resolvedModelId: id,
    lineage,
    ...(tools === undefined ? {} : { supportsTools: tools })
  }))
})
const catalog = [
  entry('claude', [['opus', 'anthropic', undefined, true]]),
  entry('openrouter', [['deepseek/deepseek-v4-flash', 'deepseek', true]]),
  entry('ollama', [
    ['qwen3:8b', 'alibaba', true],
    ['llama3.2:1b', 'meta', false],
    ['phi4:latest', 'unknown', true]
  ])
]
const team = catalog.map(({ agent, accountId }) => ({ id: agent, agent, accountId }))

function admit(
  finders: { route: 'claude' | 'openrouter' | 'ollama'; model?: string }[],
  frozen = true
) {
  const draft = createLocalWorkflowDraft('council', 'Find the bugs')
  draft.access = frozen ? 'frozen' : 'workspace-read'
  draft.concurrency = 1
  const base = normalizeWorkflowSpec(
    { steps: [{ id: 'find', kind: 'do', agents: [{ route: 'claude' }], inputs: [] }] },
    ['claude', 'openrouter', 'ollama']
  )
  draft.graph = { spec: withWorkflowStepModels(base, 'find', finders, { claude: 'opus' }), team }
  return prepareGraphWorkflowAdmission({
    request: {
      worktree: 'folder',
      conversationId: 'conversation',
      requestId: 'request',
      preset: 'council',
      draft
    },
    workspace: { id: 'folder', path: '/workspace', label: 'Folder' },
    requestDigest: 'digest',
    slotLimit: 2,
    catalog: async () => catalog,
    freezeScope: async () => ({ evidence: 'frozen evidence', sources: [], coverage: [] }),
    freezeWorkspaceRoot: async () => ({ path: '/workspace', device: '1', inode: '2' })
  })
}

describe('Ollama and combo admission', () => {
  it('seats a combo of a signed-in family, an OpenRouter model and a local one on one step', async () => {
    const admitted = await admit([
      { route: 'claude', model: 'opus' },
      { route: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
      { route: 'ollama', model: 'qwen3:8b' }
    ])
    expect(admitted.snapshot.seats).toMatchObject([
      { id: 'claude', agent: 'claude', model: 'opus', lineage: 'anthropic' },
      {
        id: 'openrouter:deepseek/deepseek-v4-flash',
        agent: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
        lineage: 'deepseek'
      },
      {
        id: 'ollama:qwen3:8b',
        agent: 'ollama',
        accountId: 'system:ollama',
        model: 'qwen3:8b',
        lineage: 'alibaba',
        effort: null
      }
    ])
  })

  it('refuses a model that is not installed, one of no known family, and one without tools for a workspace read', async () => {
    await expect(admit([{ route: 'ollama', model: 'qwen3:30b' }])).rejects.toThrow(
      'Ollama: choose an available model'
    )
    await expect(admit([{ route: 'ollama', model: 'phi4:latest' }])).rejects.toThrow(
      'Choose an Ollama model with a known family'
    )
    await expect(admit([{ route: 'ollama', model: 'llama3.2:1b' }], false)).rejects.toThrow(
      'Ollama model llama3.2:1b does not support tools'
    )
    await expect(admit([{ route: 'ollama', model: 'llama3.2:1b' }])).resolves.toMatchObject({
      snapshot: { seats: [{ agent: 'ollama', model: 'llama3.2:1b' }] }
    })
  })
})
