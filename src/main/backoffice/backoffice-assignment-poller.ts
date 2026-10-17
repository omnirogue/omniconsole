/**
 * Assignment pings: poll the member todo feed and announce NEW task ids.
 *
 * Main owns the polling (base URL + future bearer live here); the renderer
 * owns delivery (its notifications pipeline carries permission probing,
 * burst cooldown, and sound settings). Honesty rules: the first successful
 * fetch is a silent BASELINE (restart must not re-announce the whole list),
 * failures reset nothing and announce nothing, and a base-URL change starts
 * a fresh baseline (different backoffice, different world).
 */

import type { WebContents } from 'electron'

import type { BackofficeAssignmentEvent } from '../../shared/backoffice-work-types'
import { getBackofficeSnapshot } from './backoffice-config'
import { fetchBackofficeTodo } from './backoffice-work'

export type { BackofficeAssignmentEvent } from '../../shared/backoffice-work-types'

const POLL_INTERVAL_MS = 60_000

let timer: NodeJS.Timeout | null = null
let baselineBaseUrl: string | null = null
let knownTaskIds: Set<string> | null = null
let getTargets: () => readonly WebContents[] = () => []

async function tick(): Promise<void> {
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return
  }
  if (snapshot.baseUrl !== baselineBaseUrl) {
    baselineBaseUrl = snapshot.baseUrl
    knownTaskIds = null
  }
  const result = await fetchBackofficeTodo()
  if (!result.ok) {
    return
  }
  const currentIds = new Set(result.items.map((item) => item.task_id))
  if (knownTaskIds === null) {
    knownTaskIds = currentIds // silent baseline
    return
  }
  const fresh = result.items.filter((item) => !knownTaskIds!.has(item.task_id))
  knownTaskIds = currentIds
  if (fresh.length === 0) {
    return
  }
  const event: BackofficeAssignmentEvent = {
    baseUrl: result.baseUrl,
    items: fresh.map(({ task_id, title, company_slug, due_date }) => ({
      task_id,
      title,
      company_slug,
      due_date
    }))
  }
  for (const contents of getTargets()) {
    if (!contents.isDestroyed()) {
      contents.send('backoffice:assignments', event)
    }
  }
}

export function startBackofficeAssignmentPoller(
  targets: () => readonly WebContents[]
): () => void {
  getTargets = targets
  if (timer === null) {
    timer = setInterval(() => {
      void tick().catch(() => undefined)
    }, POLL_INTERVAL_MS)
    timer.unref?.()
  }
  return () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}
