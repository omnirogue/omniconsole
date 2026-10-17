/**
 * `omni host list --capacity --provider <p> [--project <p>] [--model <m>]`: every computer read
 * from this one by the launch candidate reader, shaped into rows by launch-capacity-view.ts.
 * Read-only: it launches, creates and selects nothing.
 */

import type { CapacityProvider } from '../shared/provider-account-capacity'
import { getOptionalStringFlag } from './flags'
import { listSshTargets, type SshTargetSummary } from './host-selector-alternatives'
import {
  readLaunchCandidates,
  resolveLaunchProject,
  type LaunchCandidateQuery,
  type LaunchCandidateReaderDeps
} from './launch-candidate-reader'
import { launchCapacityView, type LaunchCapacityResult } from './launch-capacity-view'
import { defaultLaunchPlacementClients } from './launch-placement-clients'
import { RuntimeClientError } from './runtime-client'

const MAX_MODEL_LENGTH = 512

function refuse(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function capacityFlags(flags: Map<string, string | boolean>): {
  provider: CapacityProvider
  model: string | null
  project: string | null
} {
  if (flags.get('capacity') !== true) {
    throw refuse(
      '--capacity takes no value. Use: omni host list --capacity --provider <claude|codex>.'
    )
  }
  // Why: the view reads every computer from this one, so a selected server would only mislead.
  if (flags.has('environment') || flags.has('pairing-code')) {
    throw refuse(
      '--capacity reads every computer from this one; drop --environment and --pairing-code.'
    )
  }
  const provider = getOptionalStringFlag(flags, 'provider')
  if (provider !== 'claude' && provider !== 'codex') {
    throw refuse(
      '--capacity needs --provider claude or --provider codex (only those have account capacity).'
    )
  }
  const model = getOptionalStringFlag(flags, 'model')?.trim() ?? null
  if (flags.has('model') && (!model || model.length > MAX_MODEL_LENGTH)) {
    throw refuse(`--model needs a model id of at most ${MAX_MODEL_LENGTH} characters.`)
  }
  const project = getOptionalStringFlag(flags, 'project')?.trim() ?? null
  if (flags.has('project') && !project) {
    throw refuse('--project needs a project id or name (omni project list --json).')
  }
  return { provider, model, project }
}

/** The clients placement reaches computers with: this runtime, and one per paired computer. */
function cliReaderDeps(): LaunchCandidateReaderDeps {
  const clients = defaultLaunchPlacementClients()
  const local = clients.local()
  let targets: Promise<SshTargetSummary[]> | null = null
  return {
    now: clients.now,
    local,
    environment: clients.environment,
    environments: clients.environments(),
    // Why memoized: the reader and the rows' launch names read the same list.
    listSshTargets: () => (targets ??= listSshTargets(local))
  }
}

export async function readHostListCapacity(
  flags: Map<string, string | boolean>,
  makeDeps: () => LaunchCandidateReaderDeps = cliReaderDeps
): Promise<LaunchCapacityResult> {
  const typed = capacityFlags(flags)
  const deps = makeDeps()
  const query: LaunchCandidateQuery = {
    provider: typed.provider,
    model: typed.model,
    project: typed.project ? await resolveLaunchProject(typed.project, deps.local) : null,
    readOldRuntimeAccounts: true
  }
  const readings = await readLaunchCandidates(query, deps)
  return launchCapacityView({
    query,
    readings,
    names: {
      environments: [...deps.environments],
      sshTargets: await deps.listSshTargets().catch((): SshTargetSummary[] => [])
    },
    checkedAt: deps.now()
  })
}
