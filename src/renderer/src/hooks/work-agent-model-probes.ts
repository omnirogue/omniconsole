import { create } from 'zustand'
import { resolveBuildReviewDiscoveryContext } from '@/components/build-review/use-build-review-agent-models'
import {
  discoverRuntimeCommitMessageModels,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import type { RuntimeDiscoverCommitMessageModelsResult } from '@/runtime/runtime-git-client-context'
import type { CatalogModel } from '../../../shared/agent-session-option-catalog'
import { catalogModelsFromDiscovery } from '../../../shared/build-review-model-options'
import { checkAgentLaunchPreferences } from '../../../shared/agent-launch-preference-check'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { MODEL_LISTING_LIFETIME_MS } from '../../../shared/model-listing-lifetime'
import type { TuiAgent } from '../../../shared/tui-agent'

export type WorkAgentModelProbe = { models: CatalogModel[] | null; checkedAt: number }

export const WORK_AGENT_MODEL_DISCOVERY_TIMEOUT_MS = 15_000
/** How long a CLI's model listing stays current (quiet background agent runs, the default). */
export const WORK_AGENT_MODEL_PROBE_TTL_MS = MODEL_LISTING_LIFETIME_MS
/** The earlier lifetime on screen, kept for `quietBackgroundAgentRuns: false`. */
export const LEGACY_WORK_AGENT_MODEL_PROBE_TTL_MS = 120_000
/** The earlier re-list age on the minute tick, kept for `quietBackgroundAgentRuns: false`. */
export const LEGACY_WORK_AGENT_MODEL_PROBE_DUE_MS = 60_000
/**
 * A launcher opening asks the host again for a listing at least this old, and anything lists a
 * failed one again at this age. Why so soon: the host answers from its own record (a good listing
 * while the CLI binary is unchanged, a failed one for five minutes), so only a CLI update or an
 * expired record runs the CLI; the floor only absorbs a hover flicker.
 */
export const WORK_AGENT_MODEL_OPEN_REFRESH_FLOOR_MS = 10_000

export type WorkAgentModelListingPolicy = {
  /** An unforced request lists an agent whose listing is at least this old. */
  dueMs: number
  /** A launcher opening asks again for a listing at least this old. */
  openDueMs: number
  /** A click (`readCurrent`) reads a listing as current for this long. */
  lifetimeMs: number
  /** What a surface shows: quietly, the last good listing until a new one replaces it. */
  displayMs: number
  /**
   * Quiet background agent runs: one listing at a time app-wide, and no answer in time keeps a
   * good listing. False (the kill switch): side by side, a timeout reads as failed, as before.
   */
  quiet: boolean
}

/**
 * Why on screen and on click differ: nothing lists on a timer, so a surface left open would
 * otherwise go blank once its listings expire, while a click still re-checks before a launch.
 */
export function workAgentModelListingPolicy(
  settings: Pick<GlobalSettings, 'quietBackgroundAgentRuns'> | null | undefined
): WorkAgentModelListingPolicy {
  return settings?.quietBackgroundAgentRuns === false
    ? {
        dueMs: LEGACY_WORK_AGENT_MODEL_PROBE_DUE_MS,
        openDueMs: LEGACY_WORK_AGENT_MODEL_PROBE_DUE_MS,
        lifetimeMs: LEGACY_WORK_AGENT_MODEL_PROBE_TTL_MS,
        displayMs: LEGACY_WORK_AGENT_MODEL_PROBE_TTL_MS,
        quiet: false
      }
    : {
        dueMs: WORK_AGENT_MODEL_PROBE_TTL_MS,
        openDueMs: WORK_AGENT_MODEL_OPEN_REFRESH_FLOOR_MS,
        lifetimeMs: WORK_AGENT_MODEL_PROBE_TTL_MS,
        displayMs: Number.POSITIVE_INFINITY,
        quiet: true
      }
}

/** Whether an unforced request lists this agent: never listed, at least `dueMs` old, or failed. */
export function isWorkAgentModelListingDue(
  probe: WorkAgentModelProbe | undefined,
  dueMs: number,
  now: number
): boolean {
  if (!probe) {
    return true
  }
  const lifetime =
    probe.models === null ? Math.min(dueMs, WORK_AGENT_MODEL_OPEN_REFRESH_FLOOR_MS) : dueMs
  return now - probe.checkedAt >= lifetime
}

export const useWorkAgentModelProbes = create<{ probes: Record<string, WorkAgentModelProbe> }>(
  () => ({ probes: {} })
)

type QueuedListing = {
  key: string
  agent: TuiAgent
  runtime: RuntimeGitContext
  /** Someone is waiting on it (a refresh or a launch): it runs ahead of background listings. */
  urgent: boolean
  /** The host runs a listing it holds as failed again rather than answer from its record. */
  force: boolean
  /** See `WorkAgentModelListingPolicy.quiet`. */
  quiet: boolean
  started: boolean
  done: Promise<void>
  finish: () => void
}

const pending = new Map<string, QueuedListing>()
// Why one queue: a burst of listings (seven CLIs at once) is ~5 CPU-s and ~1.6 GB of
// short-lived memory; one at a time keeps it off the person's foreground work.
const queue: QueuedListing[] = []
let draining = false
let generation = 0

function record(key: string, models: CatalogModel[] | null): void {
  useWorkAgentModelProbes.setState((state) => ({
    probes: { ...state.probes, [key]: { models, checkedAt: Date.now() } }
  }))
}

function launchableModels(
  agent: TuiAgent,
  result: RuntimeDiscoverCommitMessageModelsResult | null
): CatalogModel[] | null {
  if (!result?.success || result.catalogOrigin !== 'probe') {
    return null
  }
  return catalogModelsFromDiscovery(agent, result.models)
    .filter((model) =>
      agent === 'omp'
        ? model.openrouterRouting === 'omp-openrouter-routing-v1'
        : checkAgentLaunchPreferences(agent, { model: model.id }).ok
    )
    .map((model) => ({
      ...model,
      options: model.options.flatMap((option) => {
        if (option.id !== 'effort' || option.kind.type !== 'select') {
          return [option]
        }
        const choices = option.kind.choices.filter(
          (choice) =>
            checkAgentLaunchPreferences(agent, { model: model.id, effort: choice.value }).ok
        )
        return choices.length ? [{ ...option, kind: { ...option.kind, choices } }] : []
      })
    }))
}

function runDiscovery(listing: QueuedListing): Promise<void> {
  const { key, agent, runtime } = listing
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WORK_AGENT_MODEL_DISCOVERY_TIMEOUT_MS)
  })
  const discovery = listing.force
    ? discoverRuntimeCommitMessageModels(runtime, agent, { force: true })
    : discoverRuntimeCommitMessageModels(runtime, agent)
  return Promise.race([discovery, timeout])
    .then((result) => {
      // Why: no answer in time is not a new listing; a good one already on record stays (and
      // stays due) until the host's answer lands.
      const shown = useWorkAgentModelProbes.getState().probes[key]?.models
      if (result === null && listing.quiet && shown) {
        return
      }
      record(key, launchableModels(agent, result))
    })
    .catch(() => record(key, null))
    .finally(() => clearTimeout(timer))
}

function schedule(listing: QueuedListing): void {
  const ahead = listing.urgent ? queue.findIndex((queued) => !queued.urgent) : -1
  queue.splice(ahead === -1 ? queue.length : ahead, 0, listing)
  void drain()
}

async function drain(): Promise<void> {
  if (draining) {
    return
  }
  draining = true
  const run = generation
  for (let next = queue.shift(); next; next = queue.shift()) {
    next.started = true
    await runDiscovery(next)
    next.finish()
    if (run !== generation) {
      return
    }
  }
  draining = false
}

/**
 * Resolves when the listing lands or one discovery timeout from now, whichever is first.
 * A queued listing may outlast the click; retain a good cache until the host answers.
 */
function answeredWithinTimeout(listing: QueuedListing): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      if (!useWorkAgentModelProbes.getState().probes[listing.key]) {
        record(listing.key, null)
      }
      resolve()
    }, WORK_AGENT_MODEL_DISCOVERY_TIMEOUT_MS)
  })
  return Promise.race([listing.done, timedOut]).finally(() => clearTimeout(deadline))
}

export type WorkAgentModelProbeRequest = {
  /** Unforced, an agent is listed once its listing is at least this old (or failed). */
  dueMs: number
  /** False behind the kill switch (see `WorkAgentModelListingPolicy.quiet`). */
  quiet?: boolean
  /**
   * An explicit refresh (a launch): ignore the age, run ahead of background listings, and have
   * the host run a listing it holds as failed again.
   */
  force?: boolean
  /** Prioritize a launch listing; the wait is bounded by the discovery timeout. */
  awaitListing?: boolean
}

/**
 * Lists one agent's models on its execution host, one listing at a time app-wide (side by side
 * behind the kill switch). Unforced, it lists only an agent that is due (never listed, at least
 * `dueMs` old, or failed); a listing already queued or running for the key is shared rather than
 * started again.
 */
export function probeWorkAgentModels(
  key: string,
  agent: TuiAgent,
  worktreeId: string | null,
  request: WorkAgentModelProbeRequest
): Promise<void> {
  const active = pending.get(key)
  if (active) {
    if ((request.force || request.awaitListing) && !active.started) {
      active.force ||= Boolean(request.force)
      if (!active.urgent) {
        // Why: a launch must not wait behind every background listing queued before it.
        queue.splice(queue.indexOf(active), 1)
        active.urgent = true
        schedule(active)
      }
    }
    return answeredWithinTimeout(active)
  }
  const previous = useWorkAgentModelProbes.getState().probes[key]
  if (!request.force && !isWorkAgentModelListingDue(previous, request.dueMs, Date.now())) {
    return Promise.resolve()
  }
  const context = resolveBuildReviewDiscoveryContext(worktreeId ?? '')
  if (!context) {
    record(key, null)
    return Promise.resolve()
  }
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const listing: QueuedListing = {
    key,
    agent,
    runtime: context.runtime,
    urgent: Boolean(request.force || request.awaitListing),
    force: Boolean(request.force),
    quiet: request.quiet !== false,
    started: false,
    done,
    finish: () => {
      if (pending.get(key) === listing) {
        pending.delete(key)
      }
      finish()
    }
  }
  pending.set(key, listing)
  if (listing.quiet) {
    schedule(listing)
  } else {
    listing.started = true
    void runDiscovery(listing).then(listing.finish)
  }
  return answeredWithinTimeout(listing)
}

export function resetWorkAgentModelProbesForTests(): void {
  generation += 1
  pending.clear()
  queue.length = 0
  draining = false
  useWorkAgentModelProbes.setState({ probes: {} })
}
