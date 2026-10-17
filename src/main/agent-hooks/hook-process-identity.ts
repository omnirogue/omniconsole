/** Only ESRCH proves exit; permission errors must not let a helper replace its parent. */
export function localAgentProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export { readAgentPid } from '../../shared/agent-hook-pid'

/** Ephemeral ownership: never hydrate PIDs from a prior runtime's status cache. */
export class HookProcessIdentity {
  private readonly owners = new Map<string, number>()

  constructor(private readonly alive = localAgentProcessAlive) {}

  accepts(paneKey: string, pid: number | undefined): boolean {
    const owner = this.owners.get(paneKey)
    return pid === undefined || owner === undefined || owner === pid || !this.alive(owner)
  }

  /** The live process a pane's agent names in its hook reports, if any. */
  ownerOf(paneKey: string): number | undefined {
    const owner = this.owners.get(paneKey)
    return owner !== undefined && this.alive(owner) ? owner : undefined
  }

  move(from: string, to: string): void {
    if (from === to) {
      return
    }
    const pid = this.owners.get(from)
    this.owners.delete(from)
    if (pid !== undefined) {
      this.owners.set(to, pid)
    }
  }

  delete(paneKey: string): void {
    this.owners.delete(paneKey)
  }

  clear(): void {
    this.owners.clear()
  }

  bind(paneKey: string, pid: number | undefined): void {
    if (pid !== undefined) {
      this.owners.set(paneKey, pid)
    }
  }
}
