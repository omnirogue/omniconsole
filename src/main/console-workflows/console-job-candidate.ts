import { gitExecFileAsync } from '../git/runner'

/** Capture only committed candidates; a SHA cannot identify dirty acceptance input. */
export async function readConsoleJobCandidate(
  cwd: string,
  ignoreUntracked?: (file: string) => boolean
): Promise<{ head: string; branch: string; committed: boolean }> {
  const [head, branch, status] = await Promise.all([
    gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], { cwd }),
    gitExecFileAsync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    gitExecFileAsync(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd })
  ])
  return {
    head: head.stdout.trim(),
    branch: branch.stdout.trim(),
    committed: !status.stdout
      .split('\0')
      .some((entry) => entry && !(entry.startsWith('?? ') && ignoreUntracked?.(entry.slice(3))))
  }
}
