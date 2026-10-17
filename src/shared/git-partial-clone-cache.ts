import { InFlightPromiseDedupe } from './in-flight-promise-dedupe'
import type { GitCommandRunner } from './git-effective-upstream'

// Why: repository config is a fact, not a Git binary capability; match remote-ref cache expiry.
export class GitPartialCloneCache {
  private readonly values = new Map<string, { value: boolean; expires: number }>()
  private readonly probes = new InFlightPromiseDedupe<boolean>()
  private generation = 0

  get(key: string, runGit: GitCommandRunner): Promise<boolean> {
    const cached = this.values.get(key)
    if (cached && cached.expires > Date.now()) {
      return Promise.resolve(cached.value)
    }
    const generation = this.generation
    return this.probes.run(key, async () => {
      // Why: -z separates multiline config values without reading repository blobs (Git 2.25 safe).
      const { stdout } = await runGit(['config', '--local', '--null', '--list'])
      const value = stdout.split('\0').some((entry) => {
        const [key, ...lines] = entry.split('\n')
        const value = lines.join('\n').trim()
        return (
          (/^remote\..+\.partialclonefilter$/i.test(key) && value.length > 0) ||
          (/^remote\..+\.promisor$/i.test(key) &&
            (lines.length === 0 ||
              /^(true|yes|on)$/i.test(value) ||
              (/^[-+]?\d+$/.test(value) && Number(value) !== 0))) ||
          (/^extensions\.partialclone$/i.test(key) && value.length > 0)
        )
      })
      if (generation === this.generation) {
        this.values.set(key, { value, expires: Date.now() + 5 * 60_000 })
        if (this.values.size > 512) {
          this.values.delete(this.values.keys().next().value!)
        }
      }
      return value
    })
  }

  clear(): void {
    this.generation++
    this.values.clear()
    this.probes.clear()
  }
}

export const gitPartialCloneCache = new GitPartialCloneCache()
export function invalidateGitPartialCloneConfig(): void {
  gitPartialCloneCache.clear()
}
export const clearGitPartialCloneStateForTests = invalidateGitPartialCloneConfig
