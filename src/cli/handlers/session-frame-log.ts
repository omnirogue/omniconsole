/** `omni session frame-log on|off|status` and `omni session sidebar-counts` (session-count step 0). */

import {
  SESSION_FRAME_LOG_MAX_DURATION_MS,
  SESSION_FRAME_LOG_RPC,
  SESSION_SIDEBAR_COUNTS_RPC,
  type SessionFrameLogStatus
} from '../../shared/session-frame-log'
import { parseSinceDuration } from '../../shared/session-organization-readers'
import type {
  SessionSidebarCountsResult,
  SessionSidebarHostCount
} from '../../shared/session-sidebar-counts'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  formatOwnerLedgerState,
  formatParityBuckets,
  formatParityPopulation
} from '../session-parity-format'
import { refuseRemote } from './session-manage-access'

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatSessionFrameLogStatus(status: SessionFrameLogStatus): string {
  const build = status.build.appVersion
    ? `${status.build.appVersion}${status.build.commit ? ` (commit ${status.build.commit})` : ''}`
    : 'unknown'
  const since =
    status.enabled && status.enabledAt ? ` since ${new Date(status.enabledAt).toISOString()}` : ''
  const until =
    status.enabled && status.expiresAt
      ? `, switches itself off at ${new Date(status.expiresAt).toISOString()}`
      : ''
  return [
    `Session frame log: ${status.enabled ? 'on' : 'off'}${since}${until}`,
    `File: ${status.filePath}`,
    `Size: ${formatMegabytes(status.bytes)} in ${status.files.length} file(s), capped at ${formatMegabytes(
      status.maxBytes * status.maxFiles
    )}`,
    `Build: ${build}`
  ].join('\n')
}

/** `buckets` adds the parity split (session parity, step 8) when the window sent one. */
function hostLine(host: SessionSidebarHostCount, buckets = false): string {
  const split = buckets ? formatParityBuckets(host) : null
  return `  ${host.label ?? host.hostId}${host.label ? ` (${host.hostId})` : ''}: ${host.count}${split ? ` — ${split}` : ''}`
}

/** G2: each paired owner's ledger state, labelled as the switch names that computer. */
function ownerLedgerLines(result: SessionSidebarCountsResult): string[] {
  if (!result.ownerLedgers?.length) {
    return []
  }
  const labels = new Map(result.switchHostCounts.map((host) => [host.hostId, host.label]))
  return [
    'Paired owners’ ledgers:',
    ...result.ownerLedgers.map(
      (ledger) =>
        `  ${labels.get(ledger.hostId) ?? ledger.hostId}: ${formatOwnerLedgerState(ledger)}`
    )
  ]
}

export function formatSessionSidebarCounts(result: SessionSidebarCountsResult): string {
  if (!result.available) {
    return [
      `Sidebar counts unavailable: ${result.reason ?? 'no rendered sidebar'}`,
      ...ownerLedgerLines(result),
      ...(result.parity ? formatParityPopulation(result.parity) : [])
    ].join('\n')
  }
  const lines = [
    `Rendered ${result.renderedAt ? new Date(result.renderedAt).toISOString() : 'never'}, read ${new Date(result.readAt).toISOString()}`,
    'Host switch (as shown):',
    ...result.switchHostCounts.map((host) => hostLine(host)),
    'Sessions per host (hosts with sessions):',
    ...result.sessionCountsByHost.map((host) => hostLine(host, true)),
    ...ownerLedgerLines(result),
    `Archived: ${result.archivedCount ?? '?'}`,
    `Hidden: ${result.hiddenCount ?? '?'}`,
    `Rows: ${result.rows.length} (${result.rows.filter((row) => row.archived).length} archived)`,
    ...(result.parity ? formatParityPopulation(result.parity) : [])
  ]
  if (result.build?.appVersion) {
    lines.push(`Build: ${result.build.appVersion}`)
  }
  return lines.join('\n')
}

function readDuration(flags: HandlerContext['flags']): number | undefined {
  const raw = getOptionalStringFlag(flags, 'for')
  if (raw === undefined) {
    return undefined
  }
  const durationMs = parseSinceDuration(raw)
  if (durationMs === null || durationMs > SESSION_FRAME_LOG_MAX_DURATION_MS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--for takes a duration up to 48h, such as 30m, 8h or 2d (got "${raw}").`
    )
  }
  return Math.round(durationMs)
}

export const SESSION_FRAME_LOG_HANDLERS: Record<string, CommandHandler> = {
  'session frame-log': async ({ client, flags, json }) => {
    refuseRemote(client)
    const state = (getOptionalStringFlag(flags, 'state') ?? 'status').toLowerCase()
    if (state !== 'on' && state !== 'off' && state !== 'status') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown frame-log state "${state}". Use on, off or status.`
      )
    }
    const durationMs = readDuration(flags)
    if (durationMs !== undefined && state !== 'on') {
      throw new RuntimeClientError('invalid_argument', '--for goes with on.')
    }
    const response =
      state === 'status'
        ? await client.call<SessionFrameLogStatus>(SESSION_FRAME_LOG_RPC.status)
        : await client.call<SessionFrameLogStatus>(SESSION_FRAME_LOG_RPC.set, {
            enabled: state === 'on',
            ...(durationMs !== undefined ? { durationMs } : {})
          })
    printResult(response, json, formatSessionFrameLogStatus)
  },
  'session sidebar-counts': async ({ client, json }) => {
    refuseRemote(client)
    const response = await client.call<SessionSidebarCountsResult>(SESSION_SIDEBAR_COUNTS_RPC)
    printResult(response, json, formatSessionSidebarCounts)
  }
}
