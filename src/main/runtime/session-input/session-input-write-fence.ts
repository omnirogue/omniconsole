import type { WriteFence } from '../../pty/guarded-pty-write'
import type { SessionInputDeliveryContext } from './session-input-delivery-context'

/** Queue cancellation must close an owning daemon's latch even while its request is in flight. */
export function sessionInputWriteFence(
  ctx: SessionInputDeliveryContext,
  fence: WriteFence
): WriteFence {
  return {
    token: fence.token,
    isRevoked: () => ctx.signal.aborted || fence.isRevoked(),
    ...(fence.onClose
      ? {
          onClose: (invalidate: () => void) => {
            const unsubscribe = fence.onClose!(invalidate)
            ctx.signal.addEventListener('abort', invalidate, { once: true })
            if (ctx.signal.aborted) {
              invalidate()
            }
            return () => {
              ctx.signal.removeEventListener('abort', invalidate)
              unsubscribe()
            }
          }
        }
      : {})
  }
}
