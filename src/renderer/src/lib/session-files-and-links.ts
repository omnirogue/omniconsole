import type { CheckStatus } from '../../../shared/github/pull-request-types'
import type { HostedReviewInfo, HostedReviewState } from '../../../shared/hosted-review'
import { classifySessionFile, type SessionFileKind } from '../../../shared/session-file-kind'
import { parseGitHubPullRequestUrl, type SessionLink } from '../../../shared/session-links'
import type { SessionPullRequestFacts } from '../../../shared/session-pull-request-facts'

export type SessionPullRequestCard = {
  type: 'pull-request'
  key: string
  number: number
  url: string
  /** owner/repo when the URL names them. */
  location: string
  state?: HostedReviewState
  checks?: CheckStatus
  /** The newest message that named it, when the transcript did. */
  messageIndex?: number
}

export type SessionFileCard = {
  type: 'file'
  key: string
  path: string
  kind: SessionFileKind
  name: string
  location: string
  messageIndex: number
}

export type SessionLinkCard = {
  type: 'link'
  key: string
  kind: 'artifact' | 'localhost' | 'preview' | 'service'
  url: string
  name: string
  location: string
  messageIndex: number
  /** The pull request a preview host was deployed for. */
  pullRequestNumber?: number
  /** Distinct pages of this preview host the session printed, when more than one. */
  pages?: number
  /** A brand's home page rather than a preview of the work. */
  site?: boolean
}

/** Several deliverable files in one folder, offered as that folder. */
export type SessionFolderCard = {
  type: 'folder'
  key: string
  path: string
  name: string
  location: string
  count: number
  /** The newest file in it, which "Show in folder" selects. */
  revealPath: string
}

export type FilesAndLinksCard =
  | SessionPullRequestCard
  | SessionFileCard
  | SessionLinkCard
  | SessionFolderCard

/** Cards shown before "Show all". */
export const FILES_AND_LINKS_PREVIEW_COUNT = 8

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Transcripts name some files relative to the workspace; resolve them against its root. */
export function resolveSessionFilePath(path: string, worktreePath: string | null): string | null {
  if (isAbsolutePath(path)) {
    return path
  }
  if (!worktreePath) {
    return null
  }
  const separator = worktreePath.includes('\\') && !worktreePath.includes('/') ? '\\' : '/'
  return `${worktreePath.replace(/[\\/]+$/, '')}${separator}${path.replace(/^\.[\\/]/, '')}`
}

function splitPath(path: string): { name: string; directory: string } {
  const parts = path.split(/[\\/]/).filter(Boolean)
  const name = parts.pop() ?? path
  return { name, directory: parts.join('/') }
}

/** The folder a person recognises: workspace-relative inside it, else the last two folders. */
export function shortFileLocation(path: string, worktreePath: string | null): string {
  const root = worktreePath?.replace(/[\\/]+$/, '')
  if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) {
    return splitPath(path.slice(root.length + 1)).directory
  }
  const directories = splitPath(path).directory.split('/').filter(Boolean)
  return directories.length > 2 ? `…/${directories.slice(-2).join('/')}` : directories.join('/')
}

function linkNameAndLocation(link: SessionLink): { name: string; location: string } {
  try {
    const parsed = new URL(link.url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    if (link.kind === 'artifact') {
      const id = parsed.pathname.split('/').findLast((part) => part.length > 0) ?? ''
      return { name: id, location: 'claude.ai' }
    }
    if (link.kind === 'service') {
      return { name: link.service ?? parsed.host, location: parsed.host }
    }
    return { name: parsed.host, location: `${path}${parsed.search}` }
  } catch {
    return { name: link.url, location: '' }
  }
}

/** A review's address, compared whole: host and path, never just its number. */
function reviewAddress(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`
  } catch {
    return null
  }
}

function sameReview(url: string, review: Pick<HostedReviewInfo, 'url'>): boolean {
  const address = reviewAddress(url)
  return address !== null && address === reviewAddress(review.url)
}

function transcriptLinksReview(
  review: Pick<HostedReviewInfo, 'number' | 'url'>,
  links: readonly SessionLink[]
): boolean {
  return Boolean(review.url) && links.some((link) => sameReview(link.url, review))
}

function pullRequestCard(
  url: string,
  number: number,
  review?: Pick<HostedReviewInfo, 'state' | 'status'>,
  messageIndex?: number
): SessionPullRequestCard {
  const parsed = parseGitHubPullRequestUrl(url)
  return {
    type: 'pull-request',
    key: `pr:${parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : url}#${number}`,
    number,
    url,
    location: parsed ? `${parsed.owner}/${parsed.repo}` : '',
    ...(review ? { state: review.state, checks: review.status } : {}),
    ...(messageIndex === undefined ? {} : { messageIndex })
  }
}

/**
 * The Files & links list: the workspace's pull request first, then any other pull requests the
 * transcript linked, then files and links newest first. Transcript links to the workspace's own
 * pull request fold into its card instead of repeating it.
 */
export function buildFilesAndLinksCards({
  review: workspaceReview,
  files,
  links,
  worktreePath,
  reviewOnlyWhenLinked = false
}: {
  review: Pick<HostedReviewInfo, 'number' | 'url' | 'state' | 'status'> | null
  /** Paths from conversationWrittenFileEntries that are known to still exist. */
  files: readonly { path: string; messageIndex: number }[]
  links: readonly SessionLink[]
  worktreePath: string | null
  /**
   * The workspace's pull request belongs to its branch, not to one session: a view of one
   * session's own work shows it only when that session's transcript links it.
   */
  reviewOnlyWhenLinked?: boolean
}): FilesAndLinksCard[] {
  const review =
    reviewOnlyWhenLinked && workspaceReview && !transcriptLinksReview(workspaceReview, links)
      ? null
      : workspaceReview
  const pullRequests: SessionPullRequestCard[] = []
  const seenPullRequests = new Set<string>()
  const addPullRequest = (card: SessionPullRequestCard): void => {
    if (!seenPullRequests.has(card.key)) {
      seenPullRequests.add(card.key)
      pullRequests.push(card)
    }
  }
  if (review?.url) {
    addPullRequest(pullRequestCard(review.url, review.number, review))
  }
  const workspacePullRequestKey = pullRequests[0]?.key
  const rest: (SessionFileCard | SessionLinkCard)[] = []
  for (const link of links) {
    // Why the whole address: a GitLab !42 and a GitHub #42 share a number, not an identity.
    const sameAsWorkspace = review?.url ? sameReview(link.url, review) : false
    if (link.kind === 'pull-request' && link.pullRequest) {
      const card = pullRequestCard(link.url, link.pullRequest.number, undefined, link.messageIndex)
      if (!sameAsWorkspace && card.key !== workspacePullRequestKey) {
        addPullRequest(card)
      }
      continue
    }
    if (link.kind !== 'pull-request' && !sameAsWorkspace) {
      rest.push({
        type: 'link',
        key: `link:${link.key}`,
        kind: link.kind,
        url: link.url,
        messageIndex: link.messageIndex,
        ...linkNameAndLocation(link)
      })
    }
  }
  for (const file of files) {
    rest.push({
      type: 'file',
      key: `file:${file.path}`,
      path: file.path,
      kind: classifySessionFile(file.path),
      name: splitPath(file.path).name,
      location: shortFileLocation(file.path, worktreePath),
      messageIndex: file.messageIndex
    })
  }
  rest.sort((a, b) => b.messageIndex - a.messageIndex)
  return [...pullRequests, ...rest]
}

/** The review state and checks a card lacks, filled from facts read for the session's progress. */
export function withKnownPullRequestState(
  cards: readonly FilesAndLinksCard[],
  known: ReadonlyMap<string, Pick<SessionPullRequestFacts, 'state' | 'checks'>>
): FilesAndLinksCard[] {
  return cards.map((card) => {
    if (card.type !== 'pull-request' || card.state) {
      return card
    }
    const facts = known.get(card.key.replace(/^pr:/, ''))
    return facts ? { ...card, state: facts.state, checks: facts.checks } : card
  })
}
