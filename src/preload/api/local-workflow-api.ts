import type { IpcRenderer } from 'electron'
import { createWorkflowScriptApi, type WorkflowScriptApi } from './workflows'
import { LOCAL_WORKFLOW_CHANGED_CHANNEL } from '../../shared/local-workflow-changed'
import {
  LOCAL_WORKFLOW_FIND_REPLY_CHANNEL,
  LOCAL_WORKFLOW_FIND_REQUEST_CHANNEL,
  type LocalWorkflowFindReply
} from '../../shared/local-workflow-find-request'
import type { LocalWorkflowStartAsk } from '../../shared/local-workflow-run-request'
import type { LocalWorkflowChangedEvent } from '../../shared/local-workflow-rpc'
import {
  WORKFLOW_CONTEXT_CHANNELS,
  type WorkflowGitHubBranchesResult,
  type WorkflowGitHubReposResult
} from '../../shared/workflow-context-ipc'

export type LocalWorkflowFindRendererRequest = {
  requestId: string
  worktreeId: string
  /** Find the best's own request, or `omni workflow run`'s template request. */
  request: LocalWorkflowStartAsk
}

export type LocalWorkflowApi = WorkflowScriptApi & {
  /** Council and Discover status, pushed so hidden tabs and sidebar rows stay current. */
  onChanged: (callback: (event: LocalWorkflowChangedEvent) => void) => () => void
  /** `omni find-best` / `omni workflow run`: open the workflow conversation and start it, then reply. */
  onFindRequest: (callback: (data: LocalWorkflowFindRendererRequest) => void) => () => void
  replyFind: (reply: LocalWorkflowFindReply) => void
  /** The system dialog for files, or for folders, agents may read; [] when cancelled. */
  pickContextPaths: (args: { folders: boolean }) => Promise<string[]>
  /** The person's own and their organizations' repositories, or GitHub's search for `query`. */
  searchContextRepos: (args: { query: string }) => Promise<WorkflowGitHubReposResult>
  listContextBranches: (args: { repo: string }) => Promise<WorkflowGitHubBranchesResult>
}

export function createLocalWorkflowApi(
  ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'send' | 'invoke'>
): LocalWorkflowApi {
  return {
    ...createWorkflowScriptApi(ipc),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: LocalWorkflowChangedEvent) =>
        callback(payload)
      ipc.on(LOCAL_WORKFLOW_CHANGED_CHANNEL, listener)
      return () => {
        ipc.removeListener(LOCAL_WORKFLOW_CHANGED_CHANNEL, listener)
      }
    },
    onFindRequest: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LocalWorkflowFindRendererRequest
      ) => callback(payload)
      ipc.on(LOCAL_WORKFLOW_FIND_REQUEST_CHANNEL, listener)
      return () => {
        ipc.removeListener(LOCAL_WORKFLOW_FIND_REQUEST_CHANNEL, listener)
      }
    },
    replyFind: (reply) => ipc.send(LOCAL_WORKFLOW_FIND_REPLY_CHANNEL, reply),
    pickContextPaths: (args) => ipc.invoke(WORKFLOW_CONTEXT_CHANNELS.pickPaths, args),
    searchContextRepos: (args) => ipc.invoke(WORKFLOW_CONTEXT_CHANNELS.searchRepos, args),
    listContextBranches: (args) => ipc.invoke(WORKFLOW_CONTEXT_CHANNELS.listBranches, args)
  }
}
