import type { CleanupKeepReason } from './automatic-session-cleanup-protection'
/**
 * "Archive = pause" (Sal, 30 Sep): the window's archive-sleep controller and main's host reading
 * share these rules. A person's archive may put an idle local agent to sleep at once; every other
 * archive (CLI, a pane's agent, sync, the steward, automatic filing) only arms a 30-minute
 * out-of-view idle timer. Every sleep re-checks the same keeps (G1-G3, G5) right before it acts.
 */

import { z } from 'zod'
import type { OrganizationExecutor } from './session-organization-change'

/** How long an archived agent sits idle and out of view before a non-person archive sleeps it. */
export const ARCHIVE_SLEEP_IDLE_MS = 30 * 60 * 1000
/** G2: a reveal, a person attaching or a keystroke this recent keeps the agent awake. */
export const ARCHIVE_SLEEP_RECENT_TOUCH_MS = 10 * 60 * 1000

/** Who archived, from the change's executor; `unknown` for a path that names none. */
export const ARCHIVE_SLEEP_VIA = [
  'person',
  'cli',
  'pane',
  'sync',
  'steward',
  'auto-archive',
  'transfer',
  'app',
  'resume',
  'unknown'
] as const
export type ArchiveSleepVia = (typeof ARCHIVE_SLEEP_VIA)[number]

/** What made the sleep happen: a person's archive, their agent finishing, or the idle timer. */
export const ARCHIVE_SLEEP_TRIGGERS = ['archive', 'done', 'idle-timer'] as const
export type ArchiveSleepTrigger = (typeof ARCHIVE_SLEEP_TRIGGERS)[number]

/** The History line's reason for each trigger. */
export const ARCHIVE_SLEEP_REASONS: Record<ArchiveSleepTrigger, string> = {
  archive: 'Archived by a person while idle, out of view, with nothing pending',
  done: 'Archived by a person; its agent then finished with nothing pending',
  'idle-timer': 'Archived, then idle and out of view for 30 minutes with nothing pending'
}

export function archiveSleepViaOf(executor: OrganizationExecutor | undefined): ArchiveSleepVia {
  if (!executor) {
    return 'unknown'
  }
  switch (executor.kind) {
    case 'person':
    case 'cli':
    case 'pane':
    case 'sync':
      return executor.kind
    case 'app':
      return executor.feature === 'steward' ||
        executor.feature === 'auto-archive' ||
        executor.feature === 'transfer'
        ? executor.feature
        : 'app'
    case 'launch':
      return 'app'
  }
}

/** Why an archived agent keeps running. */
export type ArchiveSleepKeep =
  | CleanupKeepReason
  /** G1: awaiting-user, waiting-for-yes, a question card, or its last reply asks something. */
  | 'open-ask'
  /** G2: revealed, attached by a person or typed into within ARCHIVE_SLEEP_RECENT_TOUCH_MS. */
  | 'recent-touch'
  /** G3: its pane is on screen. */
  | 'visible'
  /** G5: a quit/live record of a mid-task agent, which interrupted restore must resume. */
  | 'interrupted-restore'
  /** Working, blocked, waiting, interrupted, failed, starting or unknown. */
  | 'not-idle'
  /** Queued, drafted, just typed in by the prompt queue, kept going, planned or awaited. */
  | 'pending'
  | 'not-local'
  /** A reading failed, or no source held its last reply as prose (G1 fails closed). */
  | 'unreadable'

/** main's reading for one archived pane (`sessionOrganization.archiveSleepReading`). */
export type ArchiveSleepHostReading = {
  clear: boolean
  keep?: ArchiveSleepKeep
  /** The Stage A1 state (`omni session list`), when one was read. */
  state?: string
}

const NUMBERED_LINE = /^\s*\d+\./
// Why strip these: markdown emphasis, quotes or a closing bracket after the question mark.
const TRAILING_CLOSERS = /[\s*_`"'”’)\]]+$/

/**
 * G1 from the words alone: the reply ends with a question, or lists at least two numbered lines
 * (a numbered question list). On 30 Sep a session holding three numbered questions read `done`
 * for 42 minutes, and Sal answered it 66 s after it was nearly stopped.
 */
export function isOpenAskText(text: string | null | undefined): boolean {
  if (!text) {
    return false
  }
  if (text.replace(TRAILING_CLOSERS, '').endsWith('?')) {
    return true
  }
  let numbered = 0
  for (const line of text.split(/\r?\n/)) {
    if (NUMBERED_LINE.test(line) && ++numbered >= 2) {
      return true
    }
  }
  return false
}

const paneKey = z.string().min(1).max(200)

export const ArchiveSleepReadingParamsSchema = z
  .object({ paneKey, tabId: paneKey, worktreeId: z.string().min(1).max(1000) })
  .strict()

/** One archive that put a local, idle agent to sleep (archive-sleeps-idle-agents.ts). */
export const ArchiveSleepNoteParamsSchema = z
  .object({
    sessionKey: z.string().min(1).max(1000),
    paneKey,
    tabId: paneKey,
    title: z.string().max(200),
    via: z.enum(ARCHIVE_SLEEP_VIA),
    trigger: z.enum(ARCHIVE_SLEEP_TRIGGERS),
    evidence: z.string().trim().min(1).max(1000)
  })
  .strict()

export type ArchiveSleepReadingParams = z.infer<typeof ArchiveSleepReadingParamsSchema>
export type ArchiveSleepNoteParams = z.infer<typeof ArchiveSleepNoteParamsSchema>
