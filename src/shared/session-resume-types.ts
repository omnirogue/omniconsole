/** What `omni session resume --ref` answers, applied or as a dry run. */

import type { ConversationProfile } from './conversation-resume-command'
import type { SessionManageActionResult } from './session-manage-types'

export type SessionResumeOutcome = 'already-open' | 'restarted' | 'resumed' | 'adopted'

export type SessionResumeResult = SessionManageActionResult & {
  ref: string
  /** Absent on a dry run. */
  outcome?: SessionResumeOutcome
  paneKey?: string | null
  tabId?: string | null
  terminal?: string
  /** Where it reopens (or would): the folder and profile its transcript records. */
  cwd?: string
  profile?: ConversationProfile | null
}
