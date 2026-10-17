import { translate } from '@/i18n/i18n'

type CreateReply = { requestId: string; error?: string }

export class RendererCreateReceipts<Reply extends CreateReply> {
  // Each bridge retains at most 256 successful replies for ten minutes.
  private readonly receipts = new Map<string, { reply: Reply; expiresAt: number }>()

  replay(
    request: { requestId: string; expiresAt?: number },
    isAlive: (reply: Reply) => boolean
  ): Reply | CreateReply | undefined {
    const now = Date.now()
    if (request.expiresAt !== undefined && request.expiresAt <= now) {
      return {
        requestId: request.requestId,
        error: translate('runtimeRpc.createRequestExpired', 'Create request expired')
      }
    }
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) {
        this.receipts.delete(id)
      }
    }
    const receipt = this.receipts.get(request.requestId)
    if (receipt && isAlive(receipt.reply)) {
      return receipt.reply
    }
    this.receipts.delete(request.requestId)
    return undefined
  }

  remember(reply: Reply): void {
    while (this.receipts.size >= 256) {
      this.receipts.delete(this.receipts.keys().next().value!)
    }
    this.receipts.set(reply.requestId, { reply, expiresAt: Date.now() + 10 * 60_000 })
  }
}
