import { useAppStore } from '@/store'

// Why only text: the path comes from the agent's own report, so it names a document to read,
// never something the app would hand to another program.
const TEXT_REPORT = /\.(?:md|markdown|txt|log)$/i

/** Whether a worker's report file can be opened here: a local text file, in a known workspace. */
export function canOpenWorkerReport(
  reportPath: string | null | undefined,
  worktreeId: string | null | undefined
): reportPath is string {
  return Boolean(reportPath && worktreeId && TEXT_REPORT.test(reportPath))
}

/**
 * Opens the full report in the app's own viewer, the way a file link in a terminal opens, and
 * rejects when it cannot: that opener gives up without a word on a file it cannot read, so the
 * file is looked at first, the same way. Why loaded on click: the file routing pulls in the
 * editor and preview stack, which a run view that never opens a report has no use for.
 */
export async function openWorkerReport(reportPath: string, worktreeId: string): Promise<void> {
  const [routing, files] = await Promise.all([
    import('@/components/terminal-pane/terminal-file-open-routing'),
    import('@/runtime/runtime-file-client')
  ])
  const worktreePath = useAppStore.getState().getKnownWorktreeById(worktreeId)?.path
  if (!worktreePath) {
    throw new Error(`Workspace ${worktreeId} is not known in this window.`)
  }
  const context = routing.getTerminalFileContext(worktreeId, worktreePath, null)
  const filePath = routing.mapTerminalFilePath(reportPath, worktreePath)
  if (routing.shouldOpenTerminalFileWithSystemDefault(context, filePath)) {
    await window.api.fs.authorizeExternalPath({ targetPath: filePath })
  }
  const stat = await files.statRuntimePath(context, filePath)
  if (stat.isDirectory) {
    throw new Error('The report path names a folder.')
  }
  routing.openDetectedFilePath(reportPath, null, null, {
    worktreeId,
    worktreePath,
    runtimeEnvironmentId: null
  })
}
