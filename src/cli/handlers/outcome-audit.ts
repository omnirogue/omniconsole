import type { SessionRunAuditRow } from '../../shared/session-run-audit'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'

export function formatOutcomeAudit(rows: readonly SessionRunAuditRow[]): string {
  if (!rows.length) {
    return 'Every pursued session agrees with its own record.'
  }
  return rows
    .map((row) =>
      [
        `${row.chainId}  ${row.title}`,
        `  recorded ${row.state}, reads as ${row.phase}`,
        `  findings: ${row.findings.join(', ')}`,
        `  reconciliation will: ${row.repair}`,
        ...row.reasons.map((reason) => `  - ${reason}`)
      ].join('\n')
    )
    .join('\n')
}

/** Read-only: lists runs whose record contradicts itself. It repairs nothing. */
export async function auditOutcomes({ client, json }: HandlerContext): Promise<void> {
  const capabilities = await client.call<{ executionRuntimeId?: string }>(
    'sessionChain.outcomeCapabilities'
  )
  const runtimeId = capabilities.result.executionRuntimeId
  const response = await client.call<{ rows: SessionRunAuditRow[] }>(
    'sessionChain.auditRuns',
    runtimeId ? { expectedExecutionRuntimeId: runtimeId } : {}
  )
  printResult(response, json, (result) => formatOutcomeAudit(result.rows))
}
