import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runWorkflowHelperProcess } from '../workflow-process-group'
import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import {
  WORKFLOW_CHECK_PREPARE_SECONDS,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import type { LocalWorkflowHostSnapshot } from '../local-workflow-host-snapshot'
import { assertWorkflowWorkspaceRoot } from '../local-workflow-workspace-root'
import { graphCheckArgv, graphCheckEnvironment } from './graph-check-launch'
import { graphExecutionFolder } from './graph-jev-store'

const GIT_TIMEOUT_MS = 60_000
// A clone shares the repository's objects, but checking out a large tree can still take a while.
const COPY_TIMEOUT_MS = 10 * 60_000
const OUTPUT_BYTES = 256 * 1024
const DETAIL_CHARS = 2_000

/** One Git command in a private copy (or its folder); a failure throws with Git's own words. */
export async function graphLaneGit(
  cwd: string,
  args: string[],
  options: { signal?: AbortSignal; stdin?: string; timeoutMs?: number } = {}
): Promise<string> {
  const { stdout } = await gitExecFileAsync([...windowsLongPathGitArgs(cwd), ...args], {
    cwd,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    terminationBarrier: true,
    // Checks wait behind the person's own Git work, never ahead of it.
    admissionTier: 'background',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {})
  })
  return stdout
}

/** Git's exit code and message from a failed `graphLaneGit`. */
export function graphLaneGitFailure(error: unknown): { code?: number; message: string } {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...(typeof code === 'number' ? { code } : {}),
    message: message.trim().slice(-DETAIL_CHARS) || 'Git failed.'
  }
}

export type GraphCheckLane = { path: string }

// The copies folders of runs live in this process: the app-start sweep never touches these.
const LANES_IN_USE = new Set<string>()

/** Whether a live run of this process owns this `<run>/lanes` folder. */
export function graphCheckLanesInUse(folder: string): boolean {
  return LANES_IN_USE.has(folder)
}

type GraphCheckLanesOptions = {
  /** `<run>/lanes`: the run's own folder for its copies. */
  folder: string
  /** The person's repository, still the folder admitted with the run. */
  root: () => Promise<string>
  /** The commit frozen at admission; every copy starts from it. */
  sourceBase: string
  /** The run's Stop. */
  signal?: AbortSignal
}

/**
 * A run's private copies of the person's repository (`<run>/lanes/<n>`). Each is its own clone
 * that borrows the repository's objects (`clone --shared`), never a worktree, so nothing appears
 * in the person's repository or sidebar. A copy is made on first need and got ready once (the
 * person's `prepare`); before every later use it is reset to the frozen commit, keeping only the
 * files Git ignores (the dependencies it got ready). A copy that could not be made gives a
 * reason, never a copy. All are removed when the run settles, and swept when it starts again.
 */
export class GraphCheckLanes {
  private readonly free: GraphCheckLane[] = []
  private readonly removals = new Set<Promise<void>>()
  private next = 0
  private swept?: Promise<void>
  private disposed?: Promise<void>
  /** Why no copy can be made: the first failure, so later versions do not repeat it. */
  private refused?: string

  constructor(private readonly options: GraphCheckLanesOptions) {
    LANES_IN_USE.add(options.folder)
    if (!/^[a-f0-9]{40,64}$/.test(options.sourceBase)) {
      this.refused = 'The run has no saved commit to copy.'
    }
  }

  /** A copy at the frozen commit: a free one reset, else (or when `fresh`) a new one got ready. */
  async acquire(prepare?: string, fresh = false): Promise<GraphCheckLane> {
    if (this.disposed || this.refused) {
      throw new Error(this.refused ?? 'This run has finished.')
    }
    // Copies an earlier, interrupted attempt of this run left behind are never reused.
    await (this.swept ??= rm(this.options.folder, { recursive: true, force: true }).catch(() => {}))
    for (let lane = fresh ? undefined : this.free.pop(); lane; lane = this.free.pop()) {
      try {
        await this.reset(lane)
        return lane
      } catch (error) {
        this.discard(lane)
        this.stopped(error)
      }
    }
    return this.create(prepare)
  }

  /** A copy whose state is known goes back for the next version. */
  release(lane: GraphCheckLane): void {
    if (this.disposed) {
      this.discard(lane)
    } else {
      this.free.push(lane)
    }
  }

  /** A copy in an unknown state is removed, never reused. */
  discard(lane: GraphCheckLane): void {
    const removal = rm(lane.path, { recursive: true, force: true }).catch(() => {})
    this.removals.add(removal)
    void removal.finally(() => this.removals.delete(removal))
  }

  /** Removes every copy; the run needs none once it settles. Never throws. */
  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      this.free.length = 0
      await Promise.all(this.removals)
      await rm(this.options.folder, { recursive: true, force: true }).catch(() => {})
      LANES_IN_USE.delete(this.options.folder)
    })()
    return this.disposed
  }

  private stopped(error: unknown): void {
    if (this.options.signal?.aborted) {
      throw this.options.signal.reason ?? error
    }
  }

  private async create(prepare: string | undefined): Promise<GraphCheckLane> {
    const lane = { path: join(this.options.folder, String(this.next++)) }
    const { signal, sourceBase } = this.options
    try {
      const root = await this.options.root()
      await mkdir(this.options.folder, { recursive: true })
      await graphLaneGit(
        this.options.folder,
        ['clone', '--no-checkout', '--shared', '--quiet', '--', root, lane.path],
        { timeoutMs: COPY_TIMEOUT_MS, ...(signal ? { signal } : {}) }
      )
      await graphLaneGit(lane.path, ['checkout', '--quiet', '--detach', sourceBase, '--'], {
        timeoutMs: COPY_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      })
      if (prepare?.trim()) {
        await this.prepare(lane, prepare)
      }
      return lane
    } catch (error) {
      this.discard(lane)
      this.stopped(error)
      this.refused = error instanceof Error ? error.message.trim() : String(error)
      throw new Error(this.refused)
    }
  }

  private async reset(lane: GraphCheckLane): Promise<void> {
    const signal = this.options.signal
    const options = { timeoutMs: COPY_TIMEOUT_MS, ...(signal ? { signal } : {}) }
    await graphLaneGit(
      lane.path,
      ['checkout', '--quiet', '--force', '--detach', this.options.sourceBase, '--'],
      options
    )
    await graphLaneGit(lane.path, ['clean', '-ffdq'], options)
  }

  /** The person's own command, once per copy, without a shell or the app's keys. */
  private async prepare(lane: GraphCheckLane, command: string): Promise<void> {
    const argv = graphCheckArgv(command)
    const seconds = WORKFLOW_CHECK_PREPARE_SECONDS
    const run = await runWorkflowHelperProcess({
      program: argv[0]!,
      args: argv.slice(1),
      cwd: lane.path,
      env: graphCheckEnvironment(process.env, {}),
      timeoutMs: seconds * 1000,
      maxOutputBytes: OUTPUT_BYTES,
      outputCapture: 'tail',
      terminationBarrier: true,
      ...(this.options.signal ? { signal: this.options.signal } : {})
    }).catch((error: unknown) => {
      throw new Error(
        `Getting ready (\`${command}\`) could not start: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    this.stopped(new Error('Workflow stopped'))
    if (run.timedOut || run.code !== 0) {
      const tail = [run.stdout, run.stderr].join('\n').trim().slice(-DETAIL_CHARS)
      const how = run.timedOut ? `timed out after ${seconds}s` : `exited with code ${run.code}`
      throw new Error(`Getting ready (\`${command}\`) ${how}.${tail ? `\n${tail}` : ''}`)
    }
  }
}

/** A live run's private copies when its versions are changes to the code; none otherwise. */
export function graphCheckLanesForRun(
  executionId: string,
  snapshot: Pick<LocalWorkflowHostSnapshot, 'host'> & { graph?: { spec: WorkflowSpec } },
  signal?: AbortSignal
): GraphCheckLanes | undefined {
  if (snapshot.graph?.spec.repeat?.check?.apply !== 'patch') {
    return undefined
  }
  return new GraphCheckLanes({
    folder: join(graphExecutionFolder(executionId), 'lanes'),
    root: () => assertWorkflowWorkspaceRoot(snapshot),
    sourceBase: snapshot.host.checkSource?.sourceBase ?? '',
    ...(signal ? { signal } : {})
  })
}
