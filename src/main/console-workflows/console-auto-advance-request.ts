import type { ConsoleAutoAdvancePreference } from '../../shared/console-auto-advance'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { sanitizeConsoleWorkflowText } from '../backoffice/console-workflow-person'

/** Same refusal shape as every other console local operation; never leaks protected text. */
export function consoleAutoAdvanceRequest(
  read: () => ConsoleAutoAdvancePreference
): ConsoleWorkflowResult<ConsoleAutoAdvancePreference> {
  try {
    return { ok: true, data: read() }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'auto_advance_refused',
        message: sanitizeConsoleWorkflowText(
          error instanceof Error ? error.message : 'The auto-advance preference is unavailable.'
        ).slice(0, 1500)
      }
    }
  }
}
