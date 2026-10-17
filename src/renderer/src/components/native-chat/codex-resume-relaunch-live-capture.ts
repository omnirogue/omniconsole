import { subscribeToPtyData } from '../terminal-pane/pty-data-sidecar-subscriptions'

/**
 * Bytes the replacement pty emitted after the relaunch bound it — nothing else.
 * Why this and not a buffer read: the mounted xterm and main's per-pty buffer are
 * both seeded with the killed TUI's last frame, and a resumed transcript can quote
 * anything (the resume line, an old header), so no read of those buffers can prove
 * which process painted a header. A sidecar on the new pty's data channel sees
 * only what that process writes; the startup box is the first thing Codex paints.
 * Registering it also declares delivery interest, so a hidden pane still receives
 * the bytes instead of main's hidden-delivery gate dropping them.
 */
export type RelaunchLiveCapture = {
  ptyId: string
  /** Raw bytes so far (ANSI intact); capped, keeping the head where the box is. */
  text: () => string
  dispose: () => void
}

const LIVE_CAPTURE_MAX_CHARS = 256_000

export function startRelaunchLiveCapture(ptyId: string): RelaunchLiveCapture {
  let raw = ''
  let unsubscribe = (): void => {}
  try {
    unsubscribe = subscribeToPtyData(ptyId, (data) => {
      if (raw.length < LIVE_CAPTURE_MAX_CHARS) {
        raw += data
      }
    })
  } catch {
    // Why: a host without the pty data channel (web client, test harness) can
    // still relaunch; with no bytes to read the verifier settles as unverified.
  }
  return { ptyId, text: () => raw, dispose: unsubscribe }
}
