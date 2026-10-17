import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { handoffGit, HandoffGitRouteError } from './handoff-git-exec'

export async function publishHandoffBranch(input: {
  repoRoot: string
  remote: string
  fetchUrl: string | null
  branch: string
  sha: string
  options: GitRuntimeOptions
}): Promise<void> {
  const { repoRoot, remote, fetchUrl, branch, sha, options } = input
  const ref = `refs/heads/${branch}`
  let pushUrl: string
  try {
    const urls = (
      await handoffGit(['remote', 'get-url', '--push', '--all', remote], repoRoot, options)
    )
      .split(/\r?\n/)
      .filter(Boolean)
    if (urls.length !== 1 || !fetchUrl) {
      throw new Error('A handoff needs one fetch destination and one push destination.')
    }
    pushUrl = urls[0]!
  } catch {
    throw new HandoffGitRouteError(
      'push_unverifiable',
      'The Git destination could not be verified. Choose a remote with one push URL and try again.'
    )
  }
  const readRemote = async (destination: string): Promise<string | null> => {
    try {
      const output = await handoffGit(
        ['ls-remote', '--refs', '--', destination, ref],
        repoRoot,
        options
      )
      const matches = output.split(/\r?\n/).filter((line) => line.split('\t')[1] === ref)
      if (matches.length === 0) {
        return null
      }
      const oid = matches[0]?.split('\t')[0] ?? ''
      if (matches.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) {
        throw new Error('The remote returned an invalid branch reference.')
      }
      return oid
    } catch {
      throw new HandoffGitRouteError(
        'push_unverifiable',
        `The remote state of ${branch} could not be verified. The local commit is ${sha.slice(0, 12)}. Check the connection and retry.`
      )
    }
  }
  const published = async () => {
    const pushed = await readRemote(pushUrl === fetchUrl ? remote : pushUrl)
    const fetchable = pushUrl === fetchUrl ? pushed : await readRemote(remote)
    return pushed === sha && fetchable === sha
  }
  if (await published()) {
    return
  }
  let pushFailed = false
  try {
    // Pin the source object even if another local operation moves the branch during the push.
    await handoffGit(['push', '--', remote, `${sha}:${ref}`], repoRoot, options)
  } catch {
    pushFailed = true
  }
  if (!(await published())) {
    throw new HandoffGitRouteError(
      'push_failed',
      `Handoff commit ${sha.slice(0, 12)} could not be confirmed at both the push and fetch destination for ${branch}.${pushFailed ? ' Git reported a push failure.' : ' The remote may have moved during publication.'}`
    )
  }
}
