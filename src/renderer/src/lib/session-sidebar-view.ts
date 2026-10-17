import { z } from 'zod'
import { SESSION_WORKERS_KEY_PREFIX } from './session-sidebar-worker-keys'
import { SESSION_SIDEBAR_SORTS, withKnownSessionSidebarSort } from './session-sidebar-sort'

export function sessionFolderGroupKey(folderId: string): string {
  return `folder:${folderId}`
}

const keyListSchema = z.array(z.string().min(1))

/** The values `groupBy` has always held; older builds reject a view whose groupBy is anything else. */
const SAVED_GROUP_BY = ['status', 'task'] as const
/** Group-by views (session-sidebar-lens), saved in their own field that older builds drop. */
export const SESSION_SIDEBAR_LENS_VALUES = [
  // Why not 'status': that is already groupBy's saved name for the folder tree.
  'state',
  'request',
  'project',
  'company',
  'computer',
  'blocking'
] as const
export const SESSION_SIDEBAR_GROUP_BY = [...SAVED_GROUP_BY, ...SESSION_SIDEBAR_LENS_VALUES] as const
export type SessionSidebarGroupBy = (typeof SESSION_SIDEBAR_GROUP_BY)[number]
/** Group keys of the Group-by views' groups (session-sidebar-lens). */
export const SESSION_LENS_GROUP_PREFIX = 'by:'

const viewSchema = z.object({
  version: z.literal(1),
  collapsed: keyListSchema,
  hidden: keyListSchema,
  order: keyListSchema,
  rowOrder: keyListSchema.optional(),
  archived: keyListSchema.optional(),
  /** Exact operation receipts saved atomically with a transfer archive batch. */
  transferArchiveReceipts: z.record(z.string(), keyListSchema).optional(),
  /** Conversations the person deleted (view keys): gone from the list until a tab for them is open again. */
  deleted: keyListSchema.optional(),
  /** When each archived row was put away (view key → epoch ms); absent for rows archived before it was kept. */
  archivedAt: z.record(z.string(), z.number().finite()).optional(),
  /** Explicit Unarchive keeps the session visible until the person archives it again. */
  autoArchiveKeep: keyListSchema.optional(),
  /** Reversible filing receipts; never a substitute for the retained source history. */
  autoArchiveLog: z
    .array(
      z.object({
        key: z.string(),
        proof: z.string(),
        at: z.number().finite(),
        restoredAt: z.number().finite().optional()
      })
    )
    .optional(),
  /** Conversation rows whose details block is open (view keys); collapsed when absent. */
  expandedRows: keyListSchema.optional(),
  snoozedUntil: z.record(z.string(), z.number().finite()).optional(),
  /** A group's chosen color by group key (see session-folder-colors); rows inside take it on. */
  colors: z.record(z.string(), z.string()).optional(),
  companyVisibility: z.record(z.string(), z.boolean()).optional(),
  /** 'task' collapses tasked sessions under one group per task. */
  groupBy: z.enum(SAVED_GROUP_BY).optional(),
  /** A Group-by view; when set it wins over groupBy (see sessionSidebarGroupBy). */
  lens: z.enum(SESSION_SIDEBAR_LENS_VALUES).optional(),
  /** What older builds read: this computer ('local', Home, the default), 'all', or one host's id. */
  hostScope: z.string().min(1).optional(),
  /** Whose sessions show: host kinds (Home, paired runtimes, SSH) less hosts turned off; wins over hostScope. */
  hostFilter: z
    .object({ kinds: z.array(z.string()), hiddenHostIds: z.array(z.string()).optional() })
    .optional(),
  /** Row height: one line per row (`compact`, the default) or title + agent + status line. */
  density: z.enum(['compact', 'comfortable']).optional(),
  /** Saved Sessions' eye: every saved folder opens so all its sessions show; off by default. */
  savedShowAll: z.boolean().optional(),
  /** The five-line focus view (`focus`, the default) or the full tree. */
  layout: z.enum(['focus', 'full']).optional(),
  /** Separate from layout so older builds retain the rest of the saved view. */
  flat: z.boolean().optional(),
  /** Row order inside every group (session-sidebar-sort); older builds drop it. */
  sort: z.enum(SESSION_SIDEBAR_SORTS).optional(),
  /** Fold an idle open folder after this many seconds; 0 turns it off, absent means the default. */
  autoCollapseSeconds: z.number().int().min(0).max(3600).optional(),
  /** Zero disables both automatic archive paths; independent of folding groups. */
  doneArchiveMinutes: z.number().int().min(0).max(43200).optional(),
  doneArchiveClocks: z
    .record(
      z.string(),
      z.object({
        revision: z.string().max(4000),
        since: z.number().finite().positive()
      })
    )
    .optional(),
  /** How long each blank session on an unavailable SSH host has stayed so (the steward's rule). */
  unreachableBlankClocks: z
    .record(
      z.string(),
      z.object({
        revision: z.string().max(4000),
        since: z.number().finite().positive()
      })
    )
    .optional(),
  /**
   * Conversations whose Outcome / Up next header the person (or an auto-fold) closed (true) or
   * opened (false), by view key. Absent = the header decides from the chain.
   */
  workHeaderCollapsed: z.record(z.string(), z.boolean()).optional()
})

export type SessionSidebarDensity = NonNullable<z.infer<typeof viewSchema>['density']>
export type SessionSidebarLayout = NonNullable<z.infer<typeof viewSchema>['layout']>

/** Per-device presentation of the Sessions tree: folded groups, hidden groups, and their order. */
export type SessionSidebarView = z.infer<typeof viewSchema>

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)]
}

export function emptySessionSidebarView(): SessionSidebarView {
  return { version: 1, collapsed: [], hidden: [], order: [] }
}

export function parseSessionSidebarView(value: unknown): SessionSidebarView {
  const parsed = viewSchema.parse(withKnownSessionSidebarSort(withSavedGroupBy(value)))
  return {
    ...parsed,
    collapsed: unique(parsed.collapsed),
    hidden: unique(parsed.hidden),
    order: unique(parsed.order)
  }
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value)

/**
 * Early builds of the Group-by views saved them in groupBy: read those as the lens. A value
 * neither field knows (a newer build's) reads as the default instead of failing the whole view.
 */
function withSavedGroupBy(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value
  }
  const { groupBy, lens, ...rest } = value as { groupBy?: unknown; lens?: unknown }
  const savedLens = isOneOf(SESSION_SIDEBAR_LENS_VALUES, lens)
    ? lens
    : isOneOf(SESSION_SIDEBAR_LENS_VALUES, groupBy)
      ? groupBy
      : undefined
  return {
    ...rest,
    ...(isOneOf(SAVED_GROUP_BY, groupBy) ? { groupBy } : {}),
    ...(savedLens ? { lens: savedLens } : {})
  }
}

/** The grouping the list shows: the Group-by view when one is chosen, else groupBy. */
export function sessionSidebarGroupBy(
  view: Pick<SessionSidebarView, 'groupBy' | 'lens'>
): SessionSidebarGroupBy {
  return view.lens ?? view.groupBy ?? 'status'
}

/** Choose a grouping; a Group-by view clears groupBy so an older build shows status. */
export function withSessionSidebarGroupBy(
  view: SessionSidebarView,
  groupBy: SessionSidebarGroupBy
): SessionSidebarView {
  const { groupBy: _groupBy, lens: _lens, ...rest } = view
  return isOneOf(SESSION_SIDEBAR_LENS_VALUES, groupBy)
    ? { ...rest, lens: groupBy }
    : { ...rest, groupBy }
}

/** The Sessions tree's Waiting group: collapsed unless the person opened it. */
export const SESSION_WAITING_GROUP_KEY = 'waiting'
/** Workflows never started: the person's own, so open by default. */
export const SESSION_DRAFTS_GROUP_KEY = 'drafts'
export const SESSION_COMPLETED_GROUP_KEY = 'completed'
export const SESSION_ARCHIVED_GROUP_KEY = 'archived'
export const SESSION_HIDDEN_GROUP_KEY = 'hidden-conversations'
const CLOSED_BY_DEFAULT = new Set([
  'stopped',
  'saved-sessions',
  SESSION_WAITING_GROUP_KEY,
  SESSION_COMPLETED_GROUP_KEY,
  SESSION_ARCHIVED_GROUP_KEY,
  SESSION_HIDDEN_GROUP_KEY
])

const CLOSED_PREFIXES = ['task:', 'folder:', SESSION_WORKERS_KEY_PREFIX, SESSION_LENS_GROUP_PREFIX]

// Why: task groups, Group-by groups, folders and an agent's workers exist to fold dozens of sessions into one line,
// so they start folded; a folded one still lists what needs the person (sessionGroupListedRows).
function closedByDefault(key: string): boolean {
  return CLOSED_BY_DEFAULT.has(key) || CLOSED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** Whether a group reads as collapsed in this view; Waiting, folders and task groups start closed. */
export function isSessionGroupCollapsed(view: SessionSidebarView, key: string): boolean {
  return closedByDefault(key)
    ? !view.collapsed.includes(`${key}:open`)
    : view.collapsed.includes(key)
}

export function setSessionGroupsCollapsed(
  view: SessionSidebarView,
  keys: readonly string[],
  collapsed: boolean
): SessionSidebarView {
  const next = new Set(view.collapsed)
  for (const key of keys) {
    // Why: Waiting starts closed, so its saved mark says "opened" rather than "collapsed".
    const startsClosed = closedByDefault(key)
    const mark = startsClosed ? `${key}:open` : key
    const add = startsClosed ? !collapsed : collapsed
    if (add) {
      next.add(mark)
    } else {
      next.delete(mark)
    }
  }
  return { ...view, collapsed: [...next] }
}

/**
 * Saved Sessions' eye: on opens every key in `savedKeys`; off folds all but Saved Sessions
 * ('saved-sessions') itself, so opening it lists only its folders.
 */
export function withSavedShowAll(
  view: SessionSidebarView,
  on: boolean,
  savedKeys: readonly string[]
): SessionSidebarView {
  const next = on
    ? setSessionGroupsCollapsed(view, savedKeys, false)
    : setSessionGroupsCollapsed(
        view,
        savedKeys.filter((key) => key !== 'saved-sessions'),
        true
      )
  return { ...next, savedShowAll: on }
}

export function toggleSessionGroupCollapsed(
  view: SessionSidebarView,
  key: string
): SessionSidebarView {
  return setSessionGroupsCollapsed(view, [key], !isSessionGroupCollapsed(view, key))
}

/** Stamp (or clear) when rows were archived, so the Archived list can say when each went. */
export function setSessionArchivedAt(
  view: SessionSidebarView,
  keys: readonly string[],
  archived: boolean,
  now: number
): SessionSidebarView {
  const archivedAt = { ...view.archivedAt }
  for (const key of keys) {
    if (!archived) {
      delete archivedAt[key]
    } else if (archivedAt[key] === undefined) {
      archivedAt[key] = now
    }
  }
  return { ...view, archivedAt }
}

/** Groups fold themselves after 5 idle seconds unless the person chose otherwise. */
export const DEFAULT_FOLDER_AUTO_COLLAPSE_SECONDS = 5

export function sessionFolderAutoCollapseSeconds(view: SessionSidebarView): number {
  return view.autoCollapseSeconds ?? DEFAULT_FOLDER_AUTO_COLLAPSE_SECONDS
}

/** The row density this view reads with; a view saved before the preference existed is compact. */
export function sessionSidebarDensity(view: SessionSidebarView): SessionSidebarDensity {
  return view.density ?? 'compact'
}

export function sessionSidebarLayout(
  view: Pick<SessionSidebarView, 'layout'>
): SessionSidebarLayout {
  return view.layout ?? 'focus'
}

/** Whether a row's details block is open in this view; rows start collapsed. */
export function isSessionRowExpanded(view: SessionSidebarView, key: string): boolean {
  return view.expandedRows?.includes(key) === true
}

export function setSessionRowExpanded(
  view: SessionSidebarView,
  key: string,
  expanded: boolean
): SessionSidebarView {
  const next = new Set(view.expandedRows ?? [])
  if (expanded) {
    next.add(key)
  } else {
    next.delete(key)
  }
  return { ...view, expandedRows: [...next] }
}

/** The saved fold of a conversation's work header, or undefined when nobody chose one. */
export function workHeaderCollapsedChoice(
  view: SessionSidebarView,
  key: string
): boolean | undefined {
  return view.workHeaderCollapsed?.[key]
}

export function setWorkHeaderCollapsed(
  view: SessionSidebarView,
  key: string,
  collapsed: boolean
): SessionSidebarView {
  return { ...view, workHeaderCollapsed: { ...view.workHeaderCollapsed, [key]: collapsed } }
}

export function setSessionGroupHidden(
  view: SessionSidebarView,
  key: string,
  hidden: boolean
): SessionSidebarView {
  const next = new Set(view.hidden)
  if (key.startsWith('session:') || key.startsWith('conversation:')) {
    const identity = key.slice(key.indexOf(':') + 1)
    next.delete(`session:${identity}`)
    next.delete(`conversation:${identity}`)
    key = `conversation:${identity}`
  }
  if (hidden) {
    next.add(key)
  } else {
    next.delete(key)
  }
  return { ...view, hidden: [...next] }
}

/**
 * Drafts split out of Waiting. An order saved before they did (or while no draft was on screen)
 * has no slot for them, so they take Waiting's: just ahead of it, where they used to be.
 */
function withDraftsSlot(order: readonly string[]): readonly string[] {
  const waiting = order.indexOf(SESSION_WAITING_GROUP_KEY)
  return waiting === -1 || order.includes(SESSION_DRAFTS_GROUP_KEY)
    ? order
    : [...order.slice(0, waiting), SESSION_DRAFTS_GROUP_KEY, ...order.slice(waiting)]
}

/** Order `keys` by the saved order; keys the user never placed keep their natural order at the end. */
export function orderSessionGroupKeys(keys: readonly string[], order: readonly string[]): string[] {
  const rank = new Map(withDraftsSlot(order).map((key, index) => [key, index] as const))
  const placed = keys.filter((key) => rank.has(key)).sort((a, b) => rank.get(a)! - rank.get(b)!)
  const unplaced = keys.filter((key) => !rank.has(key))
  return [...placed, ...unplaced]
}

/**
 * Drop `key` before/after `target` within the currently visible groups. The
 * saved order becomes the full visible sequence so a group that was never
 * placed by hand keeps the slot it was dropped into.
 */
export function moveSessionGroup(
  view: SessionSidebarView,
  args: {
    key: string
    target: string
    position: 'before' | 'after'
    visibleKeys: readonly string[]
  }
): SessionSidebarView {
  const { key, target, position } = args
  if (key === target || !args.visibleKeys.includes(key) || !args.visibleKeys.includes(target)) {
    return view
  }
  const sequence = orderSessionGroupKeys(args.visibleKeys, view.order).filter(
    (candidate) => candidate !== key
  )
  const targetIndex = sequence.indexOf(target)
  if (targetIndex === -1) {
    return view
  }
  sequence.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, key)
  // Why: groups not on screen (hidden, filtered) keep their relative placement after the visible ones.
  const invisible = view.order.filter((candidate) => !sequence.includes(candidate))
  return { ...view, order: [...sequence, ...invisible] }
}
