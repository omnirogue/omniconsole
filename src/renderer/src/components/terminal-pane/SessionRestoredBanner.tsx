import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'

export const SESSION_RESTORED_BANNER_TEXT = '--- session restored ---'
export const SESSION_RESUME_UNAVAILABLE_BANNER_TEXT =
  '--- previous session unavailable, started fresh ---'
export const SESSION_HELD_BANNER_TEXT = '--- resumes when you open this tab ---'
export const SESSION_DUPLICATE_BANNER_TEXT = '--- already running in another tab ---'
export const SESSION_STARTING_BANNER_TEXT = '--- starting… ---'

const BANNER_TEXT_BY_REASON: Record<SessionRestoredBannerReason, string> = {
  restored: SESSION_RESTORED_BANNER_TEXT,
  'resume-unavailable': SESSION_RESUME_UNAVAILABLE_BANNER_TEXT,
  held: SESSION_HELD_BANNER_TEXT,
  duplicate: SESSION_DUPLICATE_BANNER_TEXT,
  starting: SESSION_STARTING_BANNER_TEXT
}

type SessionRestoredBannerProps = {
  visible: boolean
  reason?: SessionRestoredBannerReason
}

export function SessionRestoredBanner({
  visible,
  reason = 'restored'
}: SessionRestoredBannerProps): React.JSX.Element | null {
  if (!visible) {
    return null
  }

  return (
    <div className="session-restored-banner">{BANNER_TEXT_BY_REASON[reason]}</div>
  )
}
