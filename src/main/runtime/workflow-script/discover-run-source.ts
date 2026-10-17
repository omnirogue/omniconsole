import { runProcess } from '../../../shared/child-process/run-process'
import type { DiscoverRunSource } from '../../../shared/discover-omnios-page'

/** A Start must reproduce the source this run read, rather than today's default branch. */
export async function readDiscoverRunSource(path: string): Promise<DiscoverRunSource | undefined> {
  const git = async (args: string[]): Promise<string> => {
    const result = await runProcess({
      program: 'git',
      args,
      cwd: path,
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated) {
      throw new Error('Cannot inspect Discover source')
    }
    return result.stdout.trim()
  }
  try {
    const commit = await git(['rev-parse', '--verify', 'HEAD'])
    if (!/^[a-f0-9]{40,64}$/.test(commit)) {
      return undefined
    }
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
    const origin = await git(['remote', 'get-url', 'origin']).catch(() => undefined)
    if (origin && /^https?:\/\/[^/]*@/.test(origin)) {
      return undefined
    }
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all'])
    return { commit, branch, ...(origin ? { origin } : {}), dirty: !!status }
  } catch {
    return undefined
  }
}
