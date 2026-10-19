import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SessionSearchAgent } from '../../shared/session-search-types'
import { codexRolloutHardlinkIdentity } from '../ai-vault/codex-session-root-dedup'

export type TranscriptRoot = { agent: SessionSearchAgent; dir: string }

export type TranscriptFile = {
  agent: SessionSearchAgent
  path: string
  sessionId: string
  size: number
  mtimeMs: number
  /** Every listed path that is a hardlink of this same file, `path` included. */
  aliases?: readonly string[]
}

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const SKIPPED_DIRS = new Set(['subagents', 'backups', 'backup', 'archive', 'node_modules'])

async function childDirs(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(parent, entry.name))
  } catch {
    return []
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every transcript home on this host: the default and numbered profiles (`~/.claude*`,
 * `~/.codex*`), pooled slots (`~/.claude-accounts/<pool>/<slot>`), and homes OmniConsole
 * manages under its own data folders. Bounded: only known shapes, never a free walk of $HOME.
 */
export async function discoverTranscriptRoots(args: {
  homeDir: string
  appDataDirs: readonly string[]
  extraRoots?: readonly TranscriptRoot[]
}): Promise<TranscriptRoot[]> {
  const candidates: TranscriptRoot[] = [...(args.extraRoots ?? [])]
  for (const dir of await childDirs(args.homeDir)) {
    const name = basename(dir)
    if (/^\.claude(?:[-.][\w.-]+)?$/.test(name)) {
      candidates.push({ agent: 'claude', dir: join(dir, 'projects') })
    } else if (/^\.codex(?:-[\w-]+)?$/.test(name)) {
      candidates.push({ agent: 'codex', dir: join(dir, 'sessions') })
    }
  }
  for (const pool of await childDirs(join(args.homeDir, '.claude-accounts'))) {
    candidates.push({ agent: 'claude', dir: join(pool, 'projects') })
    for (const slot of await childDirs(pool)) {
      candidates.push({ agent: 'claude', dir: join(slot, 'projects') })
    }
  }
  for (const profile of await childDirs(join(args.homeDir, '.codex-accounts'))) {
    if (!SKIPPED_DIRS.has(basename(profile))) {
      candidates.push({ agent: 'codex', dir: join(profile, 'sessions') })
    }
  }
  for (const appDir of args.appDataDirs) {
    candidates.push({ agent: 'codex', dir: join(appDir, 'codex-runtime-home', 'home', 'sessions') })
    for (const account of await childDirs(join(appDir, 'codex-accounts'))) {
      candidates.push({ agent: 'codex', dir: join(account, 'home', 'sessions') })
    }
    // Claude accounts OmniConsole manages keep their own config dir (CLAUDE_CONFIG_DIR).
    for (const account of await childDirs(join(appDir, 'claude-accounts'))) {
      candidates.push({ agent: 'claude', dir: join(account, 'auth', 'session', 'projects') })
    }
  }
  const seen = new Set<string>()
  const roots: TranscriptRoot[] = []
  for (const candidate of candidates) {
    if (!(await isDir(candidate.dir))) {
      continue
    }
    const canonical = await realpath(candidate.dir).catch(() => candidate.dir)
    if (!seen.has(canonical)) {
      seen.add(canonical)
      roots.push({ agent: candidate.agent, dir: canonical })
    }
  }
  return roots
}

export function transcriptSessionId(path: string): string {
  const match = UUID_TAIL.exec(path)
  return match ? match[1]!.toLowerCase() : basename(path, '.jsonl')
}

type DirListing = { mtimeMs: number; files: string[]; dirs: string[] }
/** Per-pass view of the walk cache: `next` becomes the cache once the pass completes. */
type WalkCache = { prev: Map<string, DirListing>; next: Map<string, DirListing> }

// Why: directory mtime changes only when entries are added or removed, so unchanged day
// directories skip readdir; appends to a file are still seen by the per-file stat.
let listingCache = new Map<string, DirListing>()
// Why: a hardlink alias in an unchanged directory keeps its inode, so later passes skip its stat.
let aliasCache = new Map<string, { dirMtimeMs: number; inode: string }>()

/** Claude keeps one level of project folders; Codex nests year/month/day. */
async function walk(
  dir: string,
  depth: number,
  out: string[],
  signal?: AbortSignal,
  cache?: WalkCache,
  dirMtimes?: Map<string, number>
): Promise<void> {
  if (signal?.aborted) {
    return
  }
  let listing: DirListing | undefined
  try {
    const mtimeMs = cache ? (await stat(dir)).mtimeMs : 0
    const prior = cache?.prev.get(dir)
    if (prior && prior.mtimeMs === mtimeMs) {
      listing = prior
    } else {
      const files: string[] = []
      const dirs: string[] = []
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(path)
        } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
          dirs.push(path)
        }
      }
      listing = { mtimeMs, files, dirs }
    }
  } catch {
    return
  }
  cache?.next.set(dir, listing)
  for (const path of listing.files) {
    out.push(path)
    dirMtimes?.set(path, listing.mtimeMs)
  }
  if (depth > 0) {
    for (const path of listing.dirs) {
      await walk(path, depth - 1, out, signal, cache, dirMtimes)
    }
  }
}

/** Every copy of one conversation's transcript under the roots, one per file, never collapsed. */
export async function findTranscriptFiles(
  roots: readonly TranscriptRoot[],
  agent: SessionSearchAgent,
  sessionId: string
): Promise<{ root: TranscriptRoot; path: string }[]> {
  const id = sessionId.toLowerCase()
  const found: { root: TranscriptRoot; path: string }[] = []
  for (const root of roots.filter((candidate) => candidate.agent === agent)) {
    const paths: string[] = []
    await walk(root.dir, agent === 'claude' ? 1 : 4, paths)
    for (const path of paths) {
      if (transcriptSessionId(path).toLowerCase() === id) {
        found.push({ root, path })
      }
    }
  }
  return found
}

/**
 * All transcripts under the roots, one per session (the newest file wins). Hardlinks of one
 * file (Codex rollouts bridged into every account home) collapse into one entry with `aliases`.
 */
export async function listTranscriptFiles(
  roots: readonly TranscriptRoot[],
  signal?: AbortSignal
): Promise<TranscriptFile[]> {
  const bySession = new Map<string, TranscriptFile>()
  const inodes = new Map<string, string>()
  const cache: WalkCache = { prev: listingCache, next: new Map() }
  const nextAliases = new Map<string, { dirMtimeMs: number; inode: string }>()
  for (const root of roots) {
    const paths: string[] = []
    const dirMtimes = new Map<string, number>()
    await walk(root.dir, root.agent === 'claude' ? 1 : 4, paths, signal, cache, dirMtimes)
    for (const path of paths) {
      if (signal?.aborted) {
        return []
      }
      const sessionId = transcriptSessionId(path)
      const key = `${root.agent}:${sessionId}`
      const dirMtimeMs = dirMtimes.get(path) ?? 0
      const known = aliasCache.get(path)
      const canonical = bySession.get(key)
      if (
        canonical &&
        known &&
        known.dirMtimeMs === dirMtimeMs &&
        inodes.get(key) === known.inode
      ) {
        if (canonical.aliases) {
          ;(canonical.aliases as string[]).push(path)
        } else {
          canonical.aliases = [path]
        }
        nextAliases.set(path, known)
        continue
      }
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      const inode = codexRolloutHardlinkIdentity(info)
      if (inode) {
        nextAliases.set(path, { dirMtimeMs, inode })
      }
      const current = bySession.get(key)
      if (current && inode && inodes.get(key) === inode) {
        // Why: stats of one file taken moments apart differ while it is appended; that is not a newer copy.
        if (current.aliases) {
          ;(current.aliases as string[]).push(path)
        } else {
          current.aliases = [path]
        }
        current.size = Math.max(current.size, info.size)
        current.mtimeMs = Math.max(current.mtimeMs, info.mtimeMs)
      } else if (!current || info.mtimeMs > current.mtimeMs) {
        bySession.set(key, {
          agent: root.agent,
          path,
          sessionId,
          size: info.size,
          mtimeMs: info.mtimeMs,
          aliases: [path]
        })
        if (inode) {
          inodes.set(key, inode)
        } else {
          inodes.delete(key)
        }
      }
    }
  }
  listingCache = cache.next
  aliasCache = nextAliases
  return [...bySession.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
}
