import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../omni-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { LocalRunService } from './local-run-service'
import { createOrchestrationCaller, type OrchestrationCaller } from './build-review-rpc-call'
import { setLocalRunDeliverer } from './local-run-deliver'

/** The Phase 2 acceptance shape: research → plan → three parallel implements → synthesize → verify. */
function acceptanceGraph(workspacePath: string) {
  const actor = (agent: string, model?: string) => ({
    agent,
    ...(model ? { model } : {})
  })
  return {
    workspacePath,
    maxConcurrent: 3,
    nodes: [
      {
        id: 'research',
        actor: actor('claude', 'opus'),
        presetId: 'research',
        objective: 'Read the brief and the clips',
        deps: []
      },
      {
        id: 'plan',
        actor: actor('codex'),
        presetId: 'plan',
        objective: 'Plan three cuts',
        deps: ['research']
      },
      ...['a', 'b', 'c'].map((suffix) => ({
        id: `cut-${suffix}`,
        actor: actor(suffix === 'a' ? 'codex' : 'claude'),
        presetId: 'implement',
        objective: `Produce cut ${suffix}`,
        deps: ['plan']
      })),
      {
        id: 'assemble',
        actor: actor('codex'),
        presetId: 'synthesize',
        objective: 'Assemble the three cuts',
        deps: ['cut-a', 'cut-b', 'cut-c']
      },
      {
        id: 'check',
        actor: actor('claude'),
        presetId: 'verify',
        objective: 'Check the assembled cut against the brief',
        deps: ['assemble']
      }
    ]
  }
}

describe('local DAG runner on a real orchestration store', () => {
  let db: OrchestrationDb
  const reports: Promise<unknown>[] = []
  const workspaces: string[] = []

  afterEach(async () => {
    await Promise.all(reports.splice(0)).catch(() => undefined)
    db?.close()
    for (const path of workspaces.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  function workspace(git: boolean): string {
    const path = mkdtempSync(join(tmpdir(), 'local-run-'))
    workspaces.push(path)
    writeFileSync(join(path, 'brief.md'), 'Cut a 30 second promo from the clips.')
    mkdirSync(join(path, 'clips'), { recursive: true })
    writeFileSync(join(path, 'clips', 'a.mp4'), 'clip-a')
    if (git) {
      execFileSync('git', ['init', '-q', path])
    }
    return path
  }

  function setup(
    workspacePath: string,
    kind: 'folder' | 'git',
    options: {
      workerDelayMs?: number
      delayFor?: (prompt: string) => number
      outcomeFor?: (prompt: string) => 'succeeded' | 'failed'
      /** `start:<label>` when a worker is prompted, `report:<label>` once it reported. */
      timeline?: string[]
      labelFor?: (prompt: string) => string
    } = {}
  ) {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    let terminals = 0
    const created: { selector: string; opts: Record<string, unknown> }[] = []
    const prompts: { handle: string; prompt: string }[] = []
    const childWorktrees: string[] = []
    // Why a DISTINCT leaf uuid per handle: dispatch-depth resolution matches panes by
    // leaf uuid, so one shared uuid would make the coordinator look like a live
    // worker and refuse the second parallel start as nested dispatch.
    const paneKeys = new Map<string, string>()
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      const existing = paneKeys.get(handle)
      if (existing) {
        return existing
      }
      const leaf = `aaaaaaaa-aaaa-4aaa-8aaa-${String(paneKeys.size + 1).padStart(12, '0')}`
      const key = `${handle}:${leaf}`
      paneKeys.set(handle, key)
      return key
    })
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `fixture:${handle}:1`
    )
    // Why a real `folder:` key for folder workspaces: the live runtime answers with one,
    // and it carries no repo record — the runner must not ask for one.
    const workspaceId = kind === 'folder' ? 'folder:acceptance' : 'workspace:acceptance'
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(
      async (selector: string) =>
        ({
          id: selector.startsWith('id:child:') ? selector.slice(3) : workspaceId,
          repoId: 'repo:acceptance',
          path: workspacePath
        }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'workspace:acceptance',
      repoId: 'repo:acceptance',
      path: workspacePath
    } as never)
    vi.spyOn(runtime, 'showRepo').mockImplementation(async () => {
      if (kind === 'folder') {
        // Why: the live app has no repo for a folder workspace; asking is the defect.
        throw new Error('repo_not_found')
      }
      return { id: 'repo:acceptance', kind, path: workspacePath } as never
    })
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation((async (args: {
      name: string
    }) => {
      const name = args.name
      childWorktrees.push(name)
      terminals += 1
      const handle = `term_worker_${terminals}`
      return {
        worktree: { id: `child:${name}`, repoId: 'repo:acceptance', path: workspacePath },
        startupTerminal: { handle },
        setupReceipt: { hookFound: false, startupPolicy: 'start-immediately', state: 'skipped' }
      } as never
    }) as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({ terminals: [] } as never)
    vi.spyOn(runtime, 'createTerminal').mockImplementation((async (
      selector: string,
      opts: Record<string, unknown>
    ) => {
      created.push({ selector, opts })
      terminals += 1
      return { handle: terminals === 1 ? 'term_coord' : `term_worker_${terminals}` } as never
    }) as never)
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) =>
        ({
          handle,
          worktreeId: 'workspace:acceptance',
          status: 'running',
          connected: true
        }) as never
    )
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({ ptyKilled: true } as never)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('omni')
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    } as never)
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, prompt) => {
      prompts.push({ handle, prompt })
      const label = options.labelFor?.(prompt) ?? handle
      options.timeline?.push(`start:${label}`)
      reports.push(
        fakeWorker(
          runtime,
          handle,
          prompt,
          options.delayFor?.(prompt) ?? options.workerDelayMs ?? 0,
          options.outcomeFor?.(prompt)
        ).then((value) => {
          options.timeline?.push(`report:${label}`)
          return value
        })
      )
      return { handle, accepted: true, bytesWritten: prompt.length }
    })
    return { runtime, created, prompts, childWorktrees }
  }

  function fakeWorker(
    runtime: OrcaRuntimeService,
    handle: string,
    prompt: string,
    delayMs = 0,
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        writeAndReport(runtime, handle, prompt, outcome).then(resolve, reject)
      }, delayMs)
    })
  }

  /** Write the dictated files, then report once with the dictated path. */
  function writeAndReport(
    runtime: OrcaRuntimeService,
    handle: string,
    prompt: string,
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ): Promise<unknown> {
    const reportPath = /^Report file: (.+)$/m.exec(prompt)?.[1]?.trim()
    try {
      const outputDir = reportPath
        ? join(dirname(reportPath), basename(reportPath, '.md'))
        : undefined
      if (reportPath && outputDir) {
        mkdirSync(outputDir, { recursive: true })
        const nodeName = basename(reportPath, '.md')
        writeFileSync(join(outputDir, `${nodeName}.out.md`), `produced by ${nodeName}`)
        writeFileSync(join(outputDir, 'manifest.md'), `- ${nodeName}.out.md: the deliverable`)
        writeFileSync(reportPath, `Report for ${nodeName}`)
      }
      const dispatch = db.db
        .prepare('SELECT id, task_id FROM dispatch_contexts WHERE assignee_handle = ?')
        .get(handle) as { id: string; task_id: string }
      const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.send')!
      const params = method.params!.parse({
        from: handle,
        type: 'worker_done',
        subject: 'produced',
        body: 'done',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          outcome,
          reportPath,
          filesModified: reportPath ?? ''
        })
      })
      return Promise.resolve(
        method.handler(params, { runtime, orchestrationCapability: capabilityOf(prompt) })
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function capabilityOf(prompt: string): string | undefined {
    return /--dispatch-capability (\S+)/.exec(prompt)?.[1]
  }

  /**
   * A worker that asks the Run mailbox mid-node and blocks on the answer, exactly as
   * `omni ask` does, then produces its deliverable with what it was told.
   */
  async function askingWorker(
    runtime: OrcaRuntimeService,
    handle: string,
    prompt: string,
    answers: string[]
  ): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ask = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.ask')!
    const answered = (await ask.handler(
      ask.params!.parse({
        from: handle,
        question: 'Cut b or cut c?',
        options: 'b,c',
        timeoutMs: 30_000
      }),
      { runtime, orchestrationCapability: capabilityOf(prompt) }
    )) as { answer: string | null }
    answers.push(answered.answer ?? '(no answer)')
    // Why the delay: a real agent takes a moment to act on the answer, and the node
    // has to read as RUNNING again in between.
    return fakeWorker(runtime, handle, prompt, 300)
  }

  async function runGraph(kind: 'folder' | 'git') {
    const workspacePath = workspace(kind === 'git')
    const { runtime, created, prompts, childWorktrees } = setup(workspacePath, kind)
    const service = new LocalRunService(runtime)
    const run = service.create(acceptanceGraph(workspacePath))
    service.start(run.id)
    await vi.waitFor(
      () => {
        expect(['completed', 'failed', 'cancelled']).toContain(service.show(run.id).stage)
      },
      { timeout: 30_000, interval: 25 }
    )
    const result = service.show(run.id)
    if (process.env.LOCAL_RUN_DEBUG) {
      console.log(JSON.stringify(result.events, null, 1))
    }
    return { workspacePath, runtime, created, prompts, childWorktrees, result }
  }

  it('runs the fan-out graph in a folder workspace, isolating every parallel node', async () => {
    const { workspacePath, created, prompts, result } = await runGraph('folder')
    expect(result.error).toBeNull()
    expect(result.stage).toBe('completed')
    expect(result.workspaceKind).toBe('folder')
    expect(result.nodes.map((node) => node.state)).toEqual(
      Array.from({ length: 7 }, () => 'completed')
    )
    // Every node has a manifest under .omni/runs/<runId>/
    for (const node of result.nodes) {
      expect(node.manifestPath).toContain(join('.omni', 'runs', result.runId!))
      expect(existsSync(node.manifestPath!)).toBe(true)
      expect(existsSync(node.reportPath!)).toBe(true)
    }
    // The three parallel cuts each ran in their own subfolder; nothing asked a
    // folder workspace for a worktree.
    const cuts = result.nodes.filter((node) => node.id.startsWith('cut-'))
    const cwds = cuts.map((node) => node.placement?.cwd)
    expect(new Set(cwds).size).toBe(3)
    for (const node of cuts) {
      expect(node.placement?.worktree).toBe('current')
      expect(node.placement?.cwd).toBe(node.outputDir)
      expect(existsSync(node.placement!.cwd!)).toBe(true)
    }
    expect(
      created.filter((entry) => typeof entry.opts.cwd === 'string').map((entry) => entry.opts.cwd)
    ).toEqual(expect.arrayContaining(cwds as string[]))
    // Sequential nodes stay in the workspace root.
    for (const id of ['research', 'plan', 'assemble', 'check']) {
      const node = result.nodes.find((entry) => entry.id === id)!
      expect(node.placement).toEqual({ worktree: 'current' })
    }
    // The synthesize brief carries all three produced-file lists and their text.
    const assemblePrompt = prompts.find((entry) =>
      entry.prompt.includes('Assemble the three')
    )!.prompt
    for (const node of cuts) {
      expect(assemblePrompt).toContain(join(node.outputDir!, `${node.taskId}.out.md`))
      expect(assemblePrompt).toContain(node.manifestPath!)
      expect(assemblePrompt).toContain(`Report for ${node.taskId}`)
    }
    // A folder workspace gets no .gitignore because it has no repository.
    expect(existsSync(join(workspacePath, '.omni', '.gitignore'))).toBe(false)
  }, 60_000)

  it('runs the same graph on a git workspace with child worktrees for the parallel edits', async () => {
    const { workspacePath, childWorktrees, result } = await runGraph('git')
    expect(result.error).toBeNull()
    expect(result.stage).toBe('completed')
    expect(result.workspaceKind).toBe('git')
    const cuts = result.nodes.filter((node) => node.id.startsWith('cut-'))
    for (const node of cuts) {
      expect(node.placement?.worktree).toBe('new-child')
      expect(node.placement?.name).toBe(`${result.runId}-${node.id}`)
      expect(node.placement?.cwd).toBeUndefined()
    }
    expect(childWorktrees.sort()).toEqual(cuts.map((node) => node.placement!.name!).sort())
    for (const id of ['research', 'plan', 'assemble', 'check']) {
      expect(result.nodes.find((entry) => entry.id === id)?.placement).toEqual({
        worktree: 'current'
      })
    }
    expect(readFileSync(join(workspacePath, '.omni', '.gitignore'), 'utf8')).toBe('runs/\n')
  }, 60_000)

  it('reports a node as RUNNING while its worker is live, never QUEUED', async () => {
    // The live run (lrn_0ab7ec63666e) showed `plan` as QUEUED with `question: null`
    // for its whole turn, while its dispatch was running and its worker was talking.
    // A node's whole turn happens inside ONE batch, so a derivation that only ran
    // between batches could never observe it.
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder', { workerDelayMs: 400 })
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      nodes: [
        { id: 'only', actor: { agent: 'codex' }, presetId: 'implement', objective: 'go', deps: [] }
      ]
    })
    const seen = new Set<string>()
    service.start(run.id)
    const sampler = setInterval(() => {
      const node = service.show(run.id).nodes[0]
      if (node) {
        seen.add(node.state)
      }
    }, 25)
    try {
      await vi.waitFor(
        () => {
          expect(['completed', 'failed', 'cancelled']).toContain(service.show(run.id).stage)
        },
        { timeout: 20_000, interval: 25 }
      )
    } finally {
      clearInterval(sampler)
    }
    expect([...seen]).toContain('running')
    expect(service.show(run.id).stage).toBe('completed')
    expect(service.show(run.id).nodes[0]?.state).toBe('completed')
  }, 60_000)

  it('surfaces a worker mailbox question as NEEDS INPUT and finishes the node on a reply', async () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder')
    const answers: string[] = []
    vi.mocked(runtime.sendTerminalAgentPrompt).mockImplementation(async (handle, prompt) => {
      reports.push(askingWorker(runtime, handle, prompt, answers))
      return { handle, accepted: true, bytesWritten: prompt.length }
    })
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      nodes: [
        { id: 'plan', actor: { agent: 'codex' }, presetId: 'plan', objective: 'plan it', deps: [] }
      ]
    })
    service.start(run.id)
    await vi.waitFor(
      () => {
        expect(service.show(run.id).nodes[0]?.state).toBe('needs-input')
      },
      { timeout: 20_000, interval: 25 }
    )
    const asking = service.show(run.id).nodes[0]!
    expect(asking.question).toMatchObject({
      source: 'mailbox',
      question: 'Cut b or cut c?',
      options: ['b', 'c']
    })
    // The message id is a real, still-open question row: that is what makes it answerable.
    expect(db.getQuestion(asking.question!.messageId)?.status).toBe('pending')

    const replied = await service.reply(run.id, asking.question!.messageId, 'cut c, it is tighter')

    // Answered: the node stops asking and goes back to running on the same dispatch.
    expect(replied.nodes[0]?.question).toBeNull()
    expect(replied.nodes[0]?.state).toBe('running')
    expect(replied.nodes[0]?.dispatchId).toBe(asking.dispatchId)
    await vi.waitFor(
      () => {
        expect(service.show(run.id).stage).toBe('completed')
      },
      { timeout: 20_000, interval: 25 }
    )
    // The worker received the person's words, not a timeout.
    expect(answers).toEqual(['cut c, it is tighter'])
    const finished = service.show(run.id).nodes[0]!
    expect(finished.state).toBe('completed')
    expect(existsSync(finished.reportPath!)).toBe(true)
    expect(service.show(run.id).events.some((event) => event.text.startsWith('Answered:'))).toBe(
      true
    )
  }, 60_000)

  it('surfaces a worker that only stopped in its terminal, and answers it with a prompt', async () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder')
    let stoppedInTerminal = true
    vi.spyOn(runtime, 'getFreshAgentHookStatusForHandle').mockImplementation((handle) =>
      handle.startsWith('term_worker') && stoppedInTerminal
        ? {
            state: 'waiting',
            lastAssistantMessage: 'Wide shot or close-up for the opener?',
            interactivePrompt: null,
            stateStartedAt: 1_757_000_000_000,
            updatedAt: Date.now()
          }
        : null
    )
    // This worker never asks the Run anything: it stops in its own pane, and only a
    // prompt typed back into that pane makes it produce.
    const briefByHandle = new Map<string, string>()
    vi.mocked(runtime.sendTerminalAgentPrompt).mockImplementation(async (handle, prompt) => {
      const brief = briefByHandle.get(handle)
      if (!brief) {
        briefByHandle.set(handle, prompt)
        return { handle, accepted: true, bytesWritten: prompt.length }
      }
      stoppedInTerminal = false
      // Why the delay: a real agent takes a moment to act on the answer, and the node
      // has to read as RUNNING again in between.
      reports.push(fakeWorker(runtime, handle, brief, 300))
      return { handle, accepted: true, bytesWritten: prompt.length }
    })
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      nodes: [
        {
          id: 'cut',
          actor: { agent: 'claude' },
          presetId: 'implement',
          objective: 'cut it',
          deps: []
        }
      ]
    })
    service.start(run.id)
    await vi.waitFor(
      () => {
        expect(service.show(run.id).nodes[0]?.state).toBe('needs-input')
      },
      { timeout: 20_000, interval: 25 }
    )
    const stopped = service.show(run.id).nodes[0]!
    expect(stopped.question).toMatchObject({
      source: 'terminal',
      question: 'Wide shot or close-up for the opener?',
      options: []
    })
    expect(stopped.terminalHandle).toBeTruthy()
    // No mailbox question exists: nothing was ever asked through the Run.
    expect(db.getQuestion(stopped.question!.messageId)).toBeUndefined()

    const replied = await service.reply(run.id, stopped.question!.messageId, 'the wide shot')

    // The answer went to THAT worker's terminal, through the runtime's prompt delivery.
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      stopped.terminalHandle,
      'the wide shot'
    )
    expect(replied.nodes[0]?.question).toBeNull()
    expect(replied.nodes[0]?.state).toBe('running')
    await vi.waitFor(
      () => {
        expect(service.show(run.id).stage).toBe('completed')
      },
      { timeout: 20_000, interval: 25 }
    )
    const finished = service.show(run.id).nodes[0]!
    expect(finished.state).toBe('completed')
    expect(finished.question).toBeNull()
    expect(existsSync(finished.reportPath!)).toBe(true)
  }, 60_000)

  it('refuses to create local tasks on a card-bound Run', async () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder')
    // Why wrap the caller: the refusal must hold for ANY Run that comes back bound,
    // including one this runtime bound for its own reasons. The runner may not
    // create Tasks on a card's Run — that execution belongs to the hub.
    const inner = createOrchestrationCaller(runtime)
    const call = (async <T>(
      method: string,
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ): Promise<T> => {
      const result = await inner<T>(method, params, options)
      if (method !== 'orchestration.runCreate') {
        return result
      }
      const created = result as { run: { id: string; hub_task_id: string | null } }
      return { ...created, run: { ...created.run, hub_task_id: 'btk_boundcard' } } as T
    }) satisfies OrchestrationCaller
    const service = new LocalRunService(runtime, call)
    const run = service.create({
      workspacePath,
      nodes: [
        {
          id: 'only',
          actor: { agent: 'codex' },
          presetId: 'implement',
          objective: 'do it',
          deps: []
        }
      ]
    })
    service.start(run.id)
    await vi.waitFor(() => {
      expect(['failed', 'cancelled']).toContain(service.show(run.id).stage)
    })
    expect(service.show(run.id).error).toMatch(/bound to an omnios card/)
    expect(db.listTasks()).toHaveLength(0)
  })

  it('refuses to create a run that carries a fleet-placed node', () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder')
    const service = new LocalRunService(runtime)
    // Why: fleet placement stays on the console seam (SYSTEMS.md 2026-09-09). A canvas
    // draft may hold one while it waits for admission; starting it here would execute
    // work the console never admitted.
    expect(() =>
      service.create({
        workspacePath,
        nodes: [
          {
            id: 'local-step',
            actor: { agent: 'codex' },
            presetId: 'implement',
            objective: 'do it here',
            deps: []
          },
          {
            id: 'fleet-step',
            actor: { agent: 'codex' },
            presetId: 'implement',
            objective: 'do it on the fleet',
            placement: 'fleet',
            deps: ['local-step']
          }
        ]
      })
    ).toThrow(/never started locally: fleet-step/)
    expect(db.listTasks()).toHaveLength(0)
  })

  it('holds a gated node at NEEDS INPUT until a person answers, then runs it', async () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder')
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      nodes: [
        {
          id: 'draft',
          actor: { agent: 'codex' },
          presetId: 'implement',
          objective: 'draft the cut list',
          deps: []
        },
        {
          id: 'publish',
          actor: { agent: 'codex' },
          presetId: 'implement',
          objective: 'publish the cut',
          gate: { question: 'Publish this cut?', options: ['yes', 'no'] },
          deps: ['draft']
        }
      ]
    })
    service.start(run.id)
    await vi.waitFor(() => {
      const node = service.show(run.id).nodes.find((entry) => entry.id === 'publish')!
      expect(node.state).toBe('needs-input')
    })
    const gated = service.show(run.id).nodes.find((entry) => entry.id === 'publish')!
    expect(gated.gateQuestion).toBe('Publish this cut?')
    expect(db.getTask(gated.taskId!)?.status).toBe('blocked')
    expect(db.listGates({ taskId: gated.taskId!, status: 'pending' })).toHaveLength(1)
    expect(db.getDispatchContext(gated.taskId!)).toBeUndefined()
    await service.resolveGate(run.id, gated.gateId!, 'yes')
    await vi.waitFor(
      () => {
        expect(service.show(run.id).stage).toBe('completed')
      },
      { timeout: 20_000, interval: 25 }
    )
    const finished = service.show(run.id).nodes.find((entry) => entry.id === 'publish')!
    expect(finished.state).toBe('completed')
    expect(existsSync(finished.reportPath!)).toBe(true)
  }, 60_000)

  it('hands a deliver node its produced files, sha256-addressed, and never fails the work on a refusal', async () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder')
    const delivered: { taskId: string; paths: string[]; to: string[] }[] = []
    setLocalRunDeliverer(async (request) => {
      delivered.push({ taskId: request.taskId, paths: request.paths, to: request.to })
      return delivered.length === 1
        ? {
            ok: true,
            data: {
              files: request.paths.map((path) => ({
                name: path,
                sha256: 'f'.repeat(64),
                bytes: 1
              })),
              skipped: [],
              delivery: { id: 'dlv_1' }
            }
          }
        : { ok: false, error: { code: 'forbidden', message: 'not your card' } }
    })
    const service = new LocalRunService(runtime)
    const node = (id: string, deps: string[]) => ({
      id,
      actor: { agent: 'codex' },
      presetId: 'implement',
      objective: `produce ${id}`,
      deliver: { taskId: 'btk_target', to: ['sal'], message: `${id} is ready` },
      deps
    })
    const run = service.create({
      workspacePath,
      nodes: [node('first', []), node('second', ['first'])]
    })
    service.start(run.id)
    await vi.waitFor(
      () => {
        expect(service.show(run.id).stage).toBe('completed')
      },
      { timeout: 20_000, interval: 25 }
    )
    const result = service.show(run.id)
    expect(delivered).toHaveLength(2)
    expect(delivered[0]?.taskId).toBe('btk_target')
    expect(delivered[0]?.to).toEqual(['sal'])
    expect(delivered[0]?.paths).toEqual(result.nodes[0]?.producedFiles)
    // The refused second delivery is reported, not fatal: the files still exist.
    expect(result.nodes[0]?.deliveryId).toBe('btk_target')
    expect(result.nodes[1]?.deliveryId).toBeNull()
    expect(result.events.some((event) => event.text.includes('was refused: not your card'))).toBe(
      true
    )
    expect(result.stage).toBe('completed')
  }, 60_000)

  function node(id: string, deps: string[] = []) {
    return {
      id,
      actor: { agent: 'codex' },
      presetId: 'implement',
      objective: `OBJ_${id}_END`,
      deps
    }
  }

  const labelFor = (prompt: string) => /OBJ_(\w+?)_END/.exec(prompt)?.[1] ?? 'unknown'

  async function finished(service: LocalRunService, runId: string) {
    await vi.waitFor(
      () => {
        expect(['completed', 'failed', 'cancelled']).toContain(service.show(runId).stage)
      },
      { timeout: 30_000, interval: 25 }
    )
    return service.show(runId)
  }

  function peakLive(timeline: string[]): number {
    let live = 0
    let peak = 0
    for (const event of timeline) {
      live += event.startsWith('start:') ? 1 : -1
      peak = Math.max(peak, live)
    }
    return peak
  }

  it('starts a ready node as soon as a slot frees instead of waiting for the slowest worker', async () => {
    const workspacePath = workspace(false)
    const timeline: string[] = []
    const { runtime } = setup(workspacePath, 'folder', {
      timeline,
      labelFor,
      delayFor: (prompt) => (labelFor(prompt) === 'slow' ? 1_500 : 0)
    })
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      maxConcurrent: 2,
      nodes: [node('slow'), node('fast'), node('after', ['fast'])]
    })
    service.start(run.id)

    const result = await finished(service, run.id)

    expect(result.error).toBeNull()
    expect(result.stage).toBe('completed')
    expect(timeline.indexOf('start:after')).toBeGreaterThan(timeline.indexOf('report:fast'))
    expect(timeline.indexOf('start:after')).toBeLessThan(timeline.indexOf('report:slow'))
    expect(peakLive(timeline)).toBe(2)
  }, 60_000)

  it('never runs more workers than maxConcurrent while it refills slots', async () => {
    const workspacePath = workspace(false)
    const timeline: string[] = []
    const { runtime } = setup(workspacePath, 'folder', {
      timeline,
      labelFor,
      delayFor: (prompt) => ({ a: 400, b: 100, c: 250, d: 50, e: 0 })[labelFor(prompt)] ?? 0
    })
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      maxConcurrent: 2,
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id))
    })
    service.start(run.id)

    const result = await finished(service, run.id)

    expect(result.stage).toBe('completed')
    expect(timeline.filter((event) => event.startsWith('start:'))).toHaveLength(5)
    expect(peakLive(timeline)).toBe(2)
  }, 60_000)

  it('fails a run whose failed node stranded its dependents, after finishing independent work', async () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder', {
      labelFor,
      outcomeFor: (prompt) => (labelFor(prompt) === 'broken' ? 'failed' : 'succeeded')
    })
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      maxConcurrent: 2,
      nodes: [node('broken'), node('later', ['broken']), node('independent')]
    })
    service.start(run.id)

    const result = await finished(service, run.id)

    expect(result.stage).toBe('failed')
    expect(result.error).toMatch(
      /^Finished with failed node\(s\): broken.*\. Not started because a dependency failed: later$/
    )
    expect(result.nodes.find((entry) => entry.id === 'independent')?.state).toBe('completed')
    const later = result.nodes.find((entry) => entry.id === 'later')!
    expect(db.getTask(later.taskId!)?.status).toBe('blocked')
  }, 60_000)

  it('stops and releases a worker whose start failed, and fails the run instead of stranding it', async () => {
    const workspacePath = workspace(false)
    const { runtime } = setup(workspacePath, 'folder')
    // The agent terminal comes up, but readiness never arrives: worker-start throws
    // AFTER the dispatch exists, which is exactly the case runWorkerUnit's wait path
    // never sees.
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    } as never)
    const service = new LocalRunService(runtime)
    const run = service.create({
      workspacePath,
      nodes: [
        {
          id: 'only',
          actor: { agent: 'codex' },
          presetId: 'implement',
          objective: 'do it',
          deps: []
        }
      ]
    })
    service.start(run.id)
    await vi.waitFor(
      () => {
        expect(['failed', 'cancelled']).toContain(service.show(run.id).stage)
      },
      { timeout: 20_000, interval: 25 }
    )
    const result = service.show(run.id)
    expect(result.stage).toBe('failed')
    expect(result.error).toMatch(/Finished with failed node\(s\): only/)
    expect(result.nodes[0]?.state).toBe('failed')
    const dispatchId = result.nodes[0]?.dispatchId
    expect(dispatchId).toBeTruthy()
    // Nothing is left holding the workspace: the dispatch is settled, not pending.
    expect(db.getDispatchContextById(dispatchId!)?.status).not.toBe('pending')
    expect(db.getDispatchContextById(dispatchId!)?.status).not.toBe('dispatched')
    expect(runtime.closeTerminal).toHaveBeenCalled()
  }, 60_000)
})
