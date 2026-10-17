import type { ActivityBarItem } from './activity-bar-buttons'

type RightSidebarActivityVisibilityState = {
  isFolder: boolean
  isFolderWorkspace: boolean
  isSshRepo: boolean
}

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  { isFolder, isFolderWorkspace, isSshRepo }: RightSidebarActivityVisibilityState
): ActivityBarItem[] {
  return items.filter(
    (item) =>
      // Why: a folder workspace's Source Control shows its attached repo (or how to attach one).
      (!item.gitOnly || !isFolder || (isFolderWorkspace && item.id === 'source-control')) &&
      (!item.folderOnly || isFolderWorkspace) &&
      (!item.sshOnly || isSshRepo)
  )
}
