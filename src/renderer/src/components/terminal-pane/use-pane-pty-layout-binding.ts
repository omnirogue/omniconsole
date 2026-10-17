import { useCallback, type Dispatch, type SetStateAction } from 'react'

export function usePanePtyLayoutBinding(
  writeBinding: (paneId: number, ptyId: string | null, repairActiveLeaf: boolean) => void,
  setPaneLayoutRevision: Dispatch<SetStateAction<number>>
): (paneId: number, ptyId: string | null) => void {
  return useCallback(
    (paneId: number, ptyId: string | null): void => {
      writeBinding(paneId, ptyId, false)
      // Reattaching the same saved PTY changes the live ref even when persistence is a no-op.
      setPaneLayoutRevision((revision) => revision + 1)
    },
    [writeBinding, setPaneLayoutRevision]
  )
}
