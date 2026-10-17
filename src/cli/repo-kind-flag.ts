import type { RepoKind } from '../shared/repo-types'
import { RuntimeClientError } from './runtime/types'

export function getOptionalRepoKind(flags: Map<string, string | boolean>): RepoKind | undefined {
  const kind = flags.get('kind')
  if (kind === undefined) {
    return undefined
  }
  if (kind === 'git' || kind === 'folder') {
    return kind
  }
  throw new RuntimeClientError('invalid_argument', '--kind must be git or folder')
}
