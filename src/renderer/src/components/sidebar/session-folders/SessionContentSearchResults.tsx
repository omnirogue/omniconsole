import { toast } from 'sonner'
import { Copy, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { focusSessionInGrid } from '@/lib/session-grid-actions'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import {
  buildConversationResumeCommand,
  type ConversationResumeCommand
} from '../../../../../shared/conversation-resume-command'
import type {
  SessionSearchHit,
  SessionSearchHostStatus
} from '../../../../../shared/session-search-types'
import type { SessionContentSearch } from './use-session-content-search'
import {
  SessionSearchActiveContext,
  SessionSearchPreviewContext
} from './session-search-preview-context'
import { sessionSearchPreview } from './session-search-preview'
import { SessionSearchPreviewLine } from './SessionSearchPreviewLine'
import { resumeSessionSearchHit } from './resume-session-search-hit'
import { SessionSidebarEmpty } from './SessionSidebarEmpty'

/** Quoted for the shell of the host it runs on, under the profile its transcript lives in. */
function resumeCommandForHit(hit: SessionSearchHit): ConversationResumeCommand {
  return buildConversationResumeCommand({
    agent: hit.agent,
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    transcriptPath: hit.transcriptPath,
    executionHostId: hit.executionHostId,
    hostLabel: hit.hostLabel,
    // Why POSIX elsewhere: a paired host's shell is not known here (see getAiVaultResumePlatform).
    platform: hit.executionHostId === 'local' ? CLIENT_PLATFORM : 'linux'
  })
}

function hostProblem(host: SessionSearchHostStatus): string | null {
  switch (host.state) {
    case 'unreachable':
      return translate('sessionContentSearch.hostUnreachable', '{{host}} could not be asked', {
        host: host.hostLabel
      })
    case 'unsupported':
      return host.message
        ? translate('sessionContentSearch.hostCoverageMessage', '{{host}}: {{message}}', {
            host: host.hostLabel,
            message: host.message
          })
        : translate('sessionContentSearch.hostUnavailable', '{{host}} could not be searched', {
            host: host.hostLabel
          })
    case 'failed':
      return translate('sessionContentSearch.hostFailed', '{{host}} search failed', {
        host: host.hostLabel
      })
    case 'indexing':
      return translate('sessionContentSearch.hostIndexing', '{{host}} is still indexing', {
        host: host.hostLabel
      })
    case 'searched':
      return (host.pendingFiles ?? 0) > 0
        ? translate('sessionContentSearch.hostIndexing', '{{host}} is still indexing', {
            host: host.hostLabel
          })
        : null
  }
}

/** One line for what the conversation search covered; the per-machine detail is its tooltip. */
export function sessionSearchCoverageLine(
  hosts: readonly SessionSearchHostStatus[]
): { text: string; detail: string } | null {
  const indexing = hosts.filter(
    (host) =>
      host.state === 'indexing' || (host.state === 'searched' && (host.pendingFiles ?? 0) > 0)
  )
  const missed = hosts.filter(
    (host) => host.state !== 'searched' && host.state !== 'indexing'
  ).length
  const parts: string[] = []
  if (indexing.length === 1) {
    parts.push(hostProblem(indexing[0]!)!)
  } else if (indexing.length > 1) {
    parts.push(
      translate('sessionContentSearch.machinesIndexing', '{{count}} machines still indexing', {
        count: indexing.length
      })
    )
  }
  if (missed > 0) {
    parts.push(
      missed === 1
        ? translate('sessionContentSearch.machineNotSearched', '1 machine not searched')
        : translate('sessionContentSearch.machinesNotSearched', '{{count}} machines not searched', {
            count: missed
          })
    )
  }
  if (parts.length === 0) {
    return null
  }
  return {
    text: parts.join(' · '),
    detail: hosts.map(hostProblem).filter(Boolean).join('\n')
  }
}

/** Under the filter box: that conversations are being searched, and anything left unsearched. */
export function SessionSearchStatusLine({
  search
}: {
  search: SessionContentSearch
}): React.JSX.Element | null {
  if (!search.query) {
    return null
  }
  const coverage = search.result ? sessionSearchCoverageLine(search.result.hosts) : null
  const text = search.loading
    ? translate('sessionContentSearch.searchingConversations', 'Searching conversations…')
    : coverage?.text
  if (!text) {
    return null
  }
  return (
    <p
      className="truncate px-1 text-[11px] text-muted-foreground"
      title={search.loading ? undefined : coverage?.detail}
      data-session-search-status=""
    >
      {text}
    </p>
  )
}

function openFoundRow(session: SidebarSession): void {
  // Why: a conversation already on the Grid is focused there, not pulled out of it.
  if (!focusSessionInGrid(session)) {
    openSidebarSession(session)
  }
}

/** A result the sidebar has no row for: title and machine on one line, the passage under it. */
export function SessionSearchHitRow({
  hit,
  search,
  now
}: {
  hit: SessionSearchHit
  search: SessionContentSearch
  now: number
}): React.JSX.Element {
  const row = search.rowFor(hit)
  const preview = sessionSearchPreview(hit, search.query)
  const title =
    row?.label ||
    hit.title.trim() ||
    translate('sessionContentSearch.untitled', 'Untitled conversation')
  const when = hit.lastActivityAt !== null ? formatUiRelativeTime(hit.lastActivityAt - now) : null
  const resume = resumeCommandForHit(hit)
  const copyLabel = resume.hostLabel
    ? translate('sessionContentSearch.copyResumeForHost', 'Copy resume command for {{host}}', {
        host: resume.hostLabel
      })
    : translate('sessionContentSearch.copyResume', 'Copy resume command')
  const copy = (): void => {
    void window.api.ui.writeClipboardText(resume.command)
    toast.success(
      resume.hostLabel
        ? translate(
            'sessionContentSearch.copiedForHost',
            'Resume command copied. Run it on {{host}}, where this conversation is.',
            { host: resume.hostLabel }
          )
        : translate('sessionContentSearch.copied', 'Resume command copied')
    )
  }
  return (
    <div className="group relative" data-session-search-hit="">
      <button
        type="button"
        onClick={() => (row ? openFoundRow(row) : resumeSessionSearchHit(hit))}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left text-worktree-sidebar-foreground hover:bg-worktree-sidebar-accent"
        title={hit.reasons[0]}
      >
        <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 pr-5">
            <span className="min-w-0 truncate text-[13px]">{title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {[hit.hostLabel, when].filter(Boolean).join(' · ')}
            </span>
          </span>
          {preview ? <SessionSearchPreviewLine text={preview} /> : null}
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1 size-5 hidden text-muted-foreground group-hover:inline-flex"
        aria-label={copyLabel}
        title={copyLabel}
        onClick={copy}
      >
        <Copy className="size-3" />
      </Button>
    </div>
  )
}

/** The filter box, with one line under it while conversations are searched or left unsearched. */
export function SessionSearchBox({
  query,
  onQuery,
  search
}: {
  query: string
  onQuery: (query: string) => void
  search: SessionContentSearch
}): React.JSX.Element {
  return (
    <>
      <Input
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        aria-label={translate('auto.components.SessionSidebar.findSessions', 'Find sessions')}
        placeholder={translate(
          'auto.components.SessionSidebar.findSessionsPlaceholder',
          'Find sessions…'
        )}
        className="h-8"
      />
      <SessionSearchStatusLine search={search} />
    </>
  )
}

/**
 * The session list: while the filter is typed, rows draw on one line with the passage that
 * matched under it, and an empty list says nothing matched.
 */
export function SessionSearchRowsScope({
  search,
  children,
  ...end
}: {
  search: SessionContentSearch
  children: React.ReactNode
  query: string
  empty: boolean
  hiddenCount: number
}): React.JSX.Element {
  return (
    <SessionSearchActiveContext.Provider value={search.query !== ''}>
      <SessionSearchPreviewContext.Provider value={search.previews}>
        {children}
      </SessionSearchPreviewContext.Provider>
      <SessionSearchListEnd search={search} {...end} />
    </SessionSearchActiveContext.Provider>
  )
}

/** After the results: that nothing matched, once the conversation search has answered too. */
function SessionSearchListEnd({
  search,
  query,
  empty,
  hiddenCount
}: {
  search: SessionContentSearch
  query: string
  empty: boolean
  hiddenCount: number
}): React.JSX.Element | null {
  return empty && !search.loading ? (
    <SessionSidebarEmpty query={query} hiddenCount={hiddenCount} />
  ) : null
}
