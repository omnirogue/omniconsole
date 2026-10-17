import type { IPtyProvider } from '../providers/types'

/** A socket flush is not an owning PTY receipt. Legacy owners cannot clear a draft. */
export async function acknowledgeDaemonWrite(
  client: {
    request<T = unknown>(
      type: string,
      payload: { sessionId: string; data: string; requireAccepted?: boolean }
    ): Promise<T>
  },
  prepare: () => unknown,
  id: string,
  data: string,
  options?: { isCurrent?: () => boolean }
): Promise<boolean> {
  try {
    if (options?.isCurrent?.() === false) {
      return false
    }
    prepare()
    // Reuse the legacy write envelope: old owners perform the input once, in wire order,
    // and return {}. A new owner returns an explicit acceptance receipt. Never probe/replay.
    const result = await client.request<{ accepted?: boolean } | null>('write', {
      sessionId: id,
      data,
      requireAccepted: true
    })
    return result?.accepted === true && options?.isCurrent?.() !== false
  } catch {
    return false
  }
}

export async function settleProviderWrite(
  provider: IPtyProvider,
  id: string,
  data: string
): Promise<boolean> {
  return provider.writeWithSettlement
    ? await provider.writeWithSettlement(id, data)
    : provider.write(id, data) !== false
}
