import { createContext, useContext } from 'react'

// Unknown (a repository not in the store yet) counts as Git, so admission has the last word.
export const WorkflowWorkspaceIsFolder = createContext(false)

/** Whether the setup's workspace is a plain folder, which cannot test a change to the code. */
export function useWorkflowWorkspaceIsFolder(): boolean {
  return useContext(WorkflowWorkspaceIsFolder)
}
