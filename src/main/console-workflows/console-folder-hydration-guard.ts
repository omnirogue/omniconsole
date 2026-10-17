import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { NonDirectoryParentError, walkRealDirectoryChain } from '../filesystem-directory-chain'
import { readConsoleFolderSelectedFile } from './console-folder-selected-file'
type Source = { target_path: string; file?: { sha256?: string | null } }
type Candidate = { path: string; sha256: string }
export async function currentConsoleFolderDigest(
  root: string,
  path: string
): Promise<string | null> {
  try {
    const { content } = await readConsoleFolderSelectedFile(root, path)
    return createHash('sha256').update(content).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}
/** Check the entire selection before the first replacement; queued user edits are never restored away. */
export async function preflightConsoleFolderHydration(
  root: string,
  sources: Source[],
  candidate: Candidate[],
  allowAbsentSources = false
): Promise<Map<string, string | null>> {
  const accepted = new Map(candidate.map((file) => [file.path, file.sha256]))
  const observed = new Map<string, string | null>()
  for (const file of sources) {
    const original = file.file?.sha256
    if (original === null ? !allowAbsentSources : !/^[a-f0-9]{64}$/.test(original ?? '')) {
      throw new Error('The selected folder file has no authorized original snapshot digest.')
    }
    const current = await currentConsoleFolderDigest(root, file.target_path)
    if (current !== original && current !== (accepted.get(file.target_path) ?? null)) {
      throw new Error(
        'A selected folder file changed after its authorized snapshot; preserve the user edits before continuing.'
      )
    }
    observed.set(file.target_path, current)
  }
  return observed
}
export async function assertConsoleFolderHydrationUnchanged(
  root: string,
  path: string,
  expected: string | null
): Promise<void> {
  if ((await currentConsoleFolderDigest(root, path)) !== expected) {
    throw new Error(
      'A selected folder file changed during snapshot materialization; its new bytes were preserved.'
    )
  }
}

export async function assertSafeParents(root: string, path: string): Promise<void> {
  try {
    await walkRealDirectoryChain(root, dirname(resolve(root, path)), 'allow')
  } catch (error) {
    if (error instanceof NonDirectoryParentError) {
      throw new Error('A folder snapshot parent is not a real directory.')
    }
    throw error
  }
}
