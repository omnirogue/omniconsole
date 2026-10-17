import { createHash, randomUUID } from 'node:crypto'
import type { AccountCapacityRow } from '../../shared/provider-account-capacity'
import { isKnownNonFableClaudeModel } from '../../shared/account-launch-verdict'
import type { ConversationCapacityRecovery } from '../../shared/conversation-capacity-recovery'
import type { OrcaRuntimeService } from './omni-runtime'

const homeFor = (row: AccountCapacityRow): string | undefined =>
  row.launchEnv?.[row.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']

export function capacityRecoveryAccountKey(row: AccountCapacityRow): string {
  return `${row.provider}:${homeFor(row) ?? row.choiceId}`
}

export function selectCapacityRecoveryAccount(
  rows: readonly AccountCapacityRow[],
  sourceAgent: 'claude' | 'codex',
  sourceAccountHome: string,
  attemptedAccountKeys: readonly string[],
  sourceModel?: string
): AccountCapacityRow | null {
  const knownNonFableSourceModel =
    sourceAgent === 'claude' && isKnownNonFableClaudeModel(sourceModel)
  const exhausted = rows.filter((row) =>
    attemptedAccountKeys.includes(capacityRecoveryAccountKey(row))
  )
  const source = rows.find(
    (row) => row.provider === sourceAgent && homeFor(row) === sourceAccountHome
  )
  if (source) {
    exhausted.push(source)
  }
  return (
    rows
      .filter(
        (row) =>
          row.state === 'ready' &&
          row.readingAt !== null &&
          Date.now() - row.readingAt <= 300_000 &&
          homeFor(row) &&
          [row.fiveHour, row.weekly].every((window) => !window || window.remainingPercent > 0) &&
          ((row.provider === 'claude' && knownNonFableSourceModel) ||
            !row.fableWeekly ||
            row.fableWeekly.remainingPercent > 0) &&
          !(row.provider === sourceAgent && homeFor(row) === sourceAccountHome) &&
          !attemptedAccountKeys.includes(capacityRecoveryAccountKey(row)) &&
          !exhausted.some(
            (prior) =>
              prior.provider === row.provider &&
              prior.email &&
              prior.email === row.email &&
              prior.detail === row.detail
          )
      )
      .sort(
        (a, b) =>
          Number(b.provider === sourceAgent) - Number(a.provider === sourceAgent) ||
          Number(b.state === 'ready') - Number(a.state === 'ready') ||
          Number(b.isDefault) - Number(a.isDefault)
      )[0] ?? null
  )
}

const capacityRefreshAt = new WeakMap<OrcaRuntimeService, number>()

export function assignCapacityRecoveryTarget(
  runtime: OrcaRuntimeService,
  recovery: ConversationCapacityRecovery,
  now = Date.now()
): ConversationCapacityRecovery | null {
  const snapshot = runtime.getAccountsSnapshot().rateLimits.accountCapacity
  const rows = snapshot ? [...snapshot.claude, ...snapshot.codex] : []
  const eligible = rows.filter((row) => {
    try {
      runtime.validateOrchestrationAgentLauncher(row.provider)
      return true
    } catch {
      return false
    }
  })
  const resetSource = Boolean(
    recovery.sourceResetAt &&
    now >= recovery.sourceResetAt &&
    eligible.some(
      (row) =>
        row.provider === recovery.sourceAgent &&
        homeFor(row) === recovery.sourceAccountHome &&
        row.readingAt !== null &&
        row.readingAt >= recovery.sourceResetAt!
    )
  )
  const sourceKey = `${recovery.sourceAgent}:${recovery.sourceAccountHome}`
  const target = selectCapacityRecoveryAccount(
    eligible,
    recovery.sourceAgent,
    resetSource ? '' : recovery.sourceAccountHome,
    resetSource
      ? recovery.attemptAccounts.filter((key) => key !== sourceKey)
      : recovery.attemptAccounts,
    recovery.sourceModel
  )
  if (!target) {
    if (now - (capacityRefreshAt.get(runtime) ?? 0) >= 30_000) {
      capacityRefreshAt.set(runtime, now)
      void runtime
        .refreshAccountsForMobileSubscriber()
        .catch((error) => console.warn('[capacity-recovery] capacity refresh', error))
    }
    return null
  }
  return {
    ...recovery,
    phase: 'prepared',
    target: {
      agent: target.provider,
      accountHome: homeFor(target)!,
      accountChoiceId: target.choiceId,
      ...(target.provider === recovery.sourceAgent && recovery.sourceModel
        ? { model: recovery.sourceModel }
        : {})
    },
    successor: {
      tabId: randomUUID(),
      leafId: randomUUID(),
      handle: `term_${randomUUID()}`,
      launchToken: randomUUID(),
      operationId: createHash('sha256').update(recovery.id).digest('base64url')
    },
    reason: 'An eligible account has capacity; preparing the saved work for its replacement.'
  }
}
