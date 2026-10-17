import { HANDOFF_FILE_MAX_BYTES } from './console-handoff-contract'
import {
  FollowUpException,
  type FollowUpDeliveryContext
} from './session-follow-up-delivery-contract'
import { readFollowUpFileSnapshot } from './session-follow-up-file-snapshot'
import type { FollowUpReaskPlan } from './session-follow-up-reask-plan'
import type { SessionFollowUpRecipient, SessionFollowUpRule } from './session-follow-up-rule'

export function isFollowUpReask(
  ctx: FollowUpDeliveryContext,
  rule: SessionFollowUpRule,
  recipient: SessionFollowUpRecipient
): boolean {
  return !!(
    rule.reask &&
    recipient.threadId &&
    (recipient.round ?? 1) > 1 &&
    ctx.hub.get &&
    ctx.hub.respond &&
    ctx.hub.returnFile
  )
}

function roundFileName(name: string, round: number): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  const suffix = ` (round ${round})${extension}`
  return `${(dot > 0 ? name.slice(0, dot) : name).slice(0, 255 - suffix.length)}${suffix}`
}

async function preparePlan(
  ctx: FollowUpDeliveryContext,
  rule: SessionFollowUpRule,
  recipient: SessionFollowUpRecipient
): Promise<FollowUpReaskPlan> {
  const threadId = recipient.threadId!
  const saved = ctx
    .current()
    ?.recipients.find((entry) => entry.employeeId === recipient.employeeId)?.reaskPlan
  if (saved?.operationId === recipient.operationId && saved.threadId === threadId) {
    return saved
  }
  const detail = await ctx.hub.get!({ threadId })
  const files: FollowUpReaskPlan['files'] = []
  for (const [index, pin] of (rule.files ?? []).entries()) {
    if (pin.generatedKind === 'transcript') {
      continue
    }
    const current = detail.files.find((file) => file.current && file.name === pin.name)
    if (current?.sha256 === pin.sha256 && pin.name !== rule.summaryFile) {
      continue
    }
    // The relay's return route caps files at 10 MiB; larger revisions need a new upload name.
    const largeRevision = current && pin.size > HANDOFF_FILE_MAX_BYTES
    files.push({
      index,
      name: largeRevision ? roundFileName(pin.name, recipient.round!) : pin.name,
      ...(current && !largeRevision ? { baseVersionId: current.id } : {})
    })
  }
  const plan: FollowUpReaskPlan = {
    operationId: recipient.operationId,
    threadId,
    note: `Updated after review notes (round ${recipient.round}).${rule.request?.description ? `\n\n${rule.request.description}` : ''}`.slice(
      0,
      8192
    ),
    files
  }
  const latest = ctx.current()
  if (!latest) {
    throw new Error('The saved request changed before delivery.')
  }
  // Persist the bases and names before any write; current hub versions can change during a replay.
  await ctx.save({
    ...latest,
    recipients: latest.recipients.map((entry) =>
      entry.employeeId === recipient.employeeId ? { ...entry, reaskPlan: plan } : entry
    )
  })
  return plan
}

export async function sendFollowUpReask(
  ctx: FollowUpDeliveryContext,
  rule: SessionFollowUpRule,
  recipient: SessionFollowUpRecipient
): Promise<{ thread_id?: string }> {
  const plan = await preparePlan(ctx, rule, recipient)
  for (const item of plan.files) {
    if (!ctx.current()) {
      throw new Error('The saved request changed during delivery.')
    }
    const pin = rule.files?.[item.index]
    if (!pin) {
      throw new FollowUpException('files-changed', item.name)
    }
    const bytes = await readFollowUpFileSnapshot(pin, ctx.bytes)
    if (bytes.sha256 !== pin.sha256 || bytes.size !== pin.size) {
      throw new FollowUpException('files-changed', pin.name)
    }
    const input = {
      threadId: plan.threadId,
      file: { ...bytes, name: item.name },
      note: plan.note,
      operationId: `${plan.operationId}_v${item.index}`
    }
    if (!ctx.current()) {
      throw new Error('The saved request changed during delivery.')
    }
    await (item.baseVersionId
      ? ctx.hub.returnFile!({ ...input, baseVersionId: item.baseVersionId })
      : ctx.hub.uploadThreadFile(input))
  }
  if (!ctx.current()) {
    throw new Error('The saved request changed during delivery.')
  }
  return ctx.hub.respond!({
    threadId: plan.threadId,
    kind: 'status',
    note: plan.note,
    operationId: plan.operationId
  })
}
