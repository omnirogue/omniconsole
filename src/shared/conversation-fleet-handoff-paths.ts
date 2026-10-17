import { consoleConversationSourcePath } from './console-conversation-source-files'
import type { SessionFollowUpDeliverables } from './session-follow-up-rule'
import { relativePathInsideRoot } from './cross-platform-path'

function portablePath(value: string, workspacePath: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(workspacePath) || workspacePath.startsWith('\\\\')
  const path = windows ? value.replaceAll('\\', '/') : value
  let relative = path
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    const contained = relativePathInsideRoot(workspacePath, path)
    if (contained === null) {
      throw new Error('A people handoff file is outside the captured source workspace.')
    }
    relative = contained
  }
  while (relative.startsWith('./')) {
    relative = relative.slice(2)
  }
  if (!consoleConversationSourcePath.safeParse(relative).success) {
    throw new Error('A people handoff needs an exact portable path inside its workspace.')
  }
  return relative
}

/** Source paths become portable identities; generated manifests retain their relative output location. */
export function conversationFleetPortableHandoffDeliverables(
  deliverables: SessionFollowUpDeliverables,
  sourceWorkspacePath: string
): SessionFollowUpDeliverables {
  switch (deliverables.kind) {
    case 'files':
      return {
        kind: 'files',
        paths: [
          ...new Set(deliverables.paths.map((path) => portablePath(path, sourceWorkspacePath)))
        ]
      }
    case 'manifest':
      return {
        kind: 'manifest',
        manifestPath: portablePath(deliverables.manifestPath, sourceWorkspacePath)
      }
    case 'manifests':
      return {
        kind: 'manifests',
        manifestPaths: [
          ...new Set(
            deliverables.manifestPaths.map((path) => portablePath(path, sourceWorkspacePath))
          )
        ]
      }
  }
}
