import { isOllamaModelTag } from '../../../shared/local-ollama-launch'
import { openrouterApiId } from '../../../shared/openrouter-route'
import {
  getAgentSessionOptionCatalog,
  type CatalogOption
} from '../../../shared/agent-session-option-catalog'
import { CLAUDE_ULTRACODE_EFFORT } from '../../../shared/claude-ultracode-effort'
import { modelLineage } from '../../../shared/model-lineage'
import type {
  LocalWorkflowRoute,
  LocalWorkflowSeatCatalog
} from '../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import { WORKFLOW_LONG_CONTEXT_OPUS } from '../../../shared/workflow-model-context-window'
import { WORKFLOW_CLI_MINIMUM_VERSIONS } from '../../../shared/workflow-cli-version'

export const WORKFLOW_ROUTES: readonly LocalWorkflowRoute[] = [
  'claude',
  'codex',
  'grok',
  'gemini',
  'openrouter',
  'ollama'
]

type WorkflowRouteModel = {
  /** The session catalog's model id (the CLI alias shown in pickers). */
  id: string
  /** The exact id the provider reports for the run; frozen into the seat. */
  resolved: string
  isDefault?: true
  /** The session catalog model whose label base and effort options this entry reuses. */
  base?: string
  /** Restrict inherited effort choices when the workflow's model has a narrower native set. */
  effortValues?: readonly string[]
  label?: string
  description?: string
  /** Oldest CLI that supports this model, where that is newer than the route's workflow minimum. */
  minimumCliVersion?: string
  /** No longer offered; seats frozen with it before a pin moved still run on it. */
  retired?: true
}

/**
 * Models each route exposes to workflows, with the resolved ids measured on 2026-09-21. Claude
 * Fable is left out: the account answered "out of usage credits" instead of a resolved model.
 */
export const WORKFLOW_ROUTE_MODELS: Record<LocalWorkflowRoute, readonly WorkflowRouteModel[]> = {
  openrouter: [],
  // Whatever is installed on this computer (workflow-ollama-catalog.ts).
  ollama: [],
  claude: [
    // Measured 2026-10-12 (CLI 2.1.292): the `opus` and `sonnet` aliases report these exact keys.
    { id: 'opus', resolved: 'claude-opus-5-5', isDefault: true },
    { id: 'sonnet', resolved: 'claude-sonnet-5-5' },
    // Measured 2026-10-12 (CLI 2.1.292): the `haiku` alias still reports this exact key.
    { id: 'haiku', resolved: 'claude-haiku-4-5-20251001' },
    // Measured 2026-09-27 (CLI 2.1.283): modelUsage reports this exact key, contextWindow 1M.
    {
      id: WORKFLOW_LONG_CONTEXT_OPUS,
      resolved: WORKFLOW_LONG_CONTEXT_OPUS,
      base: 'opus',
      label: 'Opus 5.5 (1M context)',
      description: 'Opus 5.5 with 1M context, for reading a large codebase in one call'
    },
    // The Cheap tier's Claude. Claude Code documents 2.1.293 as its floor. The session catalog's
    // Haiku has no effort option, so it borrows Claude's, limited to the efforts measured on
    // 2026-10-10 (Intelligence-10x bench and scale probe) plus low.
    {
      id: 'claude-haiku-5-5',
      resolved: 'claude-haiku-5-5',
      base: 'sonnet',
      effortValues: ['low', 'medium', 'high'],
      label: 'Haiku 5.5',
      description: 'Needs Claude Code 2.1.293 or later on the host',
      minimumCliVersion: '2.1.293'
    },
    // Pinned until 2026-10-12, when the aliases already ran Opus 5.5 and Sonnet 5.5.
    { id: 'claude-opus-5', resolved: 'claude-opus-5', retired: true },
    { id: 'claude-sonnet-5', resolved: 'claude-sonnet-5', retired: true }
  ],
  codex: [
    { id: 'gpt-5.6-sol', resolved: 'gpt-5.6-sol', isDefault: true },
    {
      id: 'gpt-6-luna',
      resolved: 'gpt-6-luna',
      base: 'gpt-5.6-luna',
      effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
      label: 'GPT-6 Luna',
      description: 'GPT-6 Luna using the selected Codex account'
    },
    { id: 'gpt-6-astra', resolved: 'gpt-6-astra' },
    { id: 'gpt-5.6-terra', resolved: 'gpt-5.6-terra' }
  ],
  grok: [{ id: 'grok-4.6', resolved: 'grok-4.6-build', isDefault: true }],
  gemini: [
    { id: 'gemini-3.8-flash', resolved: 'gemini-3.8-flash', isDefault: true },
    { id: 'gemini-4-argon', resolved: 'gemini-4-argon', label: 'Gemini 4 Argon' }
  ]
}

export function workflowModelAvailable(route: LocalWorkflowRoute, model: string): boolean {
  if (route === 'openrouter') {
    return openrouterApiId.safeParse(model).success
  }
  if (route === 'ollama') {
    return isOllamaModelTag(model)
  }
  return WORKFLOW_ROUTE_MODELS[route].some((entry) => entry.resolved === model)
}

/** The oldest CLI that may run a frozen seat's model: the model's own floor, else the route's. */
export function workflowModelMinimumCliVersion(
  route: keyof typeof WORKFLOW_CLI_MINIMUM_VERSIONS,
  model?: string
): string {
  const entry = WORKFLOW_ROUTE_MODELS[route].find((candidate) => candidate.resolved === model)
  return entry?.minimumCliVersion ?? WORKFLOW_CLI_MINIMUM_VERSIONS[route]
}

/**
 * The `--model` value for a frozen seat model. Claude takes the exact id (the legacy argv already
 * did); Grok's resolved build id is not a CLI model name, so it gets its alias.
 */
export function workflowCliModel(route: LocalWorkflowRoute, model: string): string {
  if (route === 'openrouter') {
    return openrouterApiId.parse(model)
  }
  if (route === 'ollama') {
    return model
  }
  const entry = WORKFLOW_ROUTE_MODELS[route].find((candidate) => candidate.resolved === model)
  if (!entry) {
    throw new Error(
      `${localWorkflowProviderLabel(route)} model ${model} is not offered for workflows.`
    )
  }
  return route === 'claude' ? entry.resolved : entry.id
}

const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

// Gemini's session catalog has no effort option; workflows map it onto the thinking level.
const GEMINI_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: { type: 'select', choices: EFFORT_CHOICES, defaultValue: 'medium' },
  apply: {}
}

function workflowEffortOption(
  route: LocalWorkflowRoute,
  options: readonly CatalogOption[],
  effortValues?: readonly string[]
): CatalogOption[] {
  if (route === 'gemini') {
    return [GEMINI_EFFORT]
  }
  // Setup crosses Electron IPC, so the option handlers (functions) are dropped. Workflows default
  // to high effort where the model offers it (Codex's session default is medium). Ultracode is
  // an interactive mode (dynamic workflows), not an effort a headless seat can use.
  return options.flatMap((option) => {
    if (option.id !== 'effort' || option.kind.type !== 'select') {
      return []
    }
    const choices = option.kind.choices.filter(
      (choice) =>
        choice.value !== CLAUDE_ULTRACODE_EFFORT &&
        (!effortValues || effortValues.includes(choice.value))
    )
    const defaultValue = choices.some((choice) => choice.value === 'high')
      ? 'high'
      : option.kind.defaultValue
    return [{ ...option, apply: {}, kind: { ...option.kind, choices, defaultValue } }]
  })
}

export function workflowCatalogModels(
  route: LocalWorkflowRoute
): LocalWorkflowSeatCatalog['models'] {
  if (route === 'openrouter' || route === 'ollama') {
    return []
  }
  const options = getAgentSessionOptionCatalog(route)
  return WORKFLOW_ROUTE_MODELS[route]
    .filter((entry) => !entry.retired)
    .map((entry) => {
      const model = options?.models.find((candidate) => candidate.id === (entry.base ?? entry.id))
      const description = entry.description ?? model?.description
      return {
        catalog: {
          id: entry.id,
          label: entry.label ?? model?.label ?? entry.id,
          ...(description ? { description } : {}),
          isDefault: entry.isDefault === true,
          options: workflowEffortOption(route, model?.options ?? [], entry.effortValues)
        },
        resolvedModelId: entry.resolved,
        lineage: modelLineage(route, entry.resolved)
      }
    })
}
