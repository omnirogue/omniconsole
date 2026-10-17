import type Database from '../../sqlite/sync-database'
import {
  createLocalWorkflowDraft,
  type LocalWorkflowDraft,
  type LocalWorkflowPreset,
  type LocalWorkflowScopeOption
} from '../../../shared/local-workflow-draft'
import type { LocalWorkflowSetupResult } from '../../../shared/local-workflow-rpc'
import {
  localWorkflowDraftStreams,
  localWorkflowRouteNamesModel,
  streamedLocalWorkflowCatalog,
  type LocalWorkflowSeatCatalog,
  type LocalWorkflowSeatChoice
} from '../../../shared/local-workflow-seats'
import { chooseWorkflowRouteAccount } from '../../../shared/local-workflow-seat-capacity'
import { mayIssueVerdict } from '../../../shared/model-lineage'

/** Setup offers every route once, in this order: Karpathy's default council. */
const ROUTE_ORDER = ['claude', 'codex', 'grok', 'gemini'] as const
export const LOCAL_WORKFLOW_ROUTES_UNAVAILABLE =
  'Set up at least two of Claude, Codex, Grok or Gemini to run a workflow.'

function defaultLineage(entry: LocalWorkflowSeatCatalog): string | undefined {
  return (entry.models.find((model) => model.catalog.isDefault) ?? entry.models[0])?.lineage
}

/**
 * Defaults for a new draft: per route, the eligible account with the most fresh, verified
 * capacity, or the first one not known to be limited when none is verified (seat-1..seat-N), every seat a
 * Council member, Claude (else the first non-Google seat) as chairman or ranker, and up to three
 * non-Gemini finders for Discover.
 */
export function localWorkflowSetupDefaults(
  preset: LocalWorkflowPreset,
  catalog: readonly LocalWorkflowSeatCatalog[],
  slotLimit: number,
  access?: LocalWorkflowDraft['access']
): { defaults: LocalWorkflowDraft; unavailableReason?: string } {
  const defaults = createLocalWorkflowDraft(preset)
  if (access) {
    defaults.access = access
  }
  defaults.concurrency = Math.min(defaults.concurrency, slotLimit)
  const routes = localWorkflowDraftStreams(preset, defaults)
    ? streamedLocalWorkflowCatalog(catalog)
    : catalog
  const eligible = routes.filter((entry) => !entry.unavailableReason && entry.models.length)
  const selected = ROUTE_ORDER.flatMap((agent) => {
    const choice = chooseWorkflowRouteAccount(
      eligible.filter((candidate) => candidate.agent === agent)
    )
    return choice ? [choice.entry] : []
  })
  defaults.seats = selected.map((entry, index) => ({
    id: `seat-${index + 1}`,
    agent: entry.agent,
    accountId: entry.accountId
  }))
  const judges = defaults.seats.filter((_, index) => defaultLineage(selected[index]) !== 'google')
  defaults.synthesizerId =
    (defaults.seats.find((seat) => seat.agent === 'claude') ?? judges[0] ?? defaults.seats[0])
      ?.id ?? 'seat-1'
  if (preset === 'council') {
    defaults.council = { memberIds: defaults.seats.map((seat) => seat.id) }
  } else {
    defaults.discover.finderIds = defaults.seats
      .filter((seat) => seat.agent !== 'gemini')
      .slice(0, 3)
      .map((seat) => seat.id)
  }
  return {
    defaults,
    ...(selected.length < 2 || !judges.length
      ? { unavailableReason: LOCAL_WORKFLOW_ROUTES_UNAVAILABLE }
      : {})
  }
}

/** Fresh defaults plus the conversation's latest execution, which the tab restores. */
/**
 * Workflow graphs: one seat per available family, on the same capacity-chosen accounts, then each
 * model-named route (OpenRouter, Ollama) once. At most one seat per route, so the team always fits
 * the start schema's limit (one per route), however many accounts a route has.
 */
export function localWorkflowGraphTeam(
  catalog: readonly LocalWorkflowSeatCatalog[],
  slotLimit: number
): LocalWorkflowSeatChoice[] {
  const seats: LocalWorkflowSeatChoice[] = localWorkflowSetupDefaults('council', catalog, slotLimit)
    .defaults.seats.map((seat) => ({ ...seat, id: seat.agent }))
    .concat(
      catalog
        .filter(
          (entry) =>
            localWorkflowRouteNamesModel(entry.agent) &&
            !entry.unavailableReason &&
            entry.models.length
        )
        .map((entry) => ({ id: entry.agent, agent: entry.agent, accountId: entry.accountId }))
    )
  return seats.filter((seat, index) => seats.findIndex((other) => other.id === seat.id) === index)
}

export function localWorkflowSetupResult(input: {
  db: Database.Database
  conversationKey: string
  preset: LocalWorkflowPreset
  catalog: LocalWorkflowSeatCatalog[]
  scopeOptions: LocalWorkflowScopeOption[]
  scopeLabel: string
  slotLimit: number
}): LocalWorkflowSetupResult {
  const auditCatalog = input.catalog.map((entry) => ({
    ...entry,
    models: entry.models.filter(
      (model) => model.lineage !== 'unknown' && model.resolvedModelId.trim()
    )
  }))
  const { defaults, unavailableReason } = localWorkflowSetupDefaults(
    input.preset,
    input.catalog,
    input.slotLimit
  )
  const previous = input.db
    .prepare(
      'SELECT id FROM local_workflow_executions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1'
    )
    .get(input.conversationKey) as { id: string } | undefined
  return {
    catalog: input.catalog,
    auditTeam: localWorkflowSetupDefaults('discover', auditCatalog, input.slotLimit, 'frozen')
      .defaults.seats.map((seat) => ({ ...seat, id: seat.agent }))
      .concat(
        auditCatalog
          .filter(
            (entry) =>
              localWorkflowRouteNamesModel(entry.agent) &&
              !entry.unavailableReason &&
              entry.models.length
          )
          .map((entry) => ({ id: entry.agent, agent: entry.agent, accountId: entry.accountId }))
      ),
    auditSupport: {
      version: 1,
      ...(auditCatalog.some(
        (entry) =>
          !entry.unavailableReason &&
          entry.models.some(
            (model) =>
              model.lineage !== 'unknown' && mayIssueVerdict(entry.agent, model.resolvedModelId)
          )
      )
        ? {}
        : { unavailableReason: 'Set up a model that can review evidence to run Audit.' })
    },
    defaults,
    scopeOptions: input.scopeOptions,
    scopeLabel: input.scopeLabel,
    maxConcurrency: input.slotLimit,
    graphTeam: localWorkflowGraphTeam(input.catalog, input.slotLimit),
    ...(previous ? { executionId: previous.id } : {}),
    ...(unavailableReason &&
    !input.catalog.some(
      (entry) =>
        localWorkflowRouteNamesModel(entry.agent) &&
        !entry.unavailableReason &&
        entry.models.some((model) => model.lineage !== 'unknown')
    )
      ? { unavailableReason }
      : {})
  }
}
