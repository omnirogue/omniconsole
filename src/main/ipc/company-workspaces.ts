import { ipcMain } from 'electron'
import { homedir } from 'node:os'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { translateMain } from '../i18n/main-i18n'
import {
  DEFAULT_COMPANY_WORK_ROOT,
  expandHome,
  isValidFolderSetting,
  type EnsureCompanyFolderResult
} from '../../shared/company-folders'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { GlobalSettings } from '../../shared/global-settings-types'

/**
 * The deepest existing ancestor resolved through symlinks, with the not-yet-created
 * tail appended. A plain string compare would miss a symlinked ancestor pointing
 * out of the work root.
 */
async function realPathWithMissingTail(target: string): Promise<string> {
  let cursor = target
  const tail: string[] = []
  for (;;) {
    try {
      const resolved = await realpath(cursor)
      return join(resolved, ...tail)
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) {
        return target
      }
      tail.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ''))
      cursor = parent
    }
  }
}

/**
 * Creates a company folder, but only inside the configured company work root —
 * an IDE setting must never become an arbitrary `mkdir -p` on the user's disk.
 */
export async function ensureCompanyFolder(args: {
  path: string
  settings: Pick<GlobalSettings, 'companyWorkRoot' | 'companyFolders'> | null | undefined
  home?: string
}): Promise<EnsureCompanyFolderResult> {
  const home = args.home ?? homedir()
  const requested = typeof args.path === 'string' ? args.path.trim() : ''
  if (!isValidFolderSetting(requested)) {
    return {
      ok: false,
      message: translateMain(
        'companyFolders.invalidPath',
        'That is not an absolute folder path, so nothing was created.'
      )
    }
  }
  // Why: a hand-edited relative root must not resolve against the process cwd.
  const configuredRoot = args.settings?.companyWorkRoot?.trim() ?? ''
  const root = expandHome(
    configuredRoot && isValidFolderSetting(configuredRoot)
      ? configuredRoot
      : DEFAULT_COMPANY_WORK_ROOT,
    home
  )
  const target = expandHome(requested, home)
  // Why: a per-company override the person configured is a root of its own; Settings accepts
  // it, so Create must too.
  const overrides = Object.values(args.settings?.companyFolders ?? {})
    .filter((value): value is string => typeof value === 'string' && isValidFolderSetting(value))
    .map((value) => expandHome(value, home))
  const [realRoot, realTarget, ...realOverrides] = await Promise.all([
    realPathWithMissingTail(root),
    realPathWithMissingTail(target),
    ...overrides.map((value) => realPathWithMissingTail(value))
  ])
  const allowed =
    isPathInsideOrEqual(realRoot, realTarget) ||
    realOverrides.some((override) => isPathInsideOrEqual(override, realTarget))
  if (!allowed) {
    return {
      ok: false,
      message: translateMain(
        'companyFolders.outsideRoot',
        'That folder is outside the company work root, so nothing was created. Change the work root in Settings first.'
      )
    }
  }
  const existing = await stat(target).catch(() => null)
  if (existing) {
    if (!existing.isDirectory()) {
      return {
        ok: false,
        message: translateMain(
          'companyFolders.notADirectory',
          'A file already uses that path, so no folder was created.'
        )
      }
    }
    return { ok: true, created: false }
  }
  try {
    await mkdir(target, { recursive: true })
    return { ok: true, created: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export function registerCompanyWorkspaceHandlers(getSettings: () => GlobalSettings): void {
  ipcMain.handle('companyWorkspaces:home', () => homedir())
  ipcMain.handle('companyWorkspaces:ensureFolder', (_event, args: { path: string }) =>
    ensureCompanyFolder({ path: args?.path ?? '', settings: getSettings() })
  )
}
