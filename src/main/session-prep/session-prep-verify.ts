import type { TuiAgent } from '../../shared/tui-agent'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import { addSessionPrepItemNotes } from './session-prep-item-folder'
import type { SessionPrepItemRecord } from './session-prep-records'

const ATTACHED =
  'Verify attached: a separate seat checks each Done when line when this session finishes.'
// Starts that may retry an unconfirmed binding before it is given up and said so.
const MAX_ATTEMPTS = 3

/**
 * Whether this launch owes a verify binding: any prepared session this computer runs that has Done
 * When lines — code, research, ads or support work, in a repository or a plain folder. Recorded on
 * the item BEFORE the launch is persisted, so a restart anywhere after the session exists still
 * binds it (`startSessionPrepVerify`, also from resume).
 */
export function sessionPrepVerifyAgent(
  ctx: SessionPrepLaunchContext,
  item: SessionPrepItemRecord,
  agent: TuiAgent,
  eligible: boolean
): TuiAgent | null {
  return eligible && ctx.host.attachVerify && (item.fields?.doneWhen.length ?? 0) > 0 ? agent : null
}

/**
 * Binds the launched session's Done When lines to a verify gate. It waits for the first turn, so it
 * runs beside the launch. `verifyPending` is cleared only on a confirmed result (bound, or refused
 * for good); a thrown or retryable outcome keeps it, and startup resumes it.
 */
export function startSessionPrepVerify(
  ctx: SessionPrepLaunchContext,
  item: SessionPrepItemRecord,
  agent: TuiAgent
): void {
  const doneWhen = item.fields?.doneWhen ?? []
  const launched = item.launched
  const attachVerify = ctx.host.attachVerify?.bind(ctx.host)
  if (!attachVerify || !doneWhen.length || !launched) {
    return
  }
  const attempts = (item.verifyPending?.attempts ?? 0) + 1
  item.verifyPending = { agent, attempts }
  const handle = launched.paneHandle
  void ctx
    .persist()
    .then(async () => {
      // A lookup that fails while terminals restore proves nothing; the binding is tried again.
      const paneKey =
        launched.paneKey ?? (handle ? await ctx.host.resolveTerminalPaneKey?.(handle) : null)
      if (paneKey && !launched.paneKey) {
        launched.paneKey = paneKey
        delete launched.paneIdentity
      }
      if (!paneKey) {
        return {
          done: false,
          note: "Verify not attached yet: the session's pane is not known yet; retried at the next start."
        }
      }
      const result = await attachVerify({
        worktreeId: launched.worktreeId,
        paneKey,
        title: item.fields?.title ?? item.planned.title,
        doneWhen,
        agent
      })
      if (result.attached) {
        return { done: true, note: ATTACHED }
      }
      return result.retryable
        ? {
            done: false,
            note: `Verify not attached yet: ${result.reason}; retried at the next start.`
          }
        : { done: true, note: `Verify not attached: ${result.reason}.` }
    })
    .catch((error: unknown) => ({
      done: false,
      note: `Verify not attached yet: ${error instanceof Error ? error.message : String(error)}; retried at the next start.`
    }))
    .then(async ({ done, note }) => {
      const exhausted = !done && attempts >= MAX_ATTEMPTS
      if (done) {
        delete item.verifyPending
      } else if (exhausted) {
        // Kept, not dropped: the obligation stays visible; only the automatic tries stop.
        item.verifyPending = { agent, attempts, exhausted: true }
      }
      addSessionPrepItemNotes(item, [
        exhausted
          ? `${note.replace('; retried at the next start.', '')} Stopped retrying after ${attempts} tries; add Verify from Up next.`
          : note
      ])
      await ctx.persist()
    })
    .catch(() => {
      // The note is advisory; the pending marker was saved before the attempt.
    })
}
