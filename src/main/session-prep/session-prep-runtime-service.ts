import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import type { Store } from '../persistence'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { createSessionPrepSteps } from './session-prep-default-steps'
import { sessionPrepJevAsk } from './session-prep-jev'
import { sessionPrepPathExists } from './session-prep-path'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { createSessionPrepRuntimeHost } from './session-prep-runtime-host'
import { attachContractVerify } from '../runtime/session-contract-verify'
import {
  projectLaunchRuntime,
  resolveProjectLaunchInMain
} from '../session-projects/project-launch-resolve'
import { createSessionPrepRuntimeReuse } from './session-prep-reuse-runtime'
import { sessionPrepDefaultSource } from './session-prep-default-source'
import { SessionPrepService } from './session-prep-service'
import { SessionPrepStore } from './session-prep-store'
import { createSessionPrepTextRunner } from './session-prep-text-runner'

export { SessionPrepService }

export function createRuntimeSessionPrepService(
  runtime: OrcaRuntimeService,
  store: Store,
  agentEnv: () => CommitMessageAgentEnvironmentResolvers | undefined
): SessionPrepService {
  const directory = join(getAppEnvironment().getPath('userData'), 'session-prep')
  return new SessionPrepService({
    host: {
      ...createSessionPrepRuntimeHost(
        runtime,
        () => store.getSettings().disabledTuiAgents,
        () => store.getSshTargets(),
        sessionOrganizationLedgerFor(getProfileUserDataPath())
      ),
      defaultSourceWorktreeId: () =>
        sessionPrepDefaultSource(runtime.listFolderWorkspaces(), store.getSettings()),
      projectLaunch: (args) => resolveProjectLaunchInMain(projectLaunchRuntime(runtime), args),
      attachVerify: (args) => attachContractVerify(runtime, args)
    },
    store: new SessionPrepStore(directory),
    reuse: createSessionPrepRuntimeReuse(runtime),
    agentTemplates: () => store.getSettings().agentTemplates,
    steps: () =>
      createSessionPrepSteps({
        runText: createSessionPrepTextRunner(store, agentEnv),
        jevAsk: sessionPrepJevAsk,
        pathExists: sessionPrepPathExists
      })
  })
}
