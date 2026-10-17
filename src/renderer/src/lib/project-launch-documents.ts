import { refreshProjectDocuments } from '../../../shared/project-document-refresh'
import type { SessionContextAttachment } from '../../../shared/session-context-attachments'
import type { LaunchProject } from './project-launch'
import { resolveContextDocument } from './session-context-document-client'

/** A re-read serves launches for this long; a launch waits this long for one, then uses the saved copy. */
const FRESH_FOR_MS = 60_000
const LAUNCH_WAIT_MS = 5_000

type Read = {
  at: number
  items: ReadonlyMap<string, SessionContextAttachment>
  done: Promise<void>
}

const reads = new Map<string, Read>()

function rereads(item: SessionContextAttachment): boolean {
  return item.kind === 'slite' || item.kind === 'omnios'
}

/**
 * Re-reads a project's Slite and OmniOS items (its notes doc among them) before a launch from this
 * window, as a no-window launch does in main (project-launch-resolve.ts): shared knowledge lives in
 * those documents, so a thread started today reads today's text. Null when there is nothing to
 * re-read. A read that fails, or outlasts the wait, leaves the saved copy in place.
 */
export function refreshProjectLaunchDocuments(
  project: LaunchProject | null,
  now = Date.now()
): Promise<void> | null {
  if (!project?.settings.attachments.some(rereads)) {
    return null
  }
  let read = reads.get(project.folderId)
  if (!read || now - read.at > FRESH_FOR_MS) {
    const entry: Read = { at: now, items: new Map(), done: Promise.resolve() }
    entry.done = refreshProjectDocuments(project.settings.attachments, resolveContextDocument).then(
      ({ items }) => {
        entry.items = new Map(items.filter(rereads).map((item) => [item.id, item]))
      },
      () => undefined
    )
    reads.set(project.folderId, entry)
    read = entry
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    read.done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LAUNCH_WAIT_MS)
    })
  ]).finally(() => clearTimeout(timer))
}

/** The project with the newest re-read text of each document in place of its saved copy. */
export function withFreshProjectDocuments<T extends LaunchProject>(project: T): T {
  const fresh = reads.get(project.folderId)?.items
  if (!fresh?.size) {
    return project
  }
  return {
    ...project,
    settings: {
      ...project.settings,
      attachments: project.settings.attachments.map((item) => fresh.get(item.id) ?? item)
    }
  }
}

export function clearProjectLaunchDocumentReads(): void {
  reads.clear()
}
