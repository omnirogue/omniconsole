/**
 * Where a continued turn's output is kept.
 *
 * A worker's report lives in its Task row; a turn of the ORIGINAL conversation has no Task, so
 * its report is written where every step's output already belongs — `.omni/runs/<chain>/<step>/`
 * — and read back from there. That makes the two indistinguishable downstream: `readsFrom`
 * excerpts, the review candidate version and the verdict consumer all go through
 * `sessionOutcomeResultBody`, which reads this file for a continued step and the Task for a
 * worker. Nothing else about the step changes.
 *
 * The folder is created one part at a time and refused if any part is a link or moved, the same
 * guard the source packet uses: a report path is inside the execution workspace or it is not
 * written at all.
 */

import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { sessionChainStepOutputDir, type SessionChain } from '../../shared/session-chain-types'

/** The same ceiling the source packet and the worker brief enforce. */
export const CONVERSATION_REPORT_MAX_CHARS = 100_000

export const CONVERSATION_REPORT_UNAVAILABLE =
  'No readable final response was retained for this turn of the conversation.'

export function conversationReportPath(chain: SessionChain, stepId: string): string {
  return join(sessionChainStepOutputDir(chain.workspacePath, chain.id, stepId), 'report.md')
}

async function ensureReportDirectory(chain: SessionChain, stepId: string): Promise<string> {
  const root = await realpath(chain.workspacePath)
  const path = sessionChainStepOutputDir(root, chain.id, stepId)
  const rel = relative(root, path)
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error("This step's report must stay inside its execution workspace.")
  }
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }
    })
    if (!(await lstat(current)).isDirectory() || (await realpath(current)) !== current) {
      throw new Error("This step's report folder changed or contains a symbolic link.")
    }
  }
  return current
}

/**
 * Write what the continued conversation answered, and return the path it was written to. An
 * oversized report is REFUSED rather than trimmed: the next step's brief could not carry it, and
 * a silently cut report is a report nobody can trust.
 */
export async function writeConversationReport(
  chain: SessionChain,
  stepId: string,
  body: string
): Promise<string> {
  if (body.length > CONVERSATION_REPORT_MAX_CHARS) {
    throw new Error(
      `The continued conversation answered with ${body.length} characters; a step report carries up to ${CONVERSATION_REPORT_MAX_CHARS}. Ask it for a concise final response naming the workspace file that holds the rest.`
    )
  }
  const directory = await ensureReportDirectory(chain, stepId)
  const path = join(directory, 'report.md')
  await writeFile(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  // Read back through the same door the readers use, so a report that cannot be read again is
  // discovered here — while the attempt can still be recorded as unsettled — not by its reader.
  const written = await readFile(path, 'utf8')
  if (written.trim() !== body.trim()) {
    throw new Error("This step's report could not be read back after it was written.")
  }
  return path
}

/** The report of a continued step, for every reader that asks a worker's Task the same thing. */
export function readConversationReport(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}
