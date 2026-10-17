import type { ExactHandoffFile } from './console-handoff-contract'
import type { SessionFollowUpFilePin } from './session-follow-up-rule'

// The capture and delivery share one snapshot; persisted pins reread after a restart.
const snapshots = new WeakMap<SessionFollowUpFilePin, ExactHandoffFile>()

export function rememberFollowUpFile(pin: SessionFollowUpFilePin, file: ExactHandoffFile): void {
  snapshots.set(pin, file)
}

export async function readFollowUpFileSnapshot(
  pin: SessionFollowUpFilePin,
  read: (pin: SessionFollowUpFilePin) => Promise<ExactHandoffFile>
): Promise<ExactHandoffFile> {
  const snapshot = snapshots.get(pin)
  if (snapshot) {
    snapshots.delete(pin)
    return snapshot
  }
  return read(pin)
}
