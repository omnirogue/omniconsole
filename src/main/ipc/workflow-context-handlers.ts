import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { WORKFLOW_CONTEXT_CHANNELS } from '../../shared/workflow-context-ipc'
import {
  listWorkflowContextBranches,
  searchWorkflowContextRepos
} from '../runtime/workflow-script/context/context-github-search'

const PickPaths = z.object({ folders: z.boolean() }).strict()
const SearchRepos = z.object({ query: z.string().max(256) }).strict()
const ListBranches = z.object({ repo: z.string().max(200) }).strict()

/**
 * The workflow context picker: choose files or folders with the system dialog, search GitHub and
 * list a repository's branches. Nothing is copied here; admission checks every choice again.
 */
export function registerWorkflowContextHandlers(): void {
  ipcMain.handle(WORKFLOW_CONTEXT_CHANNELS.pickPaths, async (event, raw): Promise<string[]> => {
    const { folders } = PickPaths.parse(raw)
    const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    // Windows and Linux cannot pick files and folders in one dialog, so each has its own.
    const options: Electron.OpenDialogOptions = {
      title: folders ? 'Choose folders for the agents' : 'Choose files for the agents',
      properties: [folders ? 'openDirectory' : 'openFile', 'multiSelections']
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(WORKFLOW_CONTEXT_CHANNELS.searchRepos, (_event, raw) =>
    searchWorkflowContextRepos(SearchRepos.parse(raw).query)
  )
  ipcMain.handle(WORKFLOW_CONTEXT_CHANNELS.listBranches, (_event, raw) =>
    listWorkflowContextBranches(ListBranches.parse(raw).repo)
  )
}
