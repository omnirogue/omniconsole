/**
 * A rejected review deletes its conversation for good (Sal's decision 1, OAOS-12): every copy of
 * the transcript under every account home on this computer, with Claude's `<id>/` folder (its
 * subagents) and `session-env/<id>/`, or every hard link of a Codex rollout and its line in each
 * home's `session_index.jsonl`, so no bridge can relink it. Only files whose name is this exact
 * conversation id, found in the bounded roots session search uses, are touched.
 */

import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { SessionReferenceAgent } from '../../shared/session-reference'
import {
  discoverTranscriptRoots,
  findTranscriptFiles,
  type TranscriptRoot
} from '../session-search/session-search-roots'
import { subagentTranscriptsDirFor } from '../ai-vault/session-scanner-subagent-transcripts'

export type TranscriptPurge = { removed: string[]; failed: string[] }

const SESSION_ID = /^[A-Za-z0-9-]{8,128}$/

function indexLineId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { id?: unknown; session_id?: unknown }
    const id = parsed.id ?? parsed.session_id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/** The Codex homes hold one index line per conversation; drop this conversation's lines. */
async function dropCodexIndexLines(home: string, sessionId: string): Promise<boolean> {
  const path = join(home, 'session_index.jsonl')
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) {
    return false
  }
  const lines = text.split('\n')
  const kept = lines.filter((line) => indexLineId(line)?.toLowerCase() !== sessionId.toLowerCase())
  if (kept.length === lines.length) {
    return false
  }
  // Why write-then-rename: a reader never sees a half-written index.
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, kept.join('\n'), 'utf8')
  await rename(temporary, path)
  return true
}

export async function purgeConversationTranscripts(
  agent: SessionReferenceAgent,
  sessionId: string,
  options: {
    userDataPath: string
    homeDir?: string
    extraRoots?: readonly TranscriptRoot[]
    /** The path recorded at publish; deleted too when it sits under a known root. */
    transcriptPath?: string
  }
): Promise<TranscriptPurge> {
  const purge: TranscriptPurge = { removed: [], failed: [] }
  // Why: a malformed id could match more than its own files through the companion paths.
  if (!SESSION_ID.test(sessionId)) {
    purge.failed.push(`conversation id ${sessionId} is not a provider session id`)
    return purge
  }
  const discovered = await discoverTranscriptRoots({
    homeDir: options.homeDir ?? homedir(),
    appDataDirs: [options.userDataPath],
    ...(options.extraRoots ? { extraRoots: options.extraRoots } : {})
  })
  // Why archived_sessions: Codex moves a rollout there, and its index still names the id.
  const roots = [
    ...discovered,
    ...discovered
      .filter((root) => root.agent === 'codex')
      .map((root) => ({ ...root, dir: join(dirname(root.dir), 'archived_sessions') }))
  ]
  const targets = new Set<string>()
  const codexHomes = new Set<string>()
  // Why realpath: the roots are canonical (macOS /var is /private/var), the recorded path may not be.
  const recorded = options.transcriptPath
    ? await realpath(resolve(options.transcriptPath)).catch(() => resolve(options.transcriptPath!))
    : null
  const recordedRoot = recorded
    ? roots.find(
        (root) => root.agent === agent && recorded.startsWith(`${resolve(root.dir)}${sep}`)
      )
    : undefined
  const found = await findTranscriptFiles(roots, agent, sessionId)
  if (
    recorded &&
    recordedRoot &&
    recorded.endsWith('.jsonl') &&
    !found.some((file) => resolve(file.path) === recorded)
  ) {
    // Claude may name the file with a different UUID than the session id it reports.
    found.push({ root: recordedRoot, path: recorded })
  }
  for (const { root, path } of found) {
    targets.add(path)
    if (agent === 'claude') {
      // `<project>/<id>/` (subagents) and the home's `session-env/<id>/`; file-history is the
      // person's own files' rewind buffer, so it stays, as the AI Vault delete keeps it.
      targets.add(dirname(subagentTranscriptsDirFor(path)))
      targets.add(join(dirname(root.dir), 'session-env', sessionId))
    } else {
      codexHomes.add(dirname(root.dir))
    }
  }
  for (const target of targets) {
    if (
      !(await lstat(target).then(
        () => true,
        () => false
      ))
    ) {
      continue
    }
    try {
      await rm(target, { recursive: true, force: true })
      purge.removed.push(target)
    } catch {
      purge.failed.push(target)
    }
  }
  for (const home of codexHomes) {
    try {
      if (await dropCodexIndexLines(home, sessionId)) {
        purge.removed.push(join(home, 'session_index.jsonl'))
      }
    } catch {
      purge.failed.push(join(home, 'session_index.jsonl'))
    }
  }
  return purge
}
