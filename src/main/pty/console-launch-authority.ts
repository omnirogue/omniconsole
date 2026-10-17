import { randomUUID } from 'node:crypto'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { PtyLaunchGateRequest } from '../../shared/pty-launch-gate'

type ConsoleLaunchAuthority = {
  taskId: string
  worktreeId: string
  cwd: string
  validate(): Promise<void>
  assertCurrent(): void
  consumed: boolean
}

const authorities = new WeakMap<PtyLaunchGateRequest, ConsoleLaunchAuthority>()

/** Only the main-process activation adapter can mint this non-serializable authority. */
export function mintConsoleLaunchGate(
  authority: Omit<ConsoleLaunchAuthority, 'consumed'>
): PtyLaunchGateRequest {
  const gate: PtyLaunchGateRequest = Object.freeze({
    version: 1,
    launchId: randomUUID(),
    startupCommandMode: 'exec',
    processObservation: 'required'
  })
  authorities.set(gate, { ...authority, consumed: false })
  return gate
}

export function hasConsoleLaunchAuthority(gate: PtyLaunchGateRequest | undefined): boolean {
  return Boolean(gate && authorities.get(gate)?.consumed === false)
}

export function consoleLaunchAuthorizesTask(
  gate: PtyLaunchGateRequest | undefined,
  taskIds: readonly string[],
  worktreeId?: string
): boolean {
  const authority = gate && authorities.get(gate)
  return Boolean(
    authority &&
    !authority.consumed &&
    taskIds.every((taskId) => taskId === authority.taskId) &&
    (worktreeId === undefined || worktreeId === authority.worktreeId)
  )
}

/** Recheck the person and stored activation after every asynchronous native preflight. */
export async function revalidateConsoleLaunchAuthority(
  gate: PtyLaunchGateRequest | undefined,
  worktreeId: string | undefined,
  cwd: string,
  env: Record<string, string>
): Promise<void> {
  const authority = gate && authorities.get(gate)
  if (!authority) {
    return
  }
  if (
    authority.consumed ||
    authority.worktreeId !== worktreeId ||
    env.OMNI_TASK_ID !== authority.taskId ||
    normalizeRuntimePathForComparison(authority.cwd) !== normalizeRuntimePathForComparison(cwd)
  ) {
    throw new Error('console_launch_authority_mismatch')
  }
  await authority.validate()
  if (authority.consumed) {
    throw new Error('console_launch_authority_consumed')
  }
}

/** Consume synchronously immediately before node-pty; concurrent retries cannot spawn twice. */
export function consumeConsoleLaunchAuthority(gate: PtyLaunchGateRequest | undefined): void {
  const authority = gate && authorities.get(gate)
  if (!authority) {
    return
  }
  if (authority.consumed) {
    throw new Error('console_launch_authority_consumed')
  }
  authority.assertCurrent()
  authority.consumed = true
}
