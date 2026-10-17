import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorkflowHelperProcess } from '../workflow-process-group'
import type { ProcessResult, ProcessSpec } from '../../../../shared/child-process/process-spec'
import { runGraphPatchCheck } from './graph-check-apply'
import { graphCheckVerdict, runGraphCheckCases, type GraphCheckLaunch } from './graph-check-cases'
import type { GraphCheckLanes } from './graph-check-lane'
import { graphCheckArgv, graphCheckEnvironment } from './graph-check-launch'
import { GraphJevStore } from './graph-jev-store'
import type {
  GraphCall,
  GraphCheckRequest,
  GraphCheckResult,
  GraphOutcome
} from './graph-plan-types'

const CHECK_TIMEOUT_MS = 180_000
const MAX_OUTPUT_BYTES = 256 * 1024
const INTERRUPTED =
  'The check was interrupted before its result was saved. It is not run twice, because a command may change things.'

const EXTENSIONS: Record<string, string> = {
  js: 'js',
  javascript: 'js',
  mjs: 'mjs',
  ts: 'ts',
  typescript: 'ts',
  py: 'py',
  python: 'py',
  sh: 'sh',
  bash: 'sh',
  json: 'json',
  go: 'go',
  rs: 'rs',
  rust: 'rs',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  rb: 'rb',
  ruby: 'rb',
  sql: 'sql',
  lean: 'lean'
}

/** The version's largest fenced code block, with a file extension from its language. */
export function graphCandidateCode(
  markdown: string
): { code: string; extension: string } | undefined {
  const blocks = [...markdown.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].map((match) => ({
    language: (match[1] ?? '').toLowerCase(),
    code: match[2] ?? ''
  }))
  const largest = blocks.sort((left, right) => right.code.length - left.code.length)[0]
  return largest?.code.trim()
    ? { code: largest.code, extension: EXTENSIONS[largest.language] ?? 'txt' }
    : undefined
}

/**
 * Runs the person's check on one version in `cwd`. The version is written to a private temp
 * file ({candidate}, $OMNI_CANDIDATE_FILE), and its largest code block to its own file ({code},
 * $OMNI_CANDIDATE_CODE_FILE). The command runs without a shell and without the app's secrets,
 * and a time limit or Stop ends its whole process tree before the result settles. With practice
 * cases it runs once per case (graph-check-cases.ts).
 */
export async function runGraphCheck(
  request: GraphCheckRequest,
  options: {
    cwd: string
    run?: (spec: ProcessSpec) => Promise<ProcessResult>
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<GraphCheckResult> {
  const argv = graphCheckArgv(request.command)
  if (!argv.length) {
    return { passed: false, unavailable: true, detail: 'The check command is empty.' }
  }
  const dir = await mkdtemp(join(tmpdir(), 'omni-check-'))
  try {
    const candidateFile = join(dir, 'candidate.md')
    await writeFile(candidateFile, request.candidate, { mode: 0o600 })
    const code = graphCandidateCode(request.candidate)
    const codeFile = code ? join(dir, `candidate.${code.extension}`) : candidateFile
    if (code) {
      await writeFile(codeFile, code.code, { mode: 0o600 })
    }
    const launch: GraphCheckLaunch = async ({ values, env, timeoutMs }) => {
      // A case's own text is filled in last, so a placeholder inside it stays literal.
      const fill = (value: string) =>
        Object.entries(values).reduce(
          (text, [key, replacement]) => text.replaceAll(key, replacement),
          value.replaceAll('{candidate}', candidateFile).replaceAll('{code}', codeFile)
        )
      try {
        return await (options.run ?? runWorkflowHelperProcess)({
          program: fill(argv[0]!),
          args: argv.slice(1).map(fill),
          cwd: options.cwd,
          env: graphCheckEnvironment(process.env, {
            OMNI_CANDIDATE_FILE: candidateFile,
            OMNI_CANDIDATE_CODE_FILE: codeFile,
            ...env
          }),
          timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          outputCapture: 'tail',
          terminationBarrier: true,
          ...(options.signal ? { signal: options.signal } : {})
        })
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
    const timeoutMs =
      request.timeoutSeconds !== undefined
        ? request.timeoutSeconds * 1000
        : (options.timeoutMs ?? CHECK_TIMEOUT_MS)
    if (request.cases?.length) {
      return await runGraphCheckCases(
        { ...request, cases: request.cases },
        { dir, launch, timeoutMs, ...(options.signal ? { signal: options.signal } : {}) }
      )
    }
    const run = await launch({ values: {}, env: {}, timeoutMs })
    return graphCheckVerdict(run, timeoutMs, request.scoreLastLine === true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function checkMarkdown(request: GraphCheckRequest, result: GraphCheckResult): string {
  const verdict = result.passed ? 'Check passed' : 'Check failed'
  const score = result.score !== undefined ? ` · SCORE ${result.score}` : ''
  const cases = result.cases ? ` · ${result.cases.passed} of ${result.cases.total} cases` : ''
  const where = request.apply === 'patch' ? ' · in a private copy' : ''
  return `**${verdict}**${score}${cases} · \`${request.command}\`${where}\n\n\`\`\`\n${result.detail}\n\`\`\``
}

export type GraphCheckerOptions = {
  store: GraphJevStore
  /** Checks that started: one whose result was lost is never run a second time. */
  starts: GraphJevStore
  /** The verified workspace folder the check runs in; a refusal is reported as the result. */
  workspace?: () => Promise<string>
  /** Changes to the code: the run's private copies, where each is applied and tested instead. */
  lanes?: GraphCheckLanes
  /** Only what the store already holds: recovery replays results and never runs a command. */
  cacheOnly?: boolean
  run?: (spec: ProcessSpec) => Promise<ProcessResult>
  /** The run's Stop: it ends a running check, and nothing is recorded for it. */
  signal?: AbortSignal
  /** One of the run's process slots, which checks share with its agents. */
  slot?: <T>(work: () => Promise<T>) => Promise<T>
}

const direct = <T>(work: () => Promise<T>): Promise<T> => work()

/**
 * The `GraphConfig.checkCandidate` of one run: each version is checked once and its result kept,
 * so the run replays it and never runs the command again for the same version.
 */
export function createGraphChecker(options: GraphCheckerOptions) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.check!
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    if (options.cacheOnly) {
      throw new Error(`Check is not recorded: ${call.id}`)
    }
    const record = (result: GraphCheckResult): GraphOutcome => {
      const outcome: GraphOutcome = {
        value: { markdown: checkMarkdown(request, result), ...result }
      }
      options.store.write(call.id, { digest, outcome, at: Date.now() })
      return outcome
    }
    if (options.starts.read(call.id)?.digest === digest) {
      return record({ passed: false, unavailable: true, detail: INTERRUPTED })
    }
    const test = (cwd: string) =>
      runGraphCheck(request, {
        cwd,
        ...(options.run ? { run: options.run } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      })
    let execute: (() => Promise<GraphCheckResult>) | undefined
    let refused = 'The check runs in the workspace, and this run has none.'
    if (request.apply === 'patch') {
      // A change to the code runs only in a private copy, never in the person's folder.
      const lanes = options.lanes
      refused = 'A change to your code is tested in a private copy, and this run has none.'
      execute = lanes
        ? () =>
            runGraphPatchCheck(request, {
              lanes,
              test,
              ...(options.signal ? { signal: options.signal } : {})
            })
        : undefined
    } else {
      try {
        const cwd = options.workspace ? await options.workspace() : undefined
        execute = cwd ? () => test(cwd) : undefined
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error)
      }
    }
    if (!execute) {
      return record({ passed: false, unavailable: true, detail: refused })
    }
    const work = execute
    return (options.slot ?? direct)(async () => {
      options.signal?.throwIfAborted()
      // Written before the command starts; when it cannot be, nothing runs.
      options.starts.write(call.id, { digest, outcome: { failed: true }, at: Date.now() })
      // A Stop while a private copy was got ready throws; either way nothing ran to the end.
      const result = await work().catch((error: unknown) => {
        if (options.signal?.aborted) {
          return undefined
        }
        throw error
      })
      if (!result || options.signal?.aborted) {
        // Its process tree has ended unfinished, so a resumed run checks this version afresh.
        options.starts.remove(call.id)
        throw options.signal?.reason ?? new Error('Workflow stopped')
      }
      return record(result)
    })
  }
}

/** One run's checker; its record files are opened only when a check actually comes. */
export function graphCheckerForExecution(
  executionId: string,
  options: Omit<GraphCheckerOptions, 'store' | 'starts'>
): (call: GraphCall) => Promise<GraphOutcome> {
  let checker: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    checker ??= createGraphChecker({
      ...options,
      store: GraphJevStore.forExecution(executionId, undefined, 'checks.json'),
      starts: GraphJevStore.forExecution(executionId, undefined, 'check-starts.json')
    })
    return checker(call)
  }
}
