import type { IpcRenderer } from 'electron'
import type {
  LaunchContextMemory,
  LaunchContextPatch,
  OllamaInventory
} from '../../shared/local-ollama-launch'

export type LocalOllamaPullProgress = {
  model: string
  status: string
  completedBytes?: number
  totalBytes?: number
}

export type LocalOllamaPrepareLaunchResult =
  | { ok: true; env: { OPENCODE_CONFIG_CONTENT: string }; templateId: string }
  | { ok: false; message: string }

export type GlobalInstructionsRead =
  /** `fallbackPath` names the file OpenCode reads instead while this one is absent. */
  | { ok: true; path: string; content: string | null; fallbackPath?: string }
  | { ok: false; path: string; message: string }

/** The Local Ollama launcher route: inventory, pulls, the global rules file, and the per-launch OpenCode config. */
export type LocalOllamaApi = {
  listModels: () => Promise<OllamaInventory>
  /** OpenCode's global rules file (`$XDG_CONFIG_HOME/opencode/AGENTS.md`, `~/.config` when unset); `content: null` means absent. */
  readGlobalInstructions: () => Promise<GlobalInstructionsRead>
  writeGlobalInstructions: (args: {
    content: string
  }) => Promise<{ ok: true; path: string } | { ok: false; path: string; message: string }>
  pullModel: (args: { model: string }) => Promise<{ ok: true } | { ok: false; message: string }>
  onPullProgress: (callback: (progress: LocalOllamaPullProgress) => void) => () => void
  prepareLaunch: (args: {
    model: string
    templateId: string
  }) => Promise<LocalOllamaPrepareLaunchResult>
  /** Merges one target's launch memory on the main process; `entry: null` forgets it. */
  rememberLaunchContext: (args: {
    key: string
    entry: LaunchContextPatch
  }) => Promise<{ ok: true; memory: LaunchContextMemory } | { ok: false; message: string }>
}

/** The preload surface the Local Ollama launcher route needs; absent means the web client. */
export type LocalOllamaPreloadApi = { localOllama?: LocalOllamaApi }

export function createLocalOllamaApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): LocalOllamaApi {
  return {
    listModels: () => ipc.invoke('localOllama:listModels'),
    readGlobalInstructions: () => ipc.invoke('localOllama:readGlobalInstructions'),
    writeGlobalInstructions: (args) => ipc.invoke('localOllama:writeGlobalInstructions', args),
    pullModel: (args) => ipc.invoke('localOllama:pullModel', args),
    onPullProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: LocalOllamaPullProgress) =>
        callback(progress)
      ipc.on('localOllama:pull-progress', listener)
      return () => ipc.removeListener('localOllama:pull-progress', listener)
    },
    prepareLaunch: (args) => ipc.invoke('localOllama:prepareLaunch', args),
    rememberLaunchContext: (args) => ipc.invoke('localOllama:rememberLaunchContext', args)
  }
}
