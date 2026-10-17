import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionFollowUpDeliverables } from '../../../../shared/session-follow-up-rule'

export const NEXT_STEP_SUMMARY_MAX_CHARS = 240

/** What the dialog already knows about the session; Details shows it instead of asking. */
export type NextStepOutcomeFacts = {
  session: SidebarSession
  workspacePath: string | null
  branch: string | null
  repoId: string | null
  repoName: string | null
  /** Provider model the session currently runs, when its hooks reported one. */
  model: string | null
  /** The agent's last completed answer, shortened for a caption. */
  summary: string | null
  task: { id: string; title: string } | null
  /** The run's declared deliverables, when a chain step produced this session. */
  defaultDeliverables: SessionFollowUpDeliverables | null
}

/** The last two segments of a path — enough to recognise a folder at a glance. */
export function folderGlance(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.slice(-2).join('/') || path
}

/** One paragraph of the last answer: whitespace folded, cut on a word, ellipsis when cut. */
export function summarizeAssistantMessage(
  text: string | null | undefined,
  max = NEXT_STEP_SUMMARY_MAX_CHARS
): string | null {
  const folded = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!folded) {
    return null
  }
  if (folded.length <= max) {
    return folded
  }
  const cut = folded.slice(0, max)
  const word = cut.lastIndexOf(' ')
  return `${(word > max / 2 ? cut.slice(0, word) : cut).trimEnd()}…`
}
