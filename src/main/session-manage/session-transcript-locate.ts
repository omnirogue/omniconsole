/**
 * Where a closed Claude or Codex conversation's transcript is on this computer, and what it needs
 * to resume: the profile home it lives under (its account) and the folder it ran in. Found in the
 * same bounded roots session search indexes, never by walking $HOME.
 */

import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionReferenceAgent } from '../../shared/session-reference'
import {
  discoverTranscriptRoots,
  findTranscriptFiles,
  type TranscriptRoot
} from '../session-search/session-search-roots'
import { readTranscriptLine } from '../session-search/transcript-search-records'

export type LocatedTranscript = {
  path: string
  /** CLAUDE_CONFIG_DIR / CODEX_HOME: the parent of the root's `projects` / `sessions`. */
  providerRoot: string
  /** `~/.claude` or `~/.codex`, which resume without a profile variable. */
  defaultRoot: boolean
}

/**
 * Every copy under every known profile; the caller refuses anything but exactly one. A file
 * reached under several homes is one conversation: OmniConsole hardlinks Codex history into
 * every managed account's home so it resumes under any of them (runtime-home-service).
 */
export async function locateTranscripts(
  agent: SessionReferenceAgent,
  sessionId: string,
  options: { userDataPath: string; homeDir?: string; extraRoots?: readonly TranscriptRoot[] }
): Promise<LocatedTranscript[]> {
  const homeDir = options.homeDir ?? homedir()
  const roots = await discoverTranscriptRoots({
    homeDir,
    appDataDirs: [options.userDataPath],
    ...(options.extraRoots ? { extraRoots: options.extraRoots } : {})
  })
  const home = join(homeDir, agent === 'claude' ? '.claude' : '.codex')
  const defaultHome = await realpath(home).catch(() => home)
  const located = (await findTranscriptFiles(roots, agent, sessionId)).map(({ root, path }) => {
    const providerRoot = dirname(root.dir)
    return { path, providerRoot, defaultRoot: providerRoot === defaultHome }
  })
  return located.length > 1 ? distinctFiles(located) : located
}

/** One entry per file on disk: the default home's link first, else the first path in order. */
async function distinctFiles(located: LocatedTranscript[]): Promise<LocatedTranscript[]> {
  const ordered = located.toSorted(
    (a, b) => Number(b.defaultRoot) - Number(a.defaultRoot) || a.path.localeCompare(b.path)
  )
  const seen = new Set<string>()
  const distinct: LocatedTranscript[] = []
  for (const entry of ordered) {
    const info = await stat(entry.path).catch(() => null)
    // Why: an unreadable copy cannot be proven the same file, so it stays and reads as ambiguous.
    const identity = info ? `${info.dev}:${info.ino}` : entry.path
    if (!seen.has(identity)) {
      seen.add(identity)
      distinct.push(entry)
    }
  }
  return distinct
}

const CWD_SCAN_LINES = 400

/** The folder the conversation ran in: the first `cwd` its transcript records. */
export async function readTranscriptCwd(
  agent: SessionReferenceAgent,
  path: string
): Promise<string | null> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let scanned = 0
  try {
    for await (const line of lines) {
      const cwd = readTranscriptLine(agent, line)?.cwd
      if (cwd) {
        return cwd
      }
      scanned += 1
      if (scanned >= CWD_SCAN_LINES) {
        return null
      }
    }
    return null
  } catch {
    return null
  } finally {
    lines.close()
    stream.destroy()
  }
}
