/** The text table for `omni host list --capacity`; `--json` prints the same rows unformatted. */

import type {
  LaunchCapacityAccounts,
  LaunchCapacityRow
} from '../shared/agent-launch-placement-types'
import type { AgentLaunchLoad } from '../shared/agent-launch-account'
import { CAPACITY_ROUTE_WORD, type LaunchCapacityResult } from './launch-capacity-view'

const BOUND_WORD = { 'five-hour': '5-hour', weekly: 'weekly', 'fable-weekly': 'Fable weekly' }

const pad = (value: number): string => String(value).padStart(2, '0')

/** On this computer's clock, which is also where the reading ages were measured. */
function capacityClock(ms: number, seconds = false): string {
  const date = new Date(ms)
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return seconds ? `${hm}:${pad(date.getSeconds())}` : hm
}

function capacityAge(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`
}

function capacityAccountsText(
  accounts: LaunchCapacityAccounts | undefined,
  provider: string
): string {
  if (!accounts) {
    return 'not read'
  }
  const readOnly = accounts.source === 'accounts-list' ? ' (read-only)' : ''
  const tally = `${accounts.verifiedCount}/${accounts.consideredCount} verified`
  switch (accounts.freshness) {
    case 'fresh':
      return [
        `${accounts.bestRemainingPercent}% left`,
        accounts.boundBy ? BOUND_WORD[accounts.boundBy] : null,
        accounts.readingAgeMs !== null ? `${capacityAge(accounts.readingAgeMs)} old` : null,
        tally
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
        .concat(readOnly)
    case 'limited':
      return `limited${accounts.limitedUntil !== undefined ? ` until ${capacityClock(accounts.limitedUntil)}` : ''} · ${tally}${readOnly}`
    case 'unverifiable':
      return 'unverifiable'
    case 'none':
      return `no ${provider} accounts${readOnly}`
    case 'signed-out':
    case 'stale':
    case 'unknown':
      return `${accounts.freshness} · ${tally}${readOnly}`
  }
}

function capacityLoadText(load: AgentLaunchLoad | null): string {
  return load ? `${load.band} ${load.loadPerCore.toFixed(2)}` : 'unknown'
}

function projectText(row: LaunchCapacityRow): string {
  const setups = row.project?.setups ?? 0
  return setups === 0 ? 'none' : `${setups} setup${setups === 1 ? '' : 's'}`
}

function table(rows: readonly string[][]): string[] {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((cells) => (column === rows[0]!.length - 1 ? 0 : cells[column]!.length)))
  )
  return rows.map((cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd()
  )
}

export function formatLaunchCapacity(result: LaunchCapacityResult): string {
  const { provider, project } = result
  const header = [
    `${provider} capacity by computer`,
    result.model ? ` (${result.model})` : '',
    project ? ` for ${project.identityKey}` : '',
    `, checked ${capacityClock(result.checkedAt, true)}`
  ].join('')
  const columns = [
    'COMPUTER',
    'ROUTES',
    'ACCOUNTS',
    'LOAD',
    ...(project ? ['PROJECT'] : []),
    'LAUNCH',
    'REASON'
  ]
  const rows = result.rows.map((row) => [
    row.label,
    [...new Set(row.routes.map(({ route }) => CAPACITY_ROUTE_WORD[route.kind]))].join('+'),
    capacityAccountsText(row.accounts[provider], provider),
    capacityLoadText(row.load),
    ...(project ? [projectText(row)] : []),
    row.eligible ? 'yes' : 'no',
    row.reason
  ])
  return [
    header,
    '',
    ...table([columns, ...rows]),
    '',
    ...(result.recommendedCommand ? [`Launch: ${result.recommendedCommand}`] : []),
    ...result.notes
  ].join('\n')
}
