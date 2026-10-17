import {
  createLocalWorkflowDraft,
  type LocalWorkflowDraft,
  type LocalWorkflowPreset
} from '../../../../shared/local-workflow-draft'
import type { ModelLineage } from '../../../../shared/model-lineage'
import type {
  LocalWorkflowRoute,
  LocalWorkflowSeatCatalog
} from '../../../../shared/local-workflow-seats'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'

const ROUTES: { agent: LocalWorkflowRoute; lineage: ModelLineage; models: [string, string][] }[] = [
  {
    agent: 'claude',
    lineage: 'anthropic',
    models: [
      ['opus', 'claude-opus-5'],
      ['sonnet', 'claude-sonnet-5']
    ]
  },
  {
    agent: 'codex',
    lineage: 'openai',
    models: [
      ['gpt-5.6-sol', 'gpt-5.6-sol'],
      ['gpt-5.6', 'gpt-5.6']
    ]
  },
  { agent: 'grok', lineage: 'xai', models: [['grok-4.6', 'grok-4.6-build']] },
  { agent: 'gemini', lineage: 'google', models: [['gemini-3.8-flash', 'gemini-3.8-flash']] }
]

/** One work account per route; the first model of each is the default. */
export const workflowCatalog: LocalWorkflowSeatCatalog[] = ROUTES.map((route) => ({
  agent: route.agent,
  accountId: `${route.agent}-work`,
  accountLabel: 'Work',
  accountHome: `/accounts/${route.agent}`,
  policyRevision: 'fixture-v1',
  models: route.models.map(([id, resolvedModelId], index) => ({
    resolvedModelId,
    lineage: route.lineage,
    catalog: {
      id,
      label: id,
      isDefault: index === 0,
      options: [
        {
          id: 'effort',
          label: 'Effort',
          kind: {
            type: 'select',
            defaultValue: 'low',
            choices: (index === 0 ? ['low', 'high'] : ['low']).map((value) => ({
              value,
              label: value
            }))
          },
          apply: {}
        }
      ]
    }
  }))
}))

/** Council: Claude, Codex and Grok members, Claude chairs. Discover: the same three find. */
export function workflowDraft(preset: LocalWorkflowPreset = 'council'): LocalWorkflowDraft {
  const base = createLocalWorkflowDraft(preset, 'Check the selected scope')
  const seats = workflowCatalog.slice(0, 3).map((entry, index) => ({
    id: `seat-${index + 1}`,
    agent: entry.agent,
    accountId: entry.accountId,
    model: entry.models[0].catalog.id,
    effort: 'high'
  }))
  const memberIds = seats.map((seat) => seat.id)
  return preset === 'council'
    ? { ...base, seats, synthesizerId: 'seat-1', council: { memberIds } }
    : {
        ...base,
        seats,
        synthesizerId: 'seat-1',
        discover: { ...base.discover, finderIds: memberIds }
      }
}

/** The legacy-shaped view older hosts publish; newer fixtures build on it. */
export function workflowView(): LocalWorkflowView {
  return {
    executionId: 'execution-1',
    fence: 2,
    sequence: 5,
    preset: 'council',
    state: 'running',
    connection: 'connected',
    prompt: 'Check the selected scope',
    startedAt: Date.now() - 10_000,
    running: 1,
    queued: 2,
    reused: 1,
    actions: ['pause', 'stop'],
    stages: [
      { id: 'answers', label: 'Answers', completed: 1, total: 3, failed: 0 },
      { id: 'peer', label: 'Peer review', completed: 0, total: 3, failed: 0 },
      { id: 'synthesis', label: 'Synthesis', completed: 0, total: 1, failed: 0 }
    ],
    calls: [
      {
        id: 'answers/seat-1',
        stageId: 'answers',
        seatLabel: 'Claude',
        model: 'large',
        effort: 'high',
        state: 'running',
        attempt: 1,
        attemptLimit: 3,
        transport: 'headless',
        stdout: 'First line\nUnicode café 🧭\nLast line',
        stderr: 'A diagnostic warning',
        outputTruncated: false
      }
    ],
    usage: { hostAttempts: 1, maxHostAttempts: 21, tokens: null }
  }
}
