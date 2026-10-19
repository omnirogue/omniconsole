import {
  readDiscoverFocusFinding,
  discoverFocusedPrompt,
  withoutDiscoverFocus
} from './discover-focus-finding'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  LocalWorkflowStartRequest,
  LocalWorkflowStartResult
} from '../../../shared/local-workflow-rpc'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import type { LocalWorkflowHostOptions } from './local-workflow-host-options'
import { readLocalWorkflowExecution } from './local-workflow-projection'
import { prepareGraphWorkflowAdmission } from './local-workflow-graph-admission'
import { workflowEvidenceDigest, type WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowExecutionService } from './workflow-execution-service'
import { materializeWorkflowContext } from './context/context-folder'
import { discardWorkflowContextFolder, workflowContextBase } from './context/context-sweep'
import { getAppEnvironment } from '../../../shared/app-environment'
import { prepareAuditWorkflowAdmission } from './local-workflow-audit-admission'
import {
  WORKFLOW_FLEET_READING_FRESH_MS,
  type WorkflowPlacement
} from '../../../shared/local-workflow-placement'
import type Database from '../../sqlite/sync-database'
import {
  readWorkflowEarlierFindings,
  workflowEarlierRunsEnabled,
  type WorkflowEarlierSettledReader
} from './workflow-earlier-findings'
import { workflowEarlierSettledReader } from './workflow-earlier-settled'
import { admitWorkflowBudget } from './local-workflow-budget-admission'

/** Frozen like the output root, so a retargeted workspace is refused rather than read. */
async function freezeWorkspaceRoot(
  path: string
): Promise<NonNullable<LocalWorkflowHostSnapshot['host']['workspaceRoot']>> {
  const root = await realpath(path)
  const info = await lstat(root, { bigint: true })
  if (!info.isDirectory()) {
    throw new Error('The workspace folder is unavailable.')
  }
  return { path: root, device: String(info.dev), inode: String(info.ino) }
}

/** The snapshot with the cross-run known list frozen in; unchanged when there is none. */
function withEarlierFindings(
  db: Database.Database,
  snapshot: LocalWorkflowHostSnapshot,
  skip: boolean,
  settled: WorkflowEarlierSettledReader
): LocalWorkflowHostSnapshot {
  if (skip || !workflowEarlierRunsEnabled()) {
    return snapshot
  }
  try {
    return withEarlierFindingsRead(db, snapshot, settled)
  } catch {
    // Advisory only: an unreadable earlier run never refuses a Start.
    return snapshot
  }
}

function withEarlierFindingsRead(
  db: Database.Database,
  snapshot: LocalWorkflowHostSnapshot,
  settled: WorkflowEarlierSettledReader
): LocalWorkflowHostSnapshot {
  const { audit, host } = snapshot
  if (audit) {
    const earlier = readWorkflowEarlierFindings(db, {
      auditSource: { file: audit.sourceFile, format: audit.format }
    })
    return earlier && audit.noveltyLenses.length
      ? {
          ...snapshot,
          audit: { ...audit, earlierFindings: { runs: earlier.runs, titles: earlier.titles } }
        }
      : snapshot
  }
  const spec = snapshot.graph?.spec
  const earlier = readWorkflowEarlierFindings(
    db,
    {
      ...(spec ? { template: spec.template } : {}),
      workspaceId: host.workspaceId,
      ...(host.context ? { context: host.context.entries } : {}),
      goal: snapshot.task.prompt
    },
    settled
  )
  // A spec override can drop the list step or stop it returning a list.
  return earlier &&
    spec?.steps.some((step) => step.id === earlier.step && step.kind === 'do' && step.list)
    ? {
        ...snapshot,
        host: { ...host, earlierFindings: withoutDiscoverFocus(earlier, host.focusedFinding) }
      }
    : snapshot
}

/**
 * One Start: a repeated request returns its execution; graphs and host-captured audits are admitted.
 * Legacy seat-based and working-agent engines only replay their own runs. A refusal (an obsolete
 * draft, another unfinished run, a ceiling) clears the renderer's pending Start instead of leaving
 * it to retry forever.
 */
/** Templates that run on this computer when the fleet they were left on cannot take them. */
const FLEET_FALLBACK_TEMPLATES: ReadonlySet<string> = new Set(['discover', 'quick-discover'])

export async function admitLocalWorkflow(
  request: LocalWorkflowStartRequest,
  input: {
    options: LocalWorkflowHostOptions
    store: WorkflowCheckpointStore
    service: WorkflowExecutionService
  }
): Promise<LocalWorkflowStartResult> {
  let contextRoot: string | undefined
  let dispatchRoot: WorkflowPlacement | undefined
  try {
    const workspace = await input.options.resolve(request)
    const conversationId = JSON.stringify([workspace.id, request.conversationId])
    const requestDigest = workflowEvidenceDigest(
      JSON.stringify({ preset: request.preset, draft: request.draft })
    )
    const existing = input.store.findStart(conversationId, request.requestId)
    if (existing) {
      const row = readLocalWorkflowExecution(input.options.db, existing)
      const snapshot = input.store.inspect(existing, row.fence)
        .snapshot as LocalWorkflowHostSnapshot
      if (snapshot.host.requestDigest !== requestDigest) {
        throw new Error('Conflicting workflow Start request')
      }
      return { executionId: existing }
    }
    // After the dedupe, so a Start an earlier build admitted still returns its run.
    if (request.draft.capability === 'working-agent') {
      throw new Error('Working-agent Council and Discover no longer start.')
    }
    if (!request.draft.graph && !request.draft.audit) {
      throw new Error(
        'This workflow was set up by an earlier version. Open it again from ＋ → Workflow to start it.'
      )
    }
    // Refuse unavailable fleet hosts before cloning or copying the selected sources.
    const { draft } = request
    const focusedFinding = draft.focusFinding
      ? readDiscoverFocusFinding(
          input.options.db,
          input.store,
          draft.focusFinding,
          workspace.id,
          join(getAppEnvironment().getPath('userData'), 'discover-omnios')
        )
      : undefined
    if (focusedFinding && draft.graph?.spec.template !== 'discover') {
      throw new Error('--focus-finding applies to Discover only.')
    }
    const pick = draft.runsOnHost?.trim()
      ? {
          host: draft.runsOnHost.trim(),
          ...(draft.runsOnHostId?.trim() ? { hostId: draft.runsOnHostId.trim() } : {}),
          ...(draft.forceHost?.trim() ? { forceReason: draft.forceHost.trim() } : {})
        }
      : undefined
    // Sal, 2026-10-14 ("Run it on this Mac instead"): a Discover left on the fleet that the fleet
    // cannot take runs here, its refusal kept as the reason. A named host is still refused.
    const fallsBack =
      !pick &&
      draft.runsOn !== 'local' &&
      FLEET_FALLBACK_TEMPLATES.has(draft.graph?.spec.template ?? '')
    const here = (error: unknown): WorkflowPlacement => {
      if (!fallsBack) {
        throw error
      }
      const reason = error instanceof Error ? error.message : String(error)
      return { runsOn: 'fleet', mode: 'local', fallback: reason.slice(0, 500) }
    }
    const excluded: string[] = []
    const failures: string[] = []
    const place = async (): Promise<WorkflowPlacement | undefined> => {
      const work = excluded.length
        ? input.options.place?.(draft.runsOn, pick, [...excluded])
        : input.options.place?.(draft.runsOn, pick)
      return work?.catch((error) =>
        here(
          new Error([...failures, error instanceof Error ? error.message : String(error)].join(' '))
        )
      )
    }
    let placement = await place()
    const prepared = request.draft.audit
      ? await prepareAuditWorkflowAdmission({
          request,
          workspace,
          requestDigest,
          slotLimit: input.options.slots.limit,
          catalog: input.options.catalog,
          appData: getAppEnvironment().getPath('userData')
        })
      : await prepareGraphWorkflowAdmission({
          request: focusedFinding
            ? {
                ...request,
                draft: { ...draft, prompt: discoverFocusedPrompt(draft.prompt, focusedFinding) }
              }
            : request,
          workspace,
          requestDigest,
          slotLimit: input.options.slots.limit,
          catalog: input.options.catalog,
          freezeScope: input.options.freezeScope,
          freezeWorkspaceRoot,
          materializeContext: async (context) =>
            materializeWorkflowContext({
              ...context,
              base: workflowContextBase(),
              appData: await realpath(getAppEnvironment().getPath('userData'))
            }),
          discardContext: (root) => discardWorkflowContextFolder(root)
        })
    contextRoot = prepared.contextRoot
    // A slow source copy must not make a verified capacity reading stale.
    if (placement?.host && Date.now() - placement.host.readAt >= WORKFLOW_FLEET_READING_FRESH_MS) {
      placement = await place()
    }
    if (prepared.snapshot.audit && placement?.mode === 'dispatched-seats') {
      throw new Error('Audit must execute on the computer that captured its corpus.')
    }
    while (placement?.mode === 'dispatched-seats') {
      try {
        if (!input.options.dispatch) {
          throw new Error('This runtime cannot dispatch workflow seats to another computer.')
        }
        const ready = await input.options.dispatch(placement, prepared.snapshot)
        dispatchRoot = ready
        placement = ready
        break
      } catch (error) {
        if (
          pick ||
          !input.options.place ||
          !placement.host ||
          excluded.includes(placement.host.machine)
        ) {
          placement = here(error)
          break
        }
        failures.push(error instanceof Error ? error.message : String(error))
        excluded.push(placement.host.machine)
        const next = await place()
        // Older embedders may not implement exclusions; never retry one host in a loop.
        placement =
          next?.host && excluded.includes(next.host.machine)
            ? here(new Error(failures.join(' ')))
            : next
      }
    }
    const asked = {
      ...(focusedFinding ? { focusedFinding, focusFinding: draft.focusFinding } : {}),
      ...(draft.requestedBy?.trim() ? { requestedBy: draft.requestedBy.trim() } : {}),
      ...(draft.requestedById ? { requestedById: draft.requestedById } : {}),
      ...(draft.request?.trim() ? { request: draft.request.trim() } : {}),
      // Benchmark reps and --no-earlier-runs: told nothing earlier, and kept out of OmniOS.
      ...(draft.skipEarlierRuns ? { isolated: true as const } : {})
    }
    const snapshot = withEarlierFindings(
      input.options.db,
      {
        ...prepared.snapshot,
        host: { ...prepared.snapshot.host, ...(placement ? { placement } : {}), ...asked }
      },
      !!draft.skipEarlierRuns,
      workflowEarlierSettledReader(
        input.options.db,
        input.store,
        join(getAppEnvironment().getPath('userData'), 'discover-omnios')
      )
    )
    // Dispatched seats run on the host's CLIs, which the dispatch readied; this computer's are unused.
    if (placement?.mode !== 'dispatched-seats') {
      await input.options.preflight?.(snapshot)
    }
    const budget = await admitWorkflowBudget({
      rootId: draft.budgetRootId,
      snapshot,
      authority: input.options.budgetAuthority
    })
    const executionId = input.service.start({
      conversationId,
      requestId: request.requestId,
      owner: input.options.owner,
      fence: 1,
      preset: prepared.preset,
      snapshot: budget ? { ...snapshot, budget } : snapshot,
      attemptLimit: prepared.attemptLimit,
      callLimit: prepared.callLimit,
      budgetLimit: prepared.budgetLimit
    })
    dispatchRoot = undefined
    return { executionId }
  } catch (error) {
    let failure = error
    // A Start refused after its copy was made keeps nothing: no run will ever read it.
    if (dispatchRoot) {
      await input.options.discardDispatch?.(dispatchRoot).catch((cleanup) => {
        failure = new Error(`${String(error)} ${String(cleanup)}`)
      })
    }
    if (contextRoot) {
      await discardWorkflowContextFolder(contextRoot)
    }
    return { rejected: true, reason: failure instanceof Error ? failure.message : String(failure) }
  }
}
