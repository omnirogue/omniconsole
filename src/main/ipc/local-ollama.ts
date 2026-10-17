import { app, BrowserWindow, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  listOllamaModels,
  pullOllamaModel,
  resolveOllamaBaseUrl
} from '../local-ollama/ollama-inventory'
import { prepareOpenCodeLaunchConfig } from '../local-ollama/opencode-launch-config'
import { readOllamaModelContext } from '../local-ollama/ollama-model-context'
import { resolveAgentTemplates } from '../../shared/agent-templates'
import {
  isOllamaModelTag,
  mergeLaunchContextEntry,
  type LaunchContextPatch
} from '../../shared/local-ollama-launch'
import type { GlobalSettings } from '../../shared/global-settings-types'

export const LOCAL_OLLAMA_PULL_PROGRESS_CHANNEL = 'localOllama:pull-progress'
const MAX_GLOBAL_INSTRUCTIONS_BYTES = 256 * 1024

/** OpenCode's global config dir, resolved the way OpenCode does (xdg-basedir: `XDG_CONFIG_HOME`, else `~/.config`). */
export function openCodeGlobalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'opencode')
}

/** OpenCode's global rules: the one file outside workspace roots every OpenCode session reads. */
function globalInstructionsPath(): string {
  return join(openCodeGlobalConfigDir(), 'AGENTS.md')
}

const inFlightPulls = new Map<string, Promise<{ ok: true } | { ok: false; message: string }>>()

/**
 * The Local Ollama route's main-process side: inventory, pulls, and the per-launch
 * OpenCode config. Settings are read at call time so a template edited in Settings is
 * what the next launch gets.
 */
export function registerLocalOllamaHandlers(
  getSettings: () => GlobalSettings,
  updateSettings: (updates: Partial<GlobalSettings>) => GlobalSettings
): void {
  ipcMain.handle('localOllama:listModels', () => listOllamaModels())

  // Why: composed here, on the settings as they are now, and broadcast to every window
  // including the caller; a renderer snapshot can be stale while other writes are in flight.
  ipcMain.handle(
    'localOllama:rememberLaunchContext',
    (_event, args: { key: string; entry: LaunchContextPatch }) => {
      const key = typeof args?.key === 'string' ? args.key : ''
      if (!key || key.length > 300) {
        return { ok: false as const, message: 'Not a launch target.' }
      }
      const raw = args?.entry
      let entry: LaunchContextPatch
      if (raw === null) {
        entry = null
      } else if (raw && typeof raw === 'object') {
        entry = {
          ...(typeof raw.templateId === 'string' ? { templateId: raw.templateId } : {}),
          ...(typeof raw.ollamaModel === 'string' ? { ollamaModel: raw.ollamaModel } : {})
        }
      } else {
        return { ok: false as const, message: 'Not a launch memory entry.' }
      }
      const next = updateSettings({
        launchContextMemory: mergeLaunchContextEntry(getSettings().launchContextMemory, key, entry)
      })
      return { ok: true as const, memory: next.launchContextMemory ?? {} }
    }
  )

  ipcMain.handle('localOllama:readGlobalInstructions', () => {
    const path = globalInstructionsPath()
    try {
      const stat = statSync(path)
      // Why: a FIFO or device would block the main process in readFileSync.
      if (!stat.isFile()) {
        return { ok: false as const, path, message: 'Not a regular file.' }
      }
      if (stat.size > MAX_GLOBAL_INSTRUCTIONS_BYTES) {
        return { ok: false as const, path, message: 'File is too large to edit here.' }
      }
      const bytes = readFileSync(path)
      // Why: NUL bytes mean a binary file; editing it as text would destroy it.
      if (bytes.includes(0)) {
        return { ok: false as const, path, message: 'Not a text file.' }
      }
      return { ok: true as const, path, content: bytes.toString('utf8') }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') {
        // Why: OpenCode takes the first existing file of [its AGENTS.md, ~/.claude/CLAUDE.md].
        const fallback = join(homedir(), '.claude', 'CLAUDE.md')
        let fallbackInUse = false
        try {
          fallbackInUse = statSync(fallback).isFile()
        } catch {
          fallbackInUse = false
        }
        return {
          ok: true as const,
          path,
          content: null,
          ...(fallbackInUse ? { fallbackPath: fallback } : {})
        }
      }
      return {
        ok: false as const,
        path,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('localOllama:writeGlobalInstructions', (_event, args: { content: string }) => {
    const path = globalInstructionsPath()
    if (typeof args?.content !== 'string') {
      return { ok: false as const, path, message: 'Instructions must be text.' }
    }
    const content = args.content
    if (Buffer.byteLength(content, 'utf8') > MAX_GLOBAL_INSTRUCTIONS_BYTES) {
      return { ok: false as const, path, message: 'Instructions are too large.' }
    }
    try {
      mkdirSync(openCodeGlobalConfigDir(), { recursive: true })
      // Why: dotfile managers symlink this file; write through the link, never over it.
      let target = path
      try {
        target = realpathSync(path)
      } catch {
        // Why: a link we cannot follow must not be replaced by a plain file.
        const isLink = (() => {
          try {
            return lstatSync(path).isSymbolicLink()
          } catch {
            return false
          }
        })()
        if (isLink) {
          return {
            ok: false as const,
            path,
            message: 'The rules file is a link that cannot be followed.'
          }
        }
        target = path
      }
      writeFileAtomically(target, content)
      return { ok: true as const, path }
    } catch (error) {
      return {
        ok: false as const,
        path,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('localOllama:pullModel', async (_event, args: { model: string }) => {
    const model = typeof args?.model === 'string' ? args.model.trim() : ''
    if (!isOllamaModelTag(model)) {
      return { ok: false as const, message: 'Not a valid model tag.' }
    }
    // Why: two clicks on Pull share one download instead of starting two.
    const inFlight = inFlightPulls.get(model)
    if (inFlight) {
      return inFlight
    }
    const broadcast = (progress: {
      model: string
      status: string
      completedBytes?: number
      totalBytes?: number
    }): void => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
          continue
        }
        try {
          window.webContents.send(LOCAL_OLLAMA_PULL_PROGRESS_CHANNEL, progress)
        } catch {
          // Why: a renderer going away mid-stream must not abort the download.
        }
      }
    }
    const pull = pullOllamaModel({ model, onProgress: broadcast })
      .then((result) => {
        // Why: a view that only watched the stream needs a terminal event to clear its row.
        broadcast({ model, status: result.ok ? 'success' : 'error' })
        return result
      })
      .finally(() => inFlightPulls.delete(model))
    inFlightPulls.set(model, pull)
    return pull
  })

  ipcMain.handle(
    'localOllama:prepareLaunch',
    async (_event, args: { model: string; templateId: string }) => {
      const model = typeof args?.model === 'string' ? args.model.trim() : ''
      if (!isOllamaModelTag(model)) {
        return { ok: false as const, message: 'Not a valid model tag.' }
      }
      const templates = resolveAgentTemplates(getSettings().agentTemplates)
      const template = templates.find((entry) => entry.id === args?.templateId)
      if (!template) {
        return { ok: false as const, message: 'Unknown agent template.' }
      }
      try {
        const baseUrl = resolveOllamaBaseUrl()
        const contextLength = await readOllamaModelContext(model, baseUrl)
        const prepared = prepareOpenCodeLaunchConfig({
          model,
          template,
          baseUrl,
          contextLength,
          instructionsDir: join(app.getPath('userData'), 'opencode-agent-templates')
        })
        return { ok: true as const, ...prepared, templateId: template.id }
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}
