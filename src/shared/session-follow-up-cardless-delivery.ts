import { readFollowUpFileSnapshot } from './session-follow-up-file-snapshot'
import {
  HANDOFF_FILE_MAX_BYTES,
  type ExactHandoffFile,
  type HandoffSendCardless
} from './console-handoff-contract'
import type { SessionFollowUpRule } from './session-follow-up-rule'
import {
  FollowUpException,
  type FollowUpDeliveryContext
} from './session-follow-up-delivery-contract'

/**
 * A follow-up whose rule names no card (card-less handoffs on): nothing is uploaded to a
 * card; each person's thread is created with the exact bytes it carries.
 */
/**
 * The attachments one card-less create may carry, by request size: the transport caps a
 * file-carrying body at 14.1 MB of JSON, so the exact bytes that fit ride with the thread and
 * the rest are added to it one by one once it exists.
 */
export const CARDLESS_CREATE_BUDGET_CHARS = 13_000_000

export function partitionCardlessAttachments(
  files: readonly ExactHandoffFile[],
  budgetChars = CARDLESS_CREATE_BUDGET_CHARS
): { withCreate: ExactHandoffFile[]; afterwards: ExactHandoffFile[] } {
  const withCreate: ExactHandoffFile[] = []
  const afterwards: ExactHandoffFile[] = []
  let used = 0
  for (const file of files) {
    // Why: order is kept, so a replay partitions the same way and replays the same requests.
    if (
      file.size <= HANDOFF_FILE_MAX_BYTES &&
      afterwards.length === 0 &&
      used + file.contentBase64.length <= budgetChars
    ) {
      withCreate.push(file)
      used += file.contentBase64.length
    } else {
      afterwards.push(file)
    }
  }
  return { withCreate, afterwards }
}

/** The exact bytes of every captured pin, re-verified; null when the rule was cancelled meanwhile. */
export async function cardlessAttachments(
  ctx: FollowUpDeliveryContext,
  rule: SessionFollowUpRule
): Promise<ExactHandoffFile[] | null> {
  const files: ExactHandoffFile[] = []
  for (const pin of rule.files ?? []) {
    if (!ctx.current()) {
      return null
    }
    // Why: a re-read after a restart carries the source's own name; the package name is the pin's.
    const file = { ...(await readFollowUpFileSnapshot(pin, ctx.bytes)), name: pin.name }
    if (file.sha256 !== pin.sha256 || file.size !== pin.size) {
      throw new FollowUpException('files-changed', pin.name)
    }
    files.push(file)
  }
  return files
}

/**
 * One person's card-less request: the thread with the attachments that fit its request,
 * then the remaining files added under keys derived from the same operation id, so a
 * replay after an uncertain answer re-issues exactly the same requests.
 */
export async function sendCardlessWithFiles(
  ctx: Pick<FollowUpDeliveryContext, 'hub'> & { current?: () => unknown },
  common: Omit<HandoffSendCardless, 'attachments'>,
  files: readonly ExactHandoffFile[]
): Promise<{ thread_id?: string }> {
  const { withCreate, afterwards } = partitionCardlessAttachments(files)
  const assertCurrent = () => {
    if (ctx.current && !ctx.current()) {
      throw new Error('The sending account or saved request changed. Reopen it before retrying.')
    }
  }
  assertCurrent()
  const receipt = await ctx.hub.sendCardless({ ...common, attachments: withCreate })
  if (!receipt.thread_id) {
    return receipt
  }
  for (const [index, file] of afterwards.entries()) {
    assertCurrent()
    await ctx.hub.uploadThreadFile({
      threadId: receipt.thread_id,
      file,
      note: common.note,
      operationId: `${common.operationId}_f${index + 1}`
    })
  }
  return receipt
}
