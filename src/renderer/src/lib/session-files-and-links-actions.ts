import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseLoopbackUrlWithPort } from '../../../shared/localhost-worktree-labels'
import type { HttpLinkSourceOwner } from './http-link-routing'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { getWorkspaceFilePreviewPlan } from '@/lib/file-preview'
import { openHttpLink } from '@/lib/http-link-routing'
import {
  buildWorkspaceFileContextForFile,
  canClientOsOpenWorkspaceFile
} from '@/lib/workspace-file-host-routing'
import { runtimePathExists, type RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'

/** The workspace a session's files belong to, as the file openers need it. */
export type SessionFileTarget = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
}

export function sessionFileContext(
  target: SessionFileTarget,
  filePath: string
): RuntimeFileOperationArgs {
  return buildWorkspaceFileContextForFile(
    target.worktreeId,
    target.worktreePath,
    filePath,
    target.runtimeEnvironmentId
  )
}

/**
 * Whether a file the session wrote is still there. The authorized fs check answers for the
 * workspace (and any SSH/runtime owner); a local absolute path outside every workspace root is
 * refused by that check, so the existence-only shell probe answers for it — it reads nothing.
 */
export async function sessionFileExists(
  target: SessionFileTarget,
  filePath: string
): Promise<boolean> {
  const context = sessionFileContext(target, filePath)
  try {
    return await runtimePathExists(context, filePath)
  } catch {
    if (!canClientOsOpenWorkspaceFile(context, filePath)) {
      return false
    }
    return window.api.shell.pathExists(filePath).catch(() => false)
  }
}

/**
 * Every button in Files & links goes through here, so each opens only on a person's click and the
 * tests can stand in for the real openers.
 */
export function sessionLinkOwner(hostId: string | null | undefined): HttpLinkSourceOwner {
  const host = parseExecutionHostId(hostId)
  if (host?.kind === 'local') {
    return { kind: 'local' }
  }
  if (host?.kind === 'ssh') {
    return { kind: 'ssh', connectionId: host.targetId }
  }
  if (host?.kind === 'runtime') {
    return { kind: 'runtime', runtimeEnvironmentId: host.environmentId }
  }
  return { kind: 'unknown' }
}
export function canOpenSessionFileLocally(target: SessionFileTarget, path: string): boolean {
  return canClientOsOpenWorkspaceFile(sessionFileContext(target, path), path)
}
export function canOpenSessionUrlExternally(
  url: string,
  hostId: string | null | undefined
): boolean {
  return !parseLoopbackUrlWithPort(url) || sessionLinkOwner(hostId).kind === 'local'
}
export const sessionFilesAndLinksActions = {
  openUrlInApp(url: string, worktreeId: string, hostId: string | null | undefined): void {
    openHttpLink(url, {
      worktreeId,
      forceInApp: true,
      allowRemoteInApp: true,
      sourceOwner: sessionLinkOwner(hostId)
    })
  },
  openUrlInSystemBrowser(url: string, hostId: string | null | undefined): void {
    if (!canOpenSessionUrlExternally(url, hostId)) {
      return
    }
    openHttpLink(url, { forceSystemBrowser: true, sourceOwner: { kind: 'local' } })
  },
  copyLink(url: string): Promise<void> {
    return window.api.ui.writeClipboardText(url)
  },
  /** The app's own viewer for the type: image viewer, Markdown/CSV/PDF view, editor, HTML tab. */
  openFile(filePath: string, target: SessionFileTarget): void {
    openDetectedFilePath(filePath, null, null, target)
  },
  /** Local videos play in an in-app browser tab; anything else falls back to the file opener. */
  playVideo(filePath: string, target: SessionFileTarget): void {
    const state = useAppStore.getState()
    const plan = getWorkspaceFilePreviewPlan(state, target.worktreeId, filePath)
    if (plan.status === 'browser-tab') {
      state.createBrowserTab(target.worktreeId, plan.url, { title: plan.title, activate: true })
      return
    }
    openDetectedFilePath(filePath, null, null, target)
  },
  /** An HTML file handed to the OS default app, which is the person's browser. */
  openFileInSystemApp(filePath: string, target: SessionFileTarget): void {
    if (canOpenSessionFileLocally(target, filePath)) {
      void window.api.shell.openFilePath(filePath)
    }
  },
  reveal(filePath: string, target: SessionFileTarget): void {
    if (canOpenSessionFileLocally(target, filePath)) {
      void window.api.shell.openInFileManager(filePath)
    }
  }
}
