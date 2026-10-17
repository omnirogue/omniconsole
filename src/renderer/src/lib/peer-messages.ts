import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { BACKOFFICE_POLLING } from '../../../shared/backoffice-polling-cadence'
import { BackofficeNotModified } from './backoffice-not-modified'
import type { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import {
  PEER_MESSAGE_ID,
  peerMessageProjectList,
  peerMessageThreadPage,
  type PeerMessageThread,
  type PeerMessageThreadPage
} from '../../../shared/peer-message-contract'

/** Member-scoped peer feeds. Reading never sends, joins or acknowledges a message. */
const requests = new PrioritySemaphore(BACKOFFICE_POLLING.peerMaxInFlight)
const ROOT = '/api/estate/peers'
const PAGE_LIMIT = '20'
const HTTP_STATUS = /HTTP (\d{3})/

export async function readPeerFeed<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  skipUnchanged = false
): Promise<z.infer<T>> {
  const feed = window.api?.backoffice?.feed
  if (typeof feed !== 'function') {
    throw new WorkflowRequestError({
      code: 'capability_unavailable',
      message: translate(
        'backofficeWork.peerMessagesUnavailable',
        'This build of OmniConsole does not read peer messages.'
      )
    })
  }
  const release = await requests.acquire(0)
  let result
  try {
    result = await feed({ path: ROOT + path })
  } finally {
    release()
  }
  if (!result.ok) {
    // Why: the feed answers a sentence, not a status; the HTTP code inside it is the one fact
    // that tells a route the server lacks (404/405) from a server that failed.
    const status = Number(HTTP_STATUS.exec(result.message)?.[1])
    throw new WorkflowRequestError({
      code: 'backoffice_refused',
      message: result.message,
      ...(Number.isFinite(status) ? { status } : {})
    })
  }
  if (result.notModified && skipUnchanged) {
    throw new BackofficeNotModified()
  }
  const parsed = schema.safeParse(result.body)
  if (!parsed.success) {
    throw new Error('The message feed could not be verified. Refresh to try again.')
  }
  return parsed.data
}

function query(projectId: string, cursor?: string, view?: 'archived'): string {
  const params = new URLSearchParams({ project_id: projectId, limit: PAGE_LIMIT })
  if (cursor) {
    params.set('cursor', cursor)
  }
  if (view) {
    params.set('view', view)
  }
  return params.toString()
}

function peerId(value: string): string {
  if (!PEER_MESSAGE_ID.test(value)) {
    throw new Error('That is not a peer message id.')
  }
  return value
}

export async function peerMessageProjects(): Promise<{ id: string; name: string }[]> {
  return (await readPeerFeed('/projects', peerMessageProjectList)).projects
}

export async function peerMessageThreads(
  projectId: string,
  cursor?: string,
  skipUnchanged = false,
  view?: 'archived'
): Promise<PeerMessageThreadPage> {
  const project = peerId(projectId)
  const page = await readPeerFeed(
    `/threads?${query(project, cursor ? peerId(cursor) : undefined, view)}`,
    peerMessageThreadPage,
    skipUnchanged
  )
  if (page.threads.some((thread) => thread.project_id !== project)) {
    throw new Error('Conversation scope mismatch.')
  }
  return page
}

/** Store-facing delta seam; the reader retains projects skipped by this refresh. */
export function readPeerMessages(reader: { read: () => Promise<PeerMessageThread[]> }) {
  return reader.read()
}
