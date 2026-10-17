import { toSshExecutionHostId } from '../../shared/execution-host'
import { launchManifestPrompt } from '../../shared/launch-manifest'
import { projectLaunchManifest } from '../../shared/project-launch-inheritance'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import { launchFilingReason } from '../../shared/session-organization-change'
import type { SessionProjectLaunch } from '../../shared/session-project-cli'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import { recordedFolderRelay } from '../session-organization/organization-relayed-mutation'
import {
  projectLaunchRuntime,
  resolveProjectLaunchInMain
} from '../session-projects/project-launch-resolve'
import type { SessionPrepFolderRequest } from '../session-prep/session-prep-folders'
import { moveSessionPrepSession } from '../session-prep/session-prep-folders'

/**
 * A routine in a project (upgrade plan PR 12): each run gets the project's brief, resolved for
 * the computer it runs on, and is filed in the project once its session exists. With no window
 * the project can't be read, so the run starts without it, as a worker does.
 */

export type RoutineProjectDeps = {
  resolveLaunch(args: {
    folder: string
    host: string
    templateId?: string
  }): Promise<SessionProjectLaunch | null>
  /** The recorded folder move, as a `launch` change from source `routine`. */
  filing: SessionPrepFolderRequest
  readAutomation(automationId: string): Automation | null
  warn?(message: string): void
}

function routineHost(automation: Automation): string {
  return automation.executionTargetType === 'ssh'
    ? toSshExecutionHostId(automation.executionTargetId)
    : 'local'
}

/** The brief that leads the run's prompt; null when the routine is in no project or it can't be read. */
export async function routineProjectBrief(
  deps: RoutineProjectDeps,
  automation: Automation
): Promise<string | null> {
  if (!automation.sessionFolder) {
    return null
  }
  try {
    const launch = await deps.resolveLaunch({
      folder: automation.sessionFolder,
      host: routineHost(automation),
      ...(automation.agentTemplateId ? { templateId: automation.agentTemplateId } : {})
    })
    if (!launch || launch.error) {
      return null
    }
    const manifest = projectLaunchManifest(launch, {
      prompt: '',
      hostLabel: launch.host.label,
      agent: false
    })
    return launchManifestPrompt(manifest) || null
  } catch (error) {
    deps.warn?.(`[routines] project brief unavailable: ${String(error)}`)
    return null
  }
}

/** Files each dispatched run's session in its routine's project, once per run. */
export function createRoutineRunFiling(
  deps: RoutineProjectDeps
): (run: AutomationRun) => Promise<void> {
  const filed = new Set<string>()
  return async (run) => {
    if (run.status !== 'dispatched' || filed.has(run.id)) {
      return
    }
    if (!run.terminalPaneKey && !run.terminalSessionId) {
      return
    }
    const folder = deps.readAutomation(run.automationId)?.sessionFolder
    if (!folder) {
      return
    }
    filed.add(run.id)
    try {
      await moveSessionPrepSession(
        deps.filing,
        { tabId: run.terminalSessionId ?? undefined, paneKey: run.terminalPaneKey },
        { id: folder, path: folder }
      )
    } catch (error) {
      // Why best effort: filing never fails a run; the run still reports to its routine.
      deps.warn?.(`[routines] run ${run.id} not filed in its project: ${String(error)}`)
    }
  }
}

/** The deps from this desktop's runtime: the window reads the project and records the filing. */
export function routineProjectDeps(
  runtime: OrcaRuntimeService,
  readAutomation: RoutineProjectDeps['readAutomation']
): RoutineProjectDeps {
  const relay = (request: SessionFolderRelayRequest) => runtime.requestSessionFolders(request)
  return {
    resolveLaunch: (args) => resolveProjectLaunchInMain(projectLaunchRuntime(runtime), args),
    // Why lazy: the ledger loads history, and most routines are in no project.
    filing: (request) =>
      recordedFolderRelay(sessionOrganizationLedgerFor(getProfileUserDataPath()), relay, {
        executor: { kind: 'launch', source: 'routine' },
        reason: launchFilingReason()
      })(request),
    readAutomation,
    warn: (message) => console.warn(message)
  }
}
