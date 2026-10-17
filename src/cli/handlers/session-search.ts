import type {
  SessionSearchHit,
  SessionSearchHostStatus,
  SessionSearchResult
} from '../../shared/session-search-types'
import {
  SESSION_SEARCH_MARK_CLOSE,
  SESSION_SEARCH_MARK_OPEN
} from '../../shared/session-search-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { SESSION_SEARCH_QUERY_WORDS } from '../specs/session-search'
import { sessionSearchCoverageIncomplete } from '../../shared/session-search-coverage'
import { withSessionSearchSidebar } from '../session-search-sidebar-join'

function when(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time'
}

function formatHit(hit: SessionSearchHit, index: number): string {
  const snippet = hit.snippets[0]?.text
    .replaceAll(SESSION_SEARCH_MARK_OPEN, '[')
    .replaceAll(SESSION_SEARCH_MARK_CLOSE, ']')
    .replace(/\s+/g, ' ')
  const lines = [
    `${index + 1}. ${hit.title}`,
    `   ${hit.hostLabel} · ${hit.agent} ${hit.sessionId} · last active ${when(hit.lastActivityAt)}`,
    `   why: ${hit.reasons.join('; ') || 'related topic'}`
  ]
  if (snippet) {
    lines.push(`   “${snippet}”`)
  }
  if (hit.summary) {
    lines.push(...hit.summary.split('\n').map((line) => `   | ${line}`))
  }
  lines.push(`   ${hit.transcriptPath}`)
  if (hit.ref) {
    lines.push(`   ref ${hit.ref}`, ...sidebarLines(hit))
  }
  return lines.join('\n')
}

function sidebarLines(hit: SessionSearchHit): string[] {
  if (!hit.sidebar) {
    return []
  }
  if (hit.sidebar.length === 0) {
    return [
      hit.executionHostId === 'local'
        ? `   no sidebar row (its tab was closed): omni session resume --ref ${hit.ref}`
        : '   no sidebar row here; it runs on another computer'
    ]
  }
  return hit.sidebar.map((row) => {
    const archive = row.archived
      ? `archived${row.archiveKind ? ` (${row.archiveKind === 'automatic' ? 'automatically, finished' : 'by hand'})` : ''}`
      : null
    return `   in sidebar: ${[`pane ${row.paneKey ?? '(none yet)'}`, row.state, row.verdict, archive, row.folder].filter(Boolean).join(' · ')}`
  })
}

const NAMED_HOSTS = 4

function namedList(hosts: readonly SessionSearchHostStatus[]): string {
  const names = hosts.map((host) => host.hostLabel)
  const extra = names.length - NAMED_HOSTS
  return extra > 0 ? `${names.slice(0, NAMED_HOSTS).join(', ')} +${extra} more` : names.join(', ')
}

/** Coverage grouped by outcome: a controller with 40 SSH targets must not bury the results. */
export function formatSessionSearchHosts(hosts: readonly SessionSearchHostStatus[]): string {
  const searched = hosts
    .filter((host) => host.state === 'searched' || host.state === 'indexing')
    .map((host) => {
      const pending =
        host.state === 'indexing' || (host.pendingFiles ?? 0) > 0
          ? `, still indexing ${host.pendingFiles ?? 0} files`
          : ''
      return `${host.hostLabel} (${host.indexedSessions ?? 0} sessions${pending})`
    })
  const groups: [string, SessionSearchHostStatus[]][] = [
    ['needs an update', hosts.filter((host) => host.state === 'unsupported')],
    ['not reachable', hosts.filter((host) => host.state === 'unreachable')],
    ['failed', hosts.filter((host) => host.state === 'failed')]
  ]
  const missed = groups
    .filter(([, group]) => group.length > 0)
    .map(([label, group]) => `${label}: ${group.length} (${namedList(group)})`)
  return [
    `Searched — ${searched.join(' · ') || 'none'}`,
    ...(missed.length > 0 ? [`Not searched — ${missed.join(' · ')}`] : [])
  ].join('\n')
}

export function formatSessionSearchResult(result: SessionSearchResult): string {
  const body = result.hits.length
    ? result.hits.map(formatHit).join('\n\n')
    : `No matches returned for “${result.query}”.${sessionSearchCoverageIncomplete(result.hosts) ? ' Search coverage is incomplete.' : ''}`
  const join =
    result.sidebarJoin?.state === 'unavailable'
      ? `\nSidebar rows: ${result.sidebarJoin.reason}`
      : ''
  return `${body}\n\n${formatSessionSearchHosts(result.hosts)}${join}`
}

export const SESSION_SEARCH_HANDLERS: Record<string, CommandHandler> = {
  'session search': async ({ client, flags, json }) => {
    const query = SESSION_SEARCH_QUERY_WORDS.map((name) => getOptionalStringFlag(flags, name))
      .filter(Boolean)
      .join(' ')
      .trim()
    if (!query) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Say what to search for: omni session search <words…>'
      )
    }
    const limitFlag = getOptionalStringFlag(flags, 'limit')
    const limit = limitFlag ? Number.parseInt(limitFlag, 10) : undefined
    const response = await client.call<SessionSearchResult>('sessionSearch.query', {
      query,
      ...(limit && Number.isFinite(limit) ? { limit } : {}),
      includeRemote: flags.get('local') !== true
    })
    const joined = { ...response, result: await withSessionSearchSidebar(client, response.result) }
    printResult(joined, json, formatSessionSearchResult)
  }
}
