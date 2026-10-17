import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'
import {
  RIGHT_PANEL_PICTURE_ACTIVITY_ID,
  SESSION_ARTIFACT_ACTIVITY_ID,
  type RightSidebarActivityId
} from './activity-bar-buttons'
import type { SessionPanelItem } from './session-artifact/session-panel-items'

const FileExplorer = lazy(() => import('./FileExplorer'))
const SourceControl = lazy(() => import('./SourceControl'))
const ChecksPanel = lazy(() => import('./ChecksPanel'))
const PortsPanel = lazy(() => import('./PortsPanel'))
const AiVaultPanel = lazy(() => import('./AiVaultPanel'))
const FolderWorkspaceWorktreesPanel = lazy(() => import('./FolderWorkspaceWorktreesPanel'))
const FolderWorkspacePrChecksPanel = lazy(() => import('./FolderWorkspacePrChecksPanel'))
const PluginPanel = lazy(() => import('./PluginPanel'))
const SessionArtifactPanel = lazy(() =>
  import('./session-artifact/SessionArtifactPanel').then((module) => ({
    default: module.SessionArtifactPanel
  }))
)

const RightPanelPicture = lazy(() =>
  import('./right-panel-picture/RightPanelPicture').then((module) => ({
    default: module.RightPanelPicture
  }))
)

type RightSidebarPanelContentProps = {
  effectiveTab: RightSidebarActivityId
  rightSidebarOpen: boolean
  /** The on-screen session's pages and Slite docs and its identity; the view resets per session. */
  sessionArtifacts?: {
    artifacts: readonly SessionPanelItem[]
    sessionKey: string | null
    pickedKey: string | null
    pick: (key: string) => void
    selectionRevision: number
  }
}

export function RightSidebarPanelContent({
  effectiveTab,
  rightSidebarOpen,
  sessionArtifacts
}: RightSidebarPanelContentProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={null}>
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'source-control' && <SourceControl />}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {/* Why: SSH port forwarding still depends on the raw ports.detect data,
            which the workspace-scoped status bar popover intentionally does not
            expose. Keep this panel reachable only for SSH worktrees. */}
        {effectiveTab === 'ports' && (
          <PortsPanel isVisible={rightSidebarOpen && effectiveTab === 'ports'} />
        )}
        {effectiveTab === 'vault' && <AiVaultPanel />}
        {effectiveTab === 'workspaces' && <FolderWorkspaceWorktreesPanel />}
        {effectiveTab === 'pr-checks' && (
          <FolderWorkspacePrChecksPanel
            isVisible={rightSidebarOpen && effectiveTab === 'pr-checks'}
          />
        )}
        {/* Plugin-contributed tabs route by key prefix; the panel itself
            handles plugins that have since been uninstalled or disabled.
            Why key: switching plugin tabs must remount the sandboxed iframe —
            a reused frame could keep posting messages while the bridge is
            rebound under the next plugin's identity. */}
        {effectiveTab === SESSION_ARTIFACT_ACTIVITY_ID && sessionArtifacts ? (
          <SessionArtifactPanel
            key={sessionArtifacts.sessionKey ?? ''}
            artifacts={sessionArtifacts.artifacts}
            onScreen={sessionArtifacts.sessionKey !== null}
            visible={rightSidebarOpen}
            pickedKey={sessionArtifacts.pickedKey}
            onPick={sessionArtifacts.pick}
            selectionRevision={sessionArtifacts.selectionRevision}
          />
        ) : null}
        {effectiveTab === RIGHT_PANEL_PICTURE_ACTIVITY_ID ? <RightPanelPicture /> : null}
        {isPluginPanelTabKey(effectiveTab) && (
          <PluginPanel key={effectiveTab} tabKey={effectiveTab} />
        )}
      </Suspense>
    </div>
  )
}
