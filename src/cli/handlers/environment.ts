import type { CommandHandler } from '../dispatch'
import {
  formatEnvironment,
  formatEnvironmentList,
  formatHostList,
  printResult,
  type HostListEntry
} from '../format'
import {
  findEnvironmentByName,
  findSshTargetByName,
  listSshTargets,
  type EnvironmentSummary,
  type SshTargetSummary
} from '../host-selector-alternatives'
import { launchHostFlag } from '../launch-capacity-commands'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { getDefaultUserDataPath, RuntimeClientError } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment,
  type EnvironmentAddResult,
  type EnvironmentRemoveResult
} from '../runtime/environments'

export const ENVIRONMENT_HANDLERS: Record<string, CommandHandler> = {
  'environment add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const pairingCode = getRequiredStringFlag(flags, 'pairing-code')
    const environment = redactRuntimeEnvironment(
      addEnvironmentFromPairingCode(getDefaultUserDataPath(), {
        name,
        pairingCode
      })
    )
    printResult(
      localSuccess({ environment }),
      json,
      (result: EnvironmentAddResult) =>
        `Saved environment ${result.environment.name} (${result.environment.id}).`
    )
  },
  // Why: an agent told "run it on <name>" had nowhere to look. `omni environment list` showed
  // paired servers only, and nothing in the CLI listed SSH targets at all, so the wrong-axis
  // guess was the only move available. This is the one place that answers both.
  'host list': async (context) => {
    // Why `client` stays unread here: --capacity reaches every computer itself, never through it.
    const { flags, json } = context
    if (flags.has('capacity')) {
      // Why lazy: the capacity read contacts every computer; plain `host list` stays a local read.
      const [{ readHostListCapacity }, { formatLaunchCapacity }] = await Promise.all([
        import('../launch-capacity-host-list.js'),
        import('../launch-capacity-format.js')
      ])
      printResult(localSuccess(await readHostListCapacity(flags)), json, formatLaunchCapacity)
      return
    }
    const capacityOnly = ['provider', 'project', 'model'].filter((name) => flags.has(name))
    if (capacityOnly.length > 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `${capacityOnly.map((name) => `--${name}`).join(', ')} only applies with --capacity: omni host list --capacity --provider <claude|codex> [--project <id>] [--model <m>].`
      )
    }
    const environments = listEnvironments(getDefaultUserDataPath()).map((environment) => ({
      id: environment.id,
      name: environment.name
    }))
    const hosts = hostListEntries(environments, await listSshTargets(context.client))
    printResult(localSuccess({ hosts }), json, formatHostList)
  },
  'environment list': async ({ json }) => {
    const environments = listEnvironments(getDefaultUserDataPath()).map(redactRuntimeEnvironment)
    printResult(localSuccess({ environments }), json, formatEnvironmentList)
  },
  'environment show': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const environment = redactRuntimeEnvironment(
      resolveEnvironment(getDefaultUserDataPath(), selector)
    )
    printResult(localSuccess({ environment }), json, ({ environment: value }) =>
      formatEnvironment(value)
    )
  },
  'environment rm': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const removed = redactRuntimeEnvironment(removeEnvironment(getDefaultUserDataPath(), selector))
    printResult(
      localSuccess({ removed }),
      json,
      (result: EnvironmentRemoveResult) =>
        `Removed environment ${result.removed.name} (${result.removed.id}).`
    )
  }
}

function hostListEntries(
  environments: readonly EnvironmentSummary[],
  sshTargets: readonly SshTargetSummary[]
): HostListEntry[] {
  return [
    {
      kind: 'local',
      name: 'this machine',
      id: 'local',
      selector: '--host local',
      launch: '--host local'
    },
    ...sshTargets.map((target) => ({
      kind: 'ssh' as const,
      name: target.label,
      id: target.id,
      selector: `--host ${quoteCliCommandArgument(`ssh:${target.id}`)}`,
      launch: launchHostFlag(
        target.label,
        findSshTargetByName(sshTargets, target.label)?.id === target.id,
        `ssh:${target.id}`
      )
    })),
    ...environments.map((environment) => ({
      kind: 'environment' as const,
      name: environment.name,
      id: environment.id,
      selector: `--environment ${quoteCliCommandArgument(environment.name)}`,
      launch: launchHostFlag(
        environment.name,
        findEnvironmentByName(environments, environment.name)?.id === environment.id,
        `runtime:${environment.id}`
      )
    }))
  ]
}

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}
