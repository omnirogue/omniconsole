import { probeWorktreeMetadata } from './git/worktree-metadata-service'

/** Only confirmed absence can remove native-local worktree metadata. */
export async function localWorktreePathExistsOrIsUnverifiable(
  pathValue: string,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  const results = await localWorktreePathsExistOrAreUnverifiable([pathValue], options)
  return results.get(pathValue) ?? true
}

export async function localWorktreePathsExistOrAreUnverifiable(
  pathValues: readonly string[],
  options: { signal?: AbortSignal } = {}
): Promise<ReadonlyMap<string, boolean>> {
  const results = await probeWorktreeMetadata('exists', pathValues, options.signal)
  return new Map(
    [...results].map(([path, result]) => [
      path,
      !(result?.operation === 'exists' && result.value === false)
    ])
  )
}
