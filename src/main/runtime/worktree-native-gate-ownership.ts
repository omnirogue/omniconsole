import type { IPtyProvider } from '../providers/types'
import type { WorktreeTeardownDeps } from './worktree-teardown'
import { ptyLaunchGates } from '../providers/local-pty-provider-state'
import { getNativeLocalPtyProvider } from '../ipc/pty/provider/registry'
import { resolveUnstoppedPtyVerdict, type UnstoppedPtyVerdict } from './unstopped-pty-verification'

export function getWorktreeNativeGateProvider(scope: {
  resolvedConnectionId?: string
  resolvedRuntimeEnvironmentId?: string
}): IPtyProvider | undefined {
  return scope.resolvedConnectionId === undefined &&
    scope.resolvedRuntimeEnvironmentId === undefined
    ? getNativeLocalPtyProvider()
    : undefined
}

export function providerForWorktreePty(
  ptyId: string,
  localProvider: IPtyProvider,
  nativeProvider?: IPtyProvider
): IPtyProvider {
  return nativeProvider && ptyLaunchGates.has(ptyId) ? nativeProvider : localProvider
}

/** Absence from the daemon inventory cannot prove that its native sidecar process exited. */
export async function resolveWorktreeNativeGateStopVerdict(
  stopAttempts: ReadonlyMap<string, Promise<boolean>>,
  deps: WorktreeTeardownDeps,
  nativeProvider: IPtyProvider | undefined,
  sweepBudgetMs: number
): Promise<{ failedPtyIds: string[]; verdict: UnstoppedPtyVerdict }> {
  const { localProvider, runtime } = deps
  const stopResults = await Promise.all(
    [...stopAttempts].map(async ([ptyId, stopped]) => [ptyId, await stopped] as const)
  )
  const failedPtyIds = stopResults.filter(([, stopped]) => !stopped).map(([ptyId]) => ptyId)
  const nativeFailedIds = new Set(
    nativeProvider ? failedPtyIds.filter((id) => ptyLaunchGates.has(id)) : []
  )
  const [defaultVerdict, nativeVerdict] = await Promise.all([
    resolveUnstoppedPtyVerdict(
      failedPtyIds.filter((id) => !nativeFailedIds.has(id)),
      localProvider,
      sweepBudgetMs,
      deps.includeProviderInventory !== false ||
        (deps.resolvedConnectionId === undefined &&
          deps.resolvedRuntimeEnvironmentId === undefined),
      runtime
    ),
    resolveUnstoppedPtyVerdict(
      [...nativeFailedIds],
      nativeProvider ?? localProvider,
      sweepBudgetMs,
      nativeProvider !== undefined,
      runtime
    )
  ])
  const livePtyIds = [defaultVerdict, nativeVerdict].flatMap((result) =>
    result.status === 'live' ? result.ptyIds : []
  )
  const verdict: UnstoppedPtyVerdict =
    livePtyIds.length > 0
      ? { status: 'live', ptyIds: livePtyIds }
      : defaultVerdict.status !== 'exited'
        ? defaultVerdict
        : nativeVerdict
  return { failedPtyIds, verdict }
}
