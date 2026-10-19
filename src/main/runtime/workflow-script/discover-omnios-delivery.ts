import { discoverOmniosActionsScript } from '../../../shared/discover-omnios-actions'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { workflowRunResult } from '../../../shared/workflow-run-result'
import { discoverOmniosRun } from '../../../shared/discover-omnios-page'
import { discoverOmniosPage } from '../../../shared/discover-omnios-page-html'
import {
  DISCOVER_OMNIOS_DESK,
  discoverOmniosBrief,
  discoverOmniosDigScript,
  discoverOmniosPublishScript,
  discoverOmniosCloseScript,
  discoverOmniosDecideScript,
  discoverOmniosStartScript
} from '../../../shared/discover-omnios-brief'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  discoverOutbox,
  discoverPublishedUrl,
  readDiscoverLaunchMarker,
  writeDiscoverLaunchMarker,
  type DiscoverDeliveryMarker as Marker
} from './discover-omnios-outbox'
export { discoverOmniosStatus } from './discover-omnios-outbox'

/**
 * Brings each finished Discover run on this computer to OmniOS (Sal, 2026-10-13). When this app
 * sees a Discover or Quick Discover run complete, its page, findings and report are written to
 * <userData>/discover-omnios/<run>, and one Sonnet session starts in the run's workspace with the
 * brief to publish the page, wait for the answer and act on it. Runs that skip earlier runs
 * (benchmark reps, --no-earlier-runs) stay in the app; OMNI_DISCOVER_OMNIOS=0 turns it all off.
 *
 * launch.json keeps one operation id per run. A start refused before anything spawned is tried again
 * under it (twice, after 2 and 10 minutes); the runtime replays any attempt that may have spawned
 * instead of starting another, and an attempt whose outcome is unknown is not retried at all.
 */

const DELIVERED_TEMPLATES = new Set(['discover', 'quick-discover'])
export const DISCOVER_OMNIOS_RETRY_MS: readonly number[] = [120_000, 600_000]
const inFlight = new Set<string>()

export function discoverOmniosEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OMNI_DISCOVER_OMNIOS?.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
}

export type DiscoverOmniosDelivery = {
  db: Database.Database
  /** The settled run's full view, as `omni workflow status` reads it. */
  view: () => Promise<LocalWorkflowView>
  runtime: Pick<OrcaRuntimeService, 'agentLaunchReadiness' | 'createAgentSession'>
  /** <userData>/discover-omnios */
  root: string
  log?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

export type DiscoverOmniosOutcome =
  | { outcome: 'launched'; folder: string; paneKey: string | null }
  | { outcome: 'pending'; folder: string; reason: string }
  | { outcome: 'published'; folder: string; url: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed' | 'unknown'; folder: string; reason: string }

/** The run's frozen snapshot, only when it still matches its digest. */
function frozenSnapshot(
  db: Database.Database,
  executionId: string
): LocalWorkflowHostSnapshot | null {
  const row = db
    .prepare('SELECT snapshot_json,snapshot_digest FROM local_workflow_executions WHERE id=?')
    .get(executionId) as { snapshot_json: string; snapshot_digest: string } | undefined
  if (!row || workflowEvidenceDigest(row.snapshot_json) !== row.snapshot_digest) {
    return null
  }
  const envelope = JSON.parse(row.snapshot_json) as { snapshot?: LocalWorkflowHostSnapshot }
  return envelope.snapshot ?? null
}

/** Why a settled run is not brought to OmniOS, or null when it is. */
function skipReason(
  deps: DiscoverOmniosDelivery,
  snapshot: LocalWorkflowHostSnapshot | null
): string | null {
  if (!discoverOmniosEnabled(deps.env)) {
    return 'OMNI_DISCOVER_OMNIOS is off'
  }
  if (!snapshot) {
    return 'its snapshot cannot be read'
  }
  const template = snapshot.graph?.spec.template
  if (!template || !DELIVERED_TEMPLATES.has(template)) {
    return 'not a Discover run'
  }
  if (snapshot.host.isolated) {
    return 'an isolated run (benchmark or --no-earlier-runs)'
  }
  // A benchmark root's runs never reach the business approval publisher, after a restart too.
  if (snapshot.budget?.benchmark) {
    return 'a benchmark budget root'
  }
  return null
}

/** Writes the page and its files, then starts the session that publishes it and acts on it. */
async function launchDesk(
  deps: DiscoverOmniosDelivery,
  snapshot: LocalWorkflowHostSnapshot,
  executionId: string,
  folder: string,
  operationId: string,
  desk: Marker['desk'],
  chosen: (desk: NonNullable<Marker['desk']>) => Promise<void>
): Promise<string | null> {
  const view = await deps.view()
  if (view.state !== 'completed') {
    throw new Error(`the run is ${view.state}, not completed`)
  }
  const worktree = `id:${snapshot.host.workspaceId}`
  let agent = desk ?? DISCOVER_OMNIOS_DESK.agent
  let readiness = await deps.runtime.agentLaunchReadiness({
    worktree,
    agent,
    preview: true
  })
  if (!desk && readiness.account?.verified === false) {
    agent = 'codex'
    readiness = await deps.runtime.agentLaunchReadiness({ worktree, agent, preview: true })
    if (readiness.account?.verified !== true) {
      throw new Error('Neither Claude nor Codex has a verified account for page delivery.')
    }
  }
  const template = snapshot.graph?.spec.template ?? 'discover'
  const result = workflowRunResult(
    view,
    {
      worktreeId: snapshot.host.workspaceId,
      conversationId: snapshot.host.conversationId,
      executionId
    },
    template,
    0
  )
  const run = {
    ...discoverOmniosRun(result, {
      goal: snapshot.task.prompt.trim(),
      workspace: readiness.workspace.name ?? basename(readiness.workspace.path)
    }),
    executionId,
    workspaceId: snapshot.host.workspaceId,
    ...(snapshot.host.discoverSource ? { source: snapshot.host.discoverSource } : {})
  }
  await writeFile(join(folder, 'page.html'), discoverOmniosPage(run), { mode: 0o600 })
  await writeFile(join(folder, 'findings.json'), `${JSON.stringify(run, null, 2)}\n`, {
    mode: 0o600
  })
  await writeFile(join(folder, 'report.md'), `${result.markdown ?? ''}\n`, { mode: 0o600 })
  await writeFile(join(folder, 'publish.sh'), discoverOmniosPublishScript(run), { mode: 0o700 })
  await writeFile(join(folder, 'actions.sh'), discoverOmniosActionsScript(), { mode: 0o700 })
  await writeFile(join(folder, 'close.sh'), discoverOmniosCloseScript(), { mode: 0o700 })
  await writeFile(join(folder, 'decide.sh'), discoverOmniosDecideScript(run), { mode: 0o700 })
  const workspacePath = readiness.workspace.path
  await writeFile(join(folder, 'start.sh'), discoverOmniosStartScript(run, workspacePath), {
    mode: 0o700
  })
  await writeFile(join(folder, 'dig.sh'), discoverOmniosDigScript(run, workspacePath), {
    mode: 0o700
  })
  await chosen(agent)
  const created = await deps.runtime.createAgentSession(
    {
      clientOperationId: operationId,
      worktree,
      agent,
      prompt: discoverOmniosBrief(run, folder),
      promptDelivery: 'auto-submit',
      presentation: 'background',
      revealInSidebar: true,
      viewMode: 'terminal',
      // A verified account with room on the computer that holds the workspace, or nothing.
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: readiness.workspace.hostId,
        expectedRuntimeId: readiness.runtimeId
      },
      launchPreferences: {
        ...(agent === 'claude' ? { model: DISCOVER_OMNIOS_DESK.model } : {}),
        effort: DISCOVER_OMNIOS_DESK.effort
      }
    },
    { launchCause: { trigger: 'agent-session-create', requestId: operationId } }
  )
  return created.terminal.paneKey ?? null
}

export async function deliverDiscoverToOmnios(
  deps: DiscoverOmniosDelivery,
  executionId: string
): Promise<DiscoverOmniosOutcome> {
  const snapshot = frozenSnapshot(deps.db, executionId)
  const reason = skipReason(deps, snapshot)
  if (reason || !snapshot) {
    if (!snapshot) {
      deps.log?.(`Discover ${executionId}: not brought to OmniOS, its snapshot cannot be read.`)
    }
    return { outcome: 'skipped', reason: reason ?? 'its snapshot cannot be read' }
  }
  if ((await deps.view()).state !== 'completed') {
    return { outcome: 'skipped', reason: 'the run is not completed' }
  }
  const outbox = discoverOutbox(deps.db)
  outbox.enqueue(executionId)
  const folder = join(deps.root, executionId)
  const url = discoverPublishedUrl(deps.root, executionId)
  if (url) {
    outbox.published(executionId, url)
    return { outcome: 'published', folder, url }
  }
  const markerPath = join(folder, 'launch.json')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const marker = outbox.read(executionId) ?? (await readDiscoverLaunchMarker(markerPath))
  if (marker && marker.state !== 'failed' && marker.state !== 'prepared') {
    outbox.write(executionId, marker)
    return marker.state === 'launched'
      ? {
          outcome: 'pending',
          folder,
          reason: 'the publishing session has no published receipt yet'
        }
      : { outcome: 'skipped', reason: `already ${marker.state}` }
  }
  if (inFlight.has(executionId)) {
    return { outcome: 'skipped', reason: 'already launching' }
  }
  inFlight.add(executionId)
  // Kept for every attempt: createAgentSession accepts `<ms>-<32 hex>` and replays a repeat.
  const operationId = marker?.operationId ?? `${Date.now()}-${randomBytes(16).toString('hex')}`
  const attempts = (marker?.attempts ?? 0) + 1
  let desk = marker?.desk ?? (marker?.state === 'failed' ? 'claude' : undefined)
  const save = async (next: Marker) => {
    outbox.write(executionId, next)
    await writeDiscoverLaunchMarker(markerPath, next)
  }
  let hasLaunched = false
  try {
    // Written before anything starts: a crash in between never starts a second session.
    await save({
      state: 'prepared',
      at: new Date().toISOString(),
      operationId,
      ...(desk ? { desk } : {}),
      attempts
    })
    const paneKey = await launchDesk(
      deps,
      snapshot,
      executionId,
      folder,
      operationId,
      desk,
      async (selected) => {
        desk = selected
        await save({
          state: 'launching',
          at: new Date().toISOString(),
          operationId,
          attempts,
          desk
        })
      }
    )
    hasLaunched = true
    await save({
      state: 'launched',
      at: new Date().toISOString(),
      operationId,
      ...(desk ? { desk } : {}),
      attempts,
      paneKey
    })
    deps.log?.(`Discover ${executionId}: a session is bringing its results to OmniOS.`)
    return { outcome: 'launched', folder, paneKey }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A session that may have started is never started again.
    const state =
      hasLaunched ||
      (error as { agentSessionOperationOutcome?: unknown } | null)?.agentSessionOperationOutcome ===
        'unknown'
        ? 'unknown'
        : desk
          ? 'failed'
          : 'prepared'
    await save({
      state,
      at: new Date().toISOString(),
      operationId,
      ...(desk ? { desk } : {}),
      attempts,
      error: message.slice(0, 500)
    }).catch(() => undefined)
    deps.log?.(`Discover ${executionId}: could not bring its results to OmniOS: ${message}`)
    return { outcome: state === 'prepared' ? 'failed' : state, folder, reason: message }
  } finally {
    inFlight.delete(executionId)
  }
}

/** Delivers now and tries a refused start again after each delay, while this app runs. */
export async function scheduleDiscoverToOmnios(
  deps: DiscoverOmniosDelivery,
  executionId: string,
  delays: readonly number[] = DISCOVER_OMNIOS_RETRY_MS
): Promise<DiscoverOmniosOutcome> {
  const outcome = await deliverDiscoverToOmnios(deps, executionId)
  const [delay, ...later] = delays
  if (outcome.outcome === 'failed' && delay !== undefined) {
    discoverOutbox(deps.db).defer(executionId, Date.now() + delay)
    const timer = setTimeout(() => {
      void scheduleDiscoverToOmnios(deps, executionId, later).catch((error) =>
        deps.log?.(String(error))
      )
    }, delay)
    timer.unref?.()
  }
  return outcome
}
