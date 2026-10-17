/**
 * `omni session launch --project` creates the launch worktree, then starts the agent in a separate
 * call, so the agent always starts beside that worktree's setup. A repository whose setup must
 * finish first (`setupAgentStartupPolicy: wait-for-setup`) is refused before any effect.
 */

import type { LaunchCandidate } from '../shared/agent-launch-placement-types'
import type { OrcaHooks } from '../shared/omni-yaml-hook-types'
import type { CapacityProvider } from '../shared/provider-account-capacity'
import type { Repo } from '../shared/repo-types'
import { shouldWaitForSetupBeforeAgentStartup } from '../shared/setup-agent-startup-policy'
import { placedLaunchRoute } from './launch-placement-refusals'
import type { RuntimeClient } from './runtime-client'
import { resolveOrchestrationCliExecutable } from './runtime/orchestration-recovery-command'
import { launchEnvironmentArgs, launchRefusal } from './session-launch-refusals'
import { quoteCliCommandArgument } from './shell-command-quote'

const SETUP_POLICY_TIMEOUT_MS = 10_000

/** `repo.hooks`: the setup script the create will run (omni.yaml and Settings combined). */
type RepoHooksRead = { hooks: OrcaHooks | null }
/** `repo.hooksCheck`: the repository's own omni.yaml, which carries its startup policy. */
type RepoHooksCheckRead = { status?: 'ok' | 'error'; hooks: OrcaHooks | null }
type RepoShowRead = { repo: Pick<Repo, 'hookSettings'> }

async function setupMustFinishFirst(
  client: Pick<RuntimeClient, 'call'>,
  repo: string
): Promise<boolean> {
  const read = async <T>(method: string): Promise<T> =>
    (await client.call<T>(method, { repo }, { timeoutMs: SETUP_POLICY_TIMEOUT_MS })).result
  const [effective, yaml, shown] = await Promise.all([
    read<RepoHooksRead>('repo.hooks'),
    read<RepoHooksCheckRead>('repo.hooksCheck'),
    read<RepoShowRead>('repo.show')
  ])
  if (yaml.status === 'error') {
    throw new Error('omni.yaml could not be read')
  }
  return (
    Boolean(effective.hooks?.scripts?.setup?.trim()) &&
    shouldWaitForSetupBeforeAgentStartup(
      shown.repo.hookSettings?.setupAgentStartupPolicy,
      yaml.hooks?.setupAgentStartupPolicy,
      effective.hooks?.setupAgentStartupPolicy
    )
  )
}

/** Read-only, on the chosen computer, before the placement is frozen or anything is sent. */
export async function assertPlacementSetupOrder(args: {
  client: Pick<RuntimeClient, 'call'>
  chosen: LaunchCandidate
  provider: CapacityProvider
  worktreeName: string
}): Promise<void> {
  const { chosen } = args
  const setup = chosen.setup
  if (setup?.kind !== 'git' || !setup.repoId) {
    return
  }
  const repo = `id:${setup.repoId}`
  let waits: boolean
  try {
    waits = await setupMustFinishFirst(args.client, repo)
  } catch {
    throw launchRefusal(
      'launch_host_unverifiable',
      `Cannot read the setup policy of ${setup.projectId} on ${chosen.label} within ${SETUP_POLICY_TIMEOUT_MS / 1000} s, so whether its agent must wait for setup is unverifiable. Nothing was sent.`,
      {
        outcome: 'not-sent',
        nextSteps: [
          `Check that OmniConsole is running on ${chosen.label}, then run the same command again.`
        ]
      }
    )
  }
  if (!waits) {
    return
  }
  const command = [
    resolveOrchestrationCliExecutable(),
    'worktree',
    'create',
    '--repo',
    repo,
    '--name',
    args.worktreeName,
    '--no-parent',
    '--setup',
    'run',
    '--agent',
    args.provider,
    '--prompt',
    '<task brief>',
    '--json',
    ...launchEnvironmentArgs(placedLaunchRoute(chosen.route))
  ]
    .map(quoteCliCommandArgument)
    .join(' ')
  throw launchRefusal(
    'launch_setup_first',
    `${setup.projectId} on ${chosen.label} must finish setup before its agent starts (setupAgentStartupPolicy: wait-for-setup), and --project starts the agent beside setup. Nothing was sent.`,
    {
      outcome: 'not-sent',
      nextSteps: [
        `Create the worktree with its agent there instead; that sequences setup but does not verify account capacity: ${command}`
      ]
    }
  )
}
