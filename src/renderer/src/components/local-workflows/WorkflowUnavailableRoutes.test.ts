import { describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowSeatCatalog } from '../../../../shared/local-workflow-seats'
import { workflowUnavailableRoutes } from './WorkflowUnavailableRoutes'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string) => english
}))

const entry = (
  agent: LocalWorkflowSeatCatalog['agent'],
  extra: Partial<LocalWorkflowSeatCatalog> = {}
): LocalWorkflowSeatCatalog =>
  ({ agent, accountId: `system:${agent}`, label: agent, models: [], ...extra }) as never

describe('why a model family is missing from a workflow', () => {
  it('names each family the host rejected, with its own reason', () => {
    // Why: a Gemini CLI older than the workflow minimum made Gemini vanish from every picker.
    const catalog = [
      entry('claude'),
      entry('codex'),
      entry('grok', { streamUnavailableReason: "Grok's sandbox cannot start on this computer." }),
      entry('gemini', { unavailableReason: 'Gemini CLI 0.57.0 is older than 0.59.0.' })
    ]
    const team = [
      { id: 'claude', agent: 'claude' as const, accountId: 'system:claude' },
      { id: 'codex', agent: 'codex' as const, accountId: 'system:codex' }
    ]
    expect(workflowUnavailableRoutes(catalog, team)).toEqual([
      { label: 'Grok', reason: "Grok's sandbox cannot start on this computer." },
      { label: 'Gemini', reason: 'Gemini CLI 0.57.0 is older than 0.59.0.' },
      { label: 'OpenRouter', reason: 'Not set up on this computer.' },
      { label: 'Ollama', reason: 'Not set up on this computer.' }
    ])
  })

  it('lists every family when the host answered with none set up', () => {
    // An answered, empty catalog is not "everything available": each family says so.
    expect(workflowUnavailableRoutes([], []).map((entry) => entry.label)).toEqual([
      'Claude',
      'Codex',
      'Grok',
      'Gemini',
      'OpenRouter',
      'Ollama'
    ])
  })

  it('says a family is not set up when the host listed nothing for it', () => {
    const team = [{ id: 'claude', agent: 'claude' as const, accountId: 'system:claude' }]
    expect(workflowUnavailableRoutes([entry('claude')], team)).toContainEqual({
      label: 'Codex',
      reason: 'Not set up on this computer.'
    })
  })
})
