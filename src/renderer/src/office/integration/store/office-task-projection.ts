export function isOfficeTaskProjection(taskId: string): boolean {
  return taskId.startsWith('sess:') || taskId.startsWith('worktree:')
}
