import { SessionManageRefusal } from '../../../session-manage/session-manage-refusal'
import { SCREEN_DENY_KEY } from '../../../session-manage/session-prompt'

/** Only known single-key Claude/Codex menu commits; never arbitrary terminal input. */
export function sessionAnswerKeystrokes(value: string): string[] {
  if (/^[1-9]$/.test(value) || value === 'y' || value === SCREEN_DENY_KEY) {
    return [value]
  }
  throw new SessionManageRefusal(
    'The answer is not a single known menu keystroke, so nothing was typed. Answer it in its own session.'
  )
}
