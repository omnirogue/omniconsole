// The one thing a session produced that a person should open — its Result — and everything
// else folded behind it. Pure: the section passes in the cards and each local server's liveness.

import { isOwnedSiteRoot, previewPullRequestNumber } from '../../../shared/session-links'
import type { SessionFileKind } from '../../../shared/session-file-kind'
import type {
  FilesAndLinksCard,
  SessionFileCard,
  SessionFolderCard,
  SessionLinkCard,
  SessionPullRequestCard
} from './session-files-and-links'

/** Files a person opens to look at, as opposed to source they would edit. */
const DELIVERABLE_KINDS: ReadonlySet<SessionFileKind> = new Set([
  'html',
  'image',
  'video',
  'audio',
  'pdf',
  'markdown',
  'csv',
  'document'
])

export type FilesAndLinksLiveness = 'live' | 'stopped' | 'unverifiable'

export type FilesAndLinksFoldCounts = {
  pullRequests: number
  previews: number
  files: number
  other: number
}

export type FilesAndLinksView = {
  result: FilesAndLinksCard | null
  /** Everything else, grouped: PRs, previews, artifacts, service links, files, servers, sites. */
  rest: FilesAndLinksCard[]
  counts: FilesAndLinksFoldCounts
}

function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return url
  }
}

/** Previews annotated with their PR and folded to one card per host (the newest page). */
function groupPreviews(previews: readonly SessionLinkCard[]): SessionLinkCard[] {
  const byHost = new Map<string, { card: SessionLinkCard; pages: Set<string> }>()
  for (const card of previews) {
    const host = hostOf(card.url)
    const entry = byHost.get(host)
    if (entry) {
      entry.pages.add(card.key)
      continue
    }
    const pullRequestNumber = previewPullRequestNumber(card.url)
    byHost.set(host, {
      card: {
        ...card,
        ...(pullRequestNumber === null ? {} : { pullRequestNumber }),
        ...(isOwnedSiteRoot(card.url) ? { site: true } : {})
      },
      pages: new Set([card.key])
    })
  }
  return [...byHost.values()].map(({ card, pages }) =>
    pages.size > 1 ? { ...card, pages: pages.size } : card
  )
}

function newest<T extends { messageIndex: number }>(
  ...candidates: (T | undefined)[]
): T | undefined {
  return candidates
    .filter((candidate): candidate is T => candidate !== undefined)
    .reduce<T | undefined>(
      (best, candidate) =>
        best === undefined || candidate.messageIndex > best.messageIndex ? candidate : best,
      undefined
    )
}

/** The newest deliverable file, or its folder when that folder holds several of them. */
function deliverableResult(
  files: readonly SessionFileCard[]
): SessionFileCard | SessionFolderCard | undefined {
  const deliverables = files.filter((file) => DELIVERABLE_KINDS.has(file.kind))
  const latest = deliverables[0]
  if (!latest) {
    return undefined
  }
  const folder = parentOf(latest.path)
  const together = deliverables.filter((file) => parentOf(file.path) === folder)
  if (together.length < 2) {
    return latest
  }
  return {
    type: 'folder',
    key: `folder:${folder}`,
    path: folder,
    name: folder.split(/[\\/]/).findLast((part) => part.length > 0) ?? folder,
    location: latest.location,
    count: together.length,
    revealPath: latest.path
  }
}

/**
 * Picks the Result, in this order: the newest of a preview of the session's own PR, a Claude
 * artifact and a work-service link (Drive, Notion, Figma…); else the newest deliverable file (its folder when several share one); else a running
 * local server; else another preview; else the pull request. Stopped servers are dropped.
 */
export function filesAndLinksView(
  cards: readonly FilesAndLinksCard[],
  liveness: ReadonlyMap<string, FilesAndLinksLiveness> = new Map()
): FilesAndLinksView {
  const pullRequests = cards.filter(
    (card): card is SessionPullRequestCard => card.type === 'pull-request'
  )
  const links = cards.filter((card): card is SessionLinkCard => card.type === 'link')
  const files = cards.filter((card): card is SessionFileCard => card.type === 'file')
  const grouped = groupPreviews(links.filter((link) => link.kind === 'preview'))
  const previews = grouped.filter((link) => !link.site)
  const sites = grouped.filter((link) => link.site)
  const artifacts = links.filter((link) => link.kind === 'artifact')
  const services = links.filter((link) => link.kind === 'service')
  const servers = links.filter(
    (link) => link.kind === 'localhost' && liveness.get(link.url) !== 'stopped'
  )
  const sessionPullRequests = new Set(pullRequests.map((card) => card.number))
  const ownPreview = previews.find(
    (link) =>
      link.pullRequestNumber !== undefined && sessionPullRequests.has(link.pullRequestNumber)
  )
  const result: FilesAndLinksCard | null =
    newest(ownPreview, artifacts[0], services[0]) ??
    deliverableResult(files) ??
    servers.find((link) => liveness.get(link.url) === 'live') ??
    previews[0] ??
    pullRequests[0] ??
    null
  const folded = new Set(
    result?.type === 'folder'
      ? files
          .filter((file) => DELIVERABLE_KINDS.has(file.kind) && parentOf(file.path) === result.path)
          .map((file) => file.key)
      : []
  )
  const rest = [
    ...pullRequests,
    ...previews,
    ...artifacts,
    ...services,
    ...files,
    ...servers,
    ...sites
  ].filter((card) => card.key !== result?.key && !folded.has(card.key))
  return {
    result,
    rest,
    counts: {
      pullRequests: rest.filter((card) => card.type === 'pull-request').length,
      previews: rest.filter((card) => card.type === 'link' && card.kind === 'preview' && !card.site)
        .length,
      files: rest.filter((card) => card.type === 'file').length,
      other: rest.filter(
        (card) => card.type === 'link' && (card.kind !== 'preview' || card.site === true)
      ).length
    }
  }
}
