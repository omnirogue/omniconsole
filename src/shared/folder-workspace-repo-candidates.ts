/** A git checkout found under a folder workspace, offered as "Attach this repo?". */
export type FolderWorkspaceRepoCandidate = {
  path: string
  displayName: string
  /** SSH target the checkout lives on; null = this computer. */
  connectionId: string | null
  /** Registered repo at this path, or null when attaching must add it as a project first. */
  registeredRepoId: string | null
  attached: boolean
}

export type FolderWorkspaceRepoDetection = {
  candidates: FolderWorkspaceRepoCandidate[]
  /** The scan hit its time, depth or count limit, so some checkouts may be missing. */
  incomplete: boolean
}
