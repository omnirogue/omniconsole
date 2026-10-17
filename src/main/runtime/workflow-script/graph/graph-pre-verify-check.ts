import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { readWorkspaceWholeFile, resolveInsideWorkspace } from '../../workspace-whole-file'
import {
  graphMatchExcerpt,
  type GraphEvidenceCheck,
  type GraphEvidenceRequest
} from './graph-evidence-check'
import {
  graphCitationText as cited,
  type GraphCitation,
  type GraphCitationCheck,
  type GraphPreVerify,
  type GraphPreVerifyItem,
  type GraphSearchCheck
} from './graph-pre-verify'
import {
  findGraphQuote,
  listGraphWorkspaceFiles,
  runGraphSearch,
  type GraphSearchRun
} from './graph-pre-verify-search'

/** One round re-runs at most this many searches; later ones are reported as not re-run. */
const MAX_SEARCHES = 30

type Located =
  | { state: 'file'; content: string; at?: string }
  | { state: 'absent' }
  | { state: 'unknown'; why: string; flag?: true }

const countLines = (content: string) => {
  const lines = content.split(/\r?\n/)
  return lines.length - (lines.at(-1) === '' ? 1 : 0)
}

/** Shared by every result of one check: each file is read, and the workspace listed, once. */
function workspaceReader(root: string, run?: GraphSearchRun) {
  const reads = new Map<string, Promise<Located>>()
  let listing: Promise<string[] | undefined> | undefined
  const direct = async (file: string): Promise<Located | undefined> => {
    if (await resolveInsideWorkspace(root, file)) {
      const content = await readWorkspaceWholeFile(root, file)
      return content === null
        ? { state: 'unknown', why: 'a folder, or too large to read whole' }
        : { state: 'file', content }
    }
    const rel = relative(resolve(root), resolve(root, file))
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { state: 'unknown', why: 'outside the workspace', flag: true }
    }
    const exists = await lstat(resolve(root, file)).then(
      () => true,
      () => false
    )
    return exists ? { state: 'unknown', why: 'a link out of the workspace', flag: true } : undefined
  }
  // A path cited without its folder (a context folder's, or a shortened one) is the one file ending so.
  const elsewhere = async (file: string): Promise<Located> => {
    listing ??= listGraphWorkspaceFiles(root, run)
    const files = await listing
    if (!files) {
      return { state: 'unknown', why: "the workspace's files could not be listed" }
    }
    const tail = file.replace(/^\.\//, '')
    const matches = files.filter((path) => path === tail || path.endsWith(`/${tail}`))
    if (matches.length > 1) {
      return { state: 'unknown', why: `${matches.length} files end with this path` }
    }
    if (!matches.length) {
      return { state: 'absent' }
    }
    const found = await direct(matches[0]!)
    return found?.state === 'file' ? { ...found, at: matches[0]! } : (found ?? { state: 'absent' })
  }
  return {
    locate: (file: string) => {
      if (!reads.has(file)) {
        reads.set(
          file,
          direct(file).then((found) => found ?? elsewhere(file))
        )
      }
      return reads.get(file)!
    }
  }
}

function checkCitation(citation: GraphCitation, located: Located): GraphCitationCheck {
  if (located.state !== 'file') {
    return located.state === 'absent'
      ? { ...citation, status: 'absent' }
      : { ...citation, status: 'unknown', why: located.why }
  }
  const lines = countLines(located.content)
  const past = (citation.line ?? 0) > lines || (citation.end ?? 0) > lines
  return {
    ...citation,
    status: past ? 'past-end' : 'ok',
    lines,
    ...(located.at ? { at: located.at } : {})
  }
}

function citationFlag(check: GraphCitationCheck, located: Located): string | undefined {
  if (check.status === 'absent') {
    return `${cited(check)} is not a file in the workspace.`
  }
  if (check.status === 'past-end') {
    return `${cited(check)} is past the end of the file (${check.lines} lines).`
  }
  return located.state === 'unknown' && located.flag
    ? `${cited(check)} is ${located.why}.`
    : undefined
}

function searchFlag(check: GraphSearchCheck, absence: string): string | undefined {
  if (check.error) {
    return `Its search \`${check.search}\` could not be re-run (${check.error}).`
  }
  return check.hits?.length
    ? `It says "${absence}", but its search \`${check.search}\` matches at ${check.hits.join(', ')}${check.more ? ' and more' : ''}.`
    : undefined
}

/** Dropped only when every citation is a file the workspace does not have and the quote is nowhere. */
async function dropCheck(
  item: GraphPreVerifyItem,
  citations: GraphCitationCheck[],
  root: string,
  run?: GraphSearchRun
): Promise<{ dropped?: string; flag?: string }> {
  if (!item.code || !citations.length || citations.some((check) => check.status !== 'absent')) {
    return {}
  }
  const holders: string[] = []
  for (const probe of item.probes ?? (item.probe ? [item.probe] : [])) {
    const found = await findGraphQuote(probe, root, run)
    if (!found) {
      return {}
    }
    holders.push(...found)
    if (holders.length) {
      break
    }
  }
  if (holders.length) {
    const named = holders.slice(0, 3).map((file) => `\`${file}\``)
    return { flag: `Its quote is in ${named.join(', ')}, not in any file it cites.` }
  }
  return {
    dropped: `None of the files it cites exists in the workspace: ${citations.map(cited).join(', ')}.`
  }
}

export type GraphPreVerifyResult = {
  preVerify: Record<string, GraphPreVerify>
  /** The quote checks, with any the app could only read at the file's real path re-checked there. */
  checks: Record<string, GraphEvidenceCheck>
}

/**
 * Before any reviewer: every cited path and line against the workspace, and every absence search
 * re-run with rg. Anything wrong is a flag the reviewer reads; only a result none of whose
 * citations resolves is dropped.
 */
export async function checkGraphPreVerify(
  request: GraphEvidenceRequest,
  root: string,
  quoteChecks: Record<string, GraphEvidenceCheck>,
  run?: GraphSearchRun
): Promise<GraphPreVerifyResult> {
  const reader = workspaceReader(root, run)
  const checks = { ...quoteChecks }
  const preVerify: Record<string, GraphPreVerify> = {}
  let searchesLeft = MAX_SEARCHES
  for (const item of request.preVerify ?? []) {
    const flags: string[] = []
    const citations: GraphCitationCheck[] = []
    for (const [index, citation] of item.citations.entries()) {
      const located = await reader.locate(citation.file)
      const check = checkCitation(citation, located)
      citations.push(check)
      const flag = citationFlag(check, located)
      if (flag) {
        flags.push(flag)
      }
      const quote = request.items.find((entry) => entry.key === item.key)
      if (item.code && index === 0 && located.state === 'file' && located.at && quote) {
        checks[item.key] = graphMatchExcerpt(located.content, quote.excerpt, quote.line)
      }
    }
    if (checks[item.key]?.status === 'missing') {
      flags.push('Its quote is not in the file it names, even with whitespace ignored.')
    }
    if (item.absence && !item.searches.length) {
      flags.push(`It says "${item.absence}" but gives no search that shows it.`)
    }
    const searches: GraphSearchCheck[] = []
    for (const search of item.searches) {
      const check =
        searchesLeft-- > 0
          ? await runGraphSearch(search, root, run)
          : { search, error: `the app re-runs at most ${MAX_SEARCHES} searches a round` }
      searches.push(check)
      const flag = searchFlag(check, item.absence ?? '')
      if (flag && !check.error?.startsWith('the app re-runs at most')) {
        flags.push(flag)
      }
    }
    const drop = await dropCheck(item, citations, root, run)
    preVerify[item.key] = {
      citations,
      ...(item.absence ? { absence: item.absence } : {}),
      searches,
      flags: drop.flag ? [...flags, drop.flag] : flags,
      ...(drop.dropped ? { dropped: drop.dropped } : {})
    }
  }
  return { preVerify, checks }
}
