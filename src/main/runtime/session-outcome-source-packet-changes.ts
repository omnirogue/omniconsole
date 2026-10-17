import type { GitStatusResult } from '../../shared/git-status-types'
import { resolveWorkspaceOutputPath } from '../../shared/session-follow-up-deliverables'
import { isImplicitFleetSecret } from './conversation-fleet-source-git'
import type { OrcaRuntimeService } from './omni-runtime'

const PRESENT_FILE_STATUSES = new Set(['modified', 'added', 'untracked', 'renamed', 'copied'])
const MAX_SOURCE_CHANGES = 32

export async function sessionOutcomeSourceChanges(
  runtime: OrcaRuntimeService,
  sourceWorktreeId: string,
  sourceWorkspace: string
): Promise<{ paths: string[]; unavailable: boolean }> {
  let status: GitStatusResult
  try {
    status = await runtime.getRuntimeGitStatus(`id:${sourceWorktreeId}`, {
      includeLineStats: false,
      admissionTier: 'interactive'
    })
  } catch {
    return { paths: [], unavailable: true }
  }
  if (status.didHitLimit || (status.statusLength ?? 0) > status.entries.length) {
    throw new Error('The source Git status was truncated. Resolve its scope before continuing.')
  }
  const paths = new Set<string>()
  for (const entry of status.entries) {
    if (!PRESENT_FILE_STATUSES.has(entry.status) || entry.submodule || entry.submoduleRoot) {
      continue
    }
    const normalized = entry.path.replace(/\\/g, '/')
    const parts = normalized.split('/').map((part) => part.toLowerCase())
    if (parts.includes('.git') || parts.includes('.omni') || isImplicitFleetSecret(normalized)) {
      continue
    }
    const path = resolveWorkspaceOutputPath(sourceWorkspace, entry.path)
    if (path) {
      paths.add(path)
    }
  }
  if (paths.size > MAX_SOURCE_CHANGES) {
    throw new Error('The source Git status exceeds 32 changes. Reduce its scope before continuing.')
  }
  return { paths: [...paths].sort(), unavailable: false }
}
