/**
 * Starts the cleanup reservation on the real app: the automation service's run results, S1's
 * unattended pane registry and resolver, and the socket's process-tree binding. `admitCleanupRun`
 * is the one entry point for the detector (WP-S2) and Clean up now.
 */

import { join } from 'node:path'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot'
import type { ProviderAccountCapacitySnapshot } from '../../shared/provider-account-capacity'
import type {
  CleanupAdmission,
  CleanupRunSource,
  CleanupRunsView
} from '../../shared/session-cleanup-run'
import type { AutomationService } from '../automations/service'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { setUnattendedCallerBinding } from '../runtime/rpc/unattended-caller-gate'
import { runtimePaneVerifier } from '../session-manage/session-manage-runtime-actions'
import {
  registerUnattendedPane,
  setUnattendedPaneResolver
} from '../session-manage/session-manage-unattended'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { cleanupAgentFor } from './cleanup-automation'
import {
  bindCallerToCleanupRun,
  type ProcessParentRow,
  type VerifiedCallerPane
} from './cleanup-run-caller-binding'
import { CleanupRunController } from './cleanup-runs'

const END_RETRY_MS = 60_000
const NEW_WORKSPACE_SETTLE_MS = 3_000
const NOT_STARTED = 'Cleanup runs have not started on this computer yet, so nothing was started.'

let controller: CleanupRunController | null = null

export type StartSessionCleanupRunsInput = {
  runtime: OrcaRuntimeService
  automations: AutomationService
  store: Store
  readCapacity: () => ProviderAccountCapacitySnapshot | null | undefined
  userDataPath: string
  headless: boolean
}

function readProcessRows(): Promise<readonly ProcessParentRow[]> {
  return process.platform === 'win32'
    ? readWindowsProcessTableFresh()
    : getFreshProcessTableSnapshot()
}

function verifiedCallerPane(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | undefined
): VerifiedCallerPane | null {
  const paneKey = evidence ? runtimePaneVerifier(runtime)(evidence) : null
  if (!paneKey) {
    return null
  }
  const handle = evidence?.terminalHandle
  const worktreeId = handle
    ? (runtime.getOrchestrationDispatchAuthority(handle)?.worktreeId ?? null)
    : null
  return { paneKey, worktreeId }
}

export function startSessionCleanupRuns(input: StartSessionCleanupRunsInput): () => void {
  const { runtime, store } = input
  const next = new CleanupRunController({
    statePath: join(input.userDataPath, 'session-steward', 'cleanup.json'),
    workspacePath: join(input.userDataPath, 'session-steward', 'workspace'),
    headless: input.headless,
    now: () => Date.now(),
    listAutomations: () => store.listAutomations(),
    listRuns: (automationId) => store.listAutomationRuns(automationId),
    defaultAgent: () => cleanupAgentFor(store.getSettings().defaultTuiAgent),
    addFolderRepo: (path, displayName) => runtime.addRepo(path, 'folder', undefined, displayName),
    createAutomation: (automation) => runtime.createAutomation(automation),
    settleNewWorkspace: () =>
      new Promise((resolve) => setTimeout(resolve, NEW_WORKSPACE_SETTLE_MS)),
    runNow: (automationId, options) => runtime.runAutomationNow(automationId, undefined, options),
    failRun: (runId, error) =>
      input.automations.markDispatchResult({ runId, status: 'dispatch_failed', error }),
    relay: (request) => runtime.requestSessionFolders(request),
    readCapacity: input.readCapacity,
    registerPane: registerUnattendedPane
  })
  controller = next
  const stops = [
    input.automations.observeRuns((run) => next.observe(run)),
    setUnattendedPaneResolver((paneKey) => next.resolvePane(paneKey)),
    setUnattendedCallerBinding((caller) =>
      bindCallerToCleanupRun(
        {
          liveAutomaticRun: () => next.liveAutomaticRun(),
          lingeringAutomaticRuns: () => next.lingeringAutomaticRuns(),
          ptyRootPids: (ptyIds) => runtime.localPtyRootProcessIds(ptyIds),
          readProcessRows,
          verifyPane: () => verifiedCallerPane(runtime, caller.evidence)
        },
        caller.callerPid
      )
    )
  ]
  next.start()
  const timer = setInterval(() => next.retryEnds(), END_RETRY_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    for (const stop of stops.toReversed()) {
      stop()
    }
    next.dispose()
    if (controller === next) {
      controller = null
    }
  }
}

/**
 * The detector's (WP-S2) and Clean up now's one way in. Synchronous: the reservation is on disk
 * before this returns; the run itself starts in the background.
 */
export function admitCleanupRun(
  source: CleanupRunSource,
  input?: { leftovers?: readonly string[] }
): CleanupAdmission {
  return (
    controller?.admit(source, input?.leftovers) ?? {
      ok: false,
      reason: 'disabled',
      detail: NOT_STARTED
    }
  )
}

export function cleanupRunsView(): CleanupRunsView | null {
  return controller?.view() ?? null
}
