import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { localAgentProcessAlive } from '../agent-hooks/hook-process-identity'

/** Claude's own registry records: `<pid>.json` and `<pid>.<socket hash>.key`. */
const REGISTRY_RECORD = /^(\d+)\.(?:json|[0-9a-f]+\.key)$/

export type SessionRegistryOptions = {
  defaultRegistry?: string
  alive?: (pid: number) => boolean
  /** Test seam for a launch that races the swap. */
  symlink?: typeof symlinkSync
}

/**
 * Why: ListAgents and SendMessage find other sessions only through the `sessions` registry in
 * Claude's config directory, so a managed account with its own registry is invisible to every
 * other session. Link the default profile's registry instead, as for skills and agents. Running
 * sessions' records move with it, so an account that is never idle still switches; an exited
 * session's record is dropped, and a copy already in the default registry is newer and wins.
 */
export function shareDefaultSessionRegistry(
  configDir: string,
  options: SessionRegistryOptions = {}
): void {
  const {
    defaultRegistry = join(homedir(), '.claude', 'sessions'),
    alive = localAgentProcessAlive,
    symlink = symlinkSync
  } = options
  if (!existsSync(defaultRegistry)) {
    return
  }
  const registry = join(configDir, 'sessions')
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    const current = lstatSync(registry, { throwIfNoEntry: false })
    if (!current) {
      symlink(defaultRegistry, registry, type)
      return
    }
    if (!current.isDirectory() || !readdirSync(registry).every((n) => REGISTRY_RECORD.test(n))) {
      return
    }
    // Why rename first: running sessions rewrite their records by path, so after the swap every
    // write lands in the default registry and none in the moved-aside copy.
    const aside = `${registry}.moving-${process.pid}-${Date.now()}`
    renameSync(registry, aside)
    if (lstatSync(aside).isSymbolicLink()) {
      renameSync(aside, registry)
      return
    }
    try {
      symlink(defaultRegistry, registry, type)
    } catch (error) {
      restoreRegistry(aside, registry)
      throw error
    }
    moveRecords(aside, defaultRegistry, alive)
    rmdirSync(aside)
  } catch (error) {
    console.warn('[claude-accounts] session registry not shared for', configDir, error)
  }
}

/** Puts a moved-aside registry back, merging it into one a starting session recreated. */
function restoreRegistry(aside: string, registry: string): void {
  if (!lstatSync(registry, { throwIfNoEntry: false })) {
    renameSync(aside, registry)
    return
  }
  moveRecords(aside, registry, () => true)
  rmdirSync(aside)
}

/** Moves records of running sessions without replacing a copy already there. */
function moveRecords(from: string, to: string, alive: (pid: number) => boolean): void {
  for (const name of readdirSync(from)) {
    const pid = REGISTRY_RECORD.exec(name)?.[1]
    if (!pid) {
      continue
    }
    const source = join(from, name)
    if (alive(Number(pid))) {
      addRecord(source, join(to, name))
    }
    unlinkSync(source)
  }
}

function addRecord(source: string, destination: string): void {
  try {
    linkSync(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      addRecordByCopy(source, destination)
    } else if (code !== 'EEXIST') {
      throw error
    }
  }
}

function addRecordByCopy(source: string, destination: string): void {
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
}
