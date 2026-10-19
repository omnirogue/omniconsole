import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { DeliverableEntry, DeliverablesHubResult } from '../../shared/deliverables-hub'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next'])
const MAX_FILES = 10_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const CACHE_MS = 15_000

type IndexedEntry = DeliverableEntry & { searchText: string }
type Snapshot = { root: string; entries: IndexedEntry[]; skipped: number; scannedAt: number }
let snapshot: Snapshot | null = null
let scanning: Promise<Snapshot> | null = null

export function plansRoot(): string {
  return join(homedir(), 'Work', 'Ops', 'Plans')
}

function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`)
}

function titleOf(content: string, filename: string): string {
  return (
    content
      .match(/^#\s+(.+)$/m)?.[1]
      ?.trim()
      .slice(0, 180) || filename.replace(/\.md$/i, '')
  )
}

function excerptOf(content: string): string {
  return content
    .replace(/^---\s*[\s\S]*?\n---\s*/u, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

async function scanPlans(): Promise<Snapshot> {
  const root = await realpath(plansRoot())
  const entries: IndexedEntry[] = []
  let skipped = 0
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()!
    let children: Dirent[]
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      skipped++
      continue
    }
    for (const child of children) {
      if (entries.length >= MAX_FILES) {
        skipped++
        continue
      }
      const path = join(dir, child.name)
      if (child.isDirectory()) {
        if (!SKIP_DIRS.has(child.name)) {
          pending.push(path)
        }
        continue
      }
      if (!child.isFile() || !/\.md$/i.test(child.name)) {
        continue
      }
      try {
        const real = await realpath(path)
        if (!withinRoot(root, real)) {
          skipped++
          continue
        }
        const info = await stat(real)
        if (info.size > MAX_FILE_BYTES) {
          skipped++
          continue
        }
        const body = await readFile(real, 'utf8')
        const relativePath = relative(root, real)
        entries.push({
          relativePath,
          title: titleOf(body, child.name),
          taskId: relativePath.match(/\bW\d+-\d+\b/i)?.[0]?.toUpperCase() ?? null,
          modifiedAt: info.mtimeMs,
          excerpt: excerptOf(body),
          searchText: `${relativePath}\n${body}`.toLocaleLowerCase()
        })
      } catch {
        skipped++
      }
    }
  }
  entries.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return { root, entries, skipped, scannedAt: Date.now() }
}

async function getSnapshot(refresh: boolean): Promise<Snapshot> {
  if (!refresh && snapshot && Date.now() - snapshot.scannedAt < CACHE_MS) {
    return snapshot
  }
  if (!scanning) {
    scanning = scanPlans()
      .then((result) => {
        snapshot = result
        return result
      })
      .finally(() => {
        scanning = null
      })
  }
  return scanning
}

export async function searchPlans(query: string, refresh = false): Promise<DeliverablesHubResult> {
  const index = await getSnapshot(refresh)
  const terms = query.trim().slice(0, 200).toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matched = terms.length
    ? index.entries.filter((entry) => terms.every((term) => entry.searchText.includes(term)))
    : index.entries
  return {
    root: index.root,
    total: matched.length,
    skipped: index.skipped,
    entries: matched.map(({ searchText: _searchText, ...entry }) => entry)
  }
}

export async function resolvePlan(relativePath: string, modifiedAt: number): Promise<string> {
  if (typeof relativePath !== 'string' || !relativePath.endsWith('.md')) {
    throw new Error('Invalid deliverable path')
  }
  const root = await realpath(plansRoot())
  const candidate = resolve(root, relativePath)
  if (!withinRoot(root, candidate)) {
    throw new Error('Deliverable is outside Plans')
  }
  const real = await realpath(candidate)
  if (!withinRoot(root, real)) {
    throw new Error('Deliverable is outside Plans')
  }
  const info = await stat(real)
  if (!info.isFile() || info.mtimeMs !== modifiedAt) {
    throw new Error('Deliverable changed. Refresh the Hub before launching.')
  }
  return real
}
