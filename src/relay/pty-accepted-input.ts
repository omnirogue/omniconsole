import type { PtyAcceptedInputResult } from '../shared/pty-accepted-input'
import { isPtyIncarnationId } from '../shared/pty-incarnation'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../shared/terminal-input'

type InputOwner = { incarnationId: string; disposed?: boolean }

export async function acceptRelayPtyInput(args: {
  params: Record<string, unknown>
  getOwner: (id: string) => InputOwner | undefined
  write: (params: Record<string, unknown>) => boolean
  isCurrent?: () => boolean
}): Promise<PtyAcceptedInputResult> {
  const { id, data, incarnationId } = args.params
  if (typeof id !== 'string' || typeof data !== 'string' || !isPtyIncarnationId(incarnationId)) {
    return { accepted: false }
  }
  const owner = args.getOwner(id)
  if (
    !owner ||
    owner.disposed ||
    owner.incarnationId !== incarnationId ||
    args.isCurrent?.() === false
  ) {
    return { accepted: false }
  }
  try {
    const oversized = isTerminalInputTooLargeWithDeferredMeasurement(data)
    if (
      (typeof oversized === 'boolean' ? oversized : await oversized) ||
      args.getOwner(id) !== owner ||
      owner.disposed ||
      owner.incarnationId !== incarnationId ||
      args.isCurrent?.() === false
    ) {
      return { accepted: false }
    }
    return args.write(args.params) ? { accepted: true, incarnationId } : { accepted: false }
  } catch {
    return { accepted: false }
  }
}
