/**
 * Tag, hide and snooze through the organization change path: what a session holds now and
 * how each change applies, using the same per-device stores the sidebar's own controls use.
 */

import type { createSessionTagsStore } from '@/store/session-tags'
import type { createWaitLaterStore } from '@/store/wait-later-store'
import {
  organizationValueAt,
  type OrganizationChange,
  type OrganizationChangeKind,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import type { SessionFolderCliStores } from './session-folder-cli-op-helpers'
import { sessionTagIds } from './session-tags'
import { isWaitingUntil } from './wait-later'

export type OrganizationViewStores = {
  tags?: ReturnType<typeof createSessionTagsStore>
  waitLater?: ReturnType<typeof createWaitLaterStore>
  /** The tag a session shows with none chosen for it (its company), so tagging keeps it. */
  automaticTag?: (sessionKey: string) => string | null
}

type Stores = SessionFolderCliStores & OrganizationViewStores

export type OrganizationViewRead = { known: true; value: unknown } | { known: false }

const VIEW_KINDS: ReadonlySet<OrganizationChangeKind> = new Set([
  'tag',
  'untag',
  'hide',
  'unhide',
  'snooze'
])

export function isOrganizationViewKind(kind: OrganizationChangeKind): boolean {
  return VIEW_KINDS.has(kind)
}

/** The row's own key in the hidden list and the wait store, as the sidebar files them. */
function conversationKey(sessionKey: string): string {
  return `conversation:${sessionKey}`
}

function tagIdsOf(stores: Stores, sessionKey: string): string[] {
  return sessionTagIds(
    stores.tags!.getState().data,
    sessionKey,
    stores.automaticTag?.(sessionKey) ?? null
  )
}

/** Tag kinds: whether it has the tag; hide: whether it is hidden; snooze: wake time or null. */
export function readOrganizationViewValue(
  kind: OrganizationChangeKind,
  target: OrganizationTarget,
  stores: Stores,
  value: unknown
): OrganizationViewRead {
  const session = target.sessionKey
  if (!session) {
    return { known: false }
  }
  switch (kind) {
    case 'tag':
    case 'untag':
      return stores.tags?.getState().loaded && typeof value === 'string'
        ? { known: true, value: tagIdsOf(stores, session).includes(value) }
        : { known: false }
    case 'hide':
    case 'unhide': {
      const { hidden } = stores.view.getState().view
      return {
        known: true,
        value: hidden.includes(conversationKey(session)) || hidden.includes(`session:${session}`)
      }
    }
    case 'snooze': {
      if (!stores.waitLater) {
        return { known: false }
      }
      const until = stores.waitLater.getState().view.until[conversationKey(session)]
      return { known: true, value: isWaitingUntil(until, new Date()) ? Date.parse(until!) : null }
    }
    case 'move':
    case 'save':
    case 'archive':
    case 'unarchive':
    case 'delete':
    case 'title':
    case 'finish-action':
    case 'sleep':
    case 'folder.create':
    case 'folder.rename':
    case 'folder.move':
    case 'folder.delete':
    case 'folder.color':
    case 'folder.reorder':
    case 'folder.project':
      return { known: false }
  }
}

function applyTags(change: OrganizationChange, stores: Stores): string | null {
  const store = stores.tags
  if (!store) {
    return 'Tags are not available in this window.'
  }
  const data = store.getState().data
  const known = new Set(data.tags.map((tag) => tag.id))
  const assignments = { ...data.assignments }
  for (const [index, target] of change.targets.entries()) {
    const id = organizationValueAt(change, index)
    if (typeof id !== 'string' || !known.has(id)) {
      return `No tag ${JSON.stringify(id)} exists. Nothing changed.`
    }
    const key = target.sessionKey!
    const current = Object.hasOwn(assignments, key) ? assignments[key]! : tagIdsOf(stores, key)
    assignments[key] =
      change.kind === 'tag'
        ? [...new Set([...current, id])]
        : current.filter((entry) => entry !== id)
  }
  return store.getState().save({ ...data, assignments })
    ? null
    : (store.getState().error ?? 'Could not save the tags.')
}

/** Applies one tag, hide or snooze change to all its targets; the refusal, if any. */
export function applyOrganizationViewChange(
  change: OrganizationChange,
  stores: Stores
): string | null {
  const keys = change.targets.map((target) => target.sessionKey!)
  switch (change.kind) {
    case 'tag':
    case 'untag':
      return applyTags(change, stores)
    case 'hide':
    case 'unhide': {
      // Why the value wins: an Undo puts back what each target was, hidden or not.
      const hiddenAt = (index: number): boolean => {
        const value = organizationValueAt(change, index)
        return typeof value === 'boolean' ? value : change.kind === 'hide'
      }
      const view = stores.view.getState()
      view.setHiddenMany(keys.filter((_key, index) => hiddenAt(index)).map(conversationKey), true)
      view.setHiddenMany(keys.filter((_key, index) => !hiddenAt(index)).map(conversationKey), false)
      return null
    }
    case 'snooze': {
      const waitLater = stores.waitLater
      if (!waitLater) {
        return 'Snooze is not available in this window.'
      }
      change.targets.forEach((target, index) => {
        const until = organizationValueAt(change, index)
        waitLater
          .getState()
          .setUntil(
            conversationKey(target.sessionKey!),
            typeof until === 'number' ? new Date(until) : null
          )
      })
      return null
    }
    case 'move':
    case 'save':
    case 'archive':
    case 'unarchive':
    case 'delete':
    case 'title':
    case 'finish-action':
    case 'sleep':
    case 'folder.create':
    case 'folder.rename':
    case 'folder.move':
    case 'folder.delete':
    case 'folder.color':
    case 'folder.reorder':
    case 'folder.project':
      return `No change path applies a ${change.kind} here.`
  }
}

/** A tag named by id or (case-insensitive) name, as its id; throws, naming the tags there are. */
export function resolveOrganizationTagRef(ref: unknown, stores: OrganizationViewStores): string {
  const tags = stores.tags?.getState().data.tags ?? []
  const wanted = typeof ref === 'string' ? ref.trim() : ''
  const tag =
    tags.find((entry) => entry.id === wanted) ??
    tags.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase())
  if (!tag) {
    throw new Error(
      `No tag named ${JSON.stringify(wanted)}. Tags: ${tags.map((entry) => entry.name).join(', ') || 'none'}. Nothing changed.`
    )
  }
  return tag.id
}
