import { describe, expect, it } from 'vitest'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import { prepareGraphWorkflowAdmission } from './local-workflow-graph-admission'

function admit(tools: boolean, frozen: boolean, model = 'deepseek/chat') {
  const draft = createLocalWorkflowDraft('council', 'Answer briefly')
  draft.access = frozen ? 'frozen' : 'workspace-read'
  draft.concurrency = 1
  draft.graph = {
    spec: normalizeWorkflowSpec({
      steps: [{ id: 'answer', kind: 'do', agents: [{ route: 'openrouter', model }], inputs: [] }]
    }),
    team: [{ id: 'openrouter', agent: 'openrouter', accountId: 'system:openrouter' }]
  }
  const catalog: LocalWorkflowSeatCatalog[] = [
    {
      agent: 'openrouter',
      accountId: 'system:openrouter',
      accountLabel: 'OpenRouter',
      accountHome: '/home',
      policyRevision: 'v1',
      models: [
        {
          catalog: { id: 'deepseek/chat', label: 'DeepSeek', options: [] },
          resolvedModelId: 'deepseek/chat',
          lineage: 'deepseek',
          supportsTools: tools
        }
      ]
    }
  ]
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
describe('OpenRouter admission', () => {
  it('refuses models without tools for workspace access', async () => {
    await expect(admit(false, false)).rejects.toThrow('does not support tools')
    await expect(admit(false, true)).resolves.toMatchObject({
      snapshot: { seats: [{ agent: 'openrouter', model: 'deepseek/chat' }] }
    })
    await expect(admit(true, false)).resolves.toMatchObject({
      snapshot: { access: 'workspace-read' }
    })
  })
  it('requires an explicit available model', async () => {
    await expect(admit(true, true, '')).rejects.toThrow('Choose an OpenRouter model')
    await expect(admit(true, true, 'deepseek/not-in-catalog')).rejects.toThrow('available model')
  })
})
