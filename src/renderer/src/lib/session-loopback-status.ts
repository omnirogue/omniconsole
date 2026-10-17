export type SessionLoopbackStatus = 'live' | 'stopped' | 'unverifiable'

export async function probeSessionLoopbackUrls(
  urls: readonly string[],
  hostId: string | null | undefined,
  probe?: (url: string) => Promise<SessionLoopbackStatus>
): Promise<ReadonlyMap<string, SessionLoopbackStatus>> {
  return new Map(
    await Promise.all(
      urls.map(async (url) => {
        // Client loopback can only answer for a session explicitly owned by this computer.
        const status =
          hostId === 'local' && probe
            ? await probe(url).catch(() => 'unverifiable' as const)
            : 'unverifiable'
        return [url, status] as const
      })
    )
  )
}
