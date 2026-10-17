import {
  confirmedSshPtyExitError,
  SSH_SESSION_UNVERIFIABLE_ERROR
} from '../shared/ssh-pty-exit-evidence'

const MAX_RETAINED_EXITS = 4096

// Eviction loses evidence; it never turns an unknown relay generation into an exit.
export class PtyExitEvidence {
  private readonly exited = new Set<string>()

  forget(id: string): void {
    this.exited.delete(id)
  }

  record(id: string): void {
    this.exited.delete(id)
    this.exited.add(id)
    if (this.exited.size > MAX_RETAINED_EXITS) {
      this.exited.delete(this.exited.values().next().value!)
    }
  }

  absenceError(id: string): Error {
    return this.exited.has(id)
      ? confirmedSshPtyExitError(id)
      : new Error(`${SSH_SESSION_UNVERIFIABLE_ERROR}: ${id}`)
  }
}
