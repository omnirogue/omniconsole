import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
// Why: orchestration now ships a hybrid discovery stub, so its version-sensitive command
// guidance lives in the authoritative guide source — assert that content there. The
// installable stub projection is checked separately below.
const guidePath = join(projectDir, 'skill-guides', 'orchestration.md')
const stubPath = join(projectDir, 'skills', 'orchestration', 'SKILL.md')

function readSkill() {
  return readFileSync(guidePath, 'utf8')
}

function getSection(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(
    new RegExp(`## ${escapedHeading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`)
  )

  expect(match).not.toBeNull()

  return match?.[1] ?? ''
}

describe('orchestration skill guidance', () => {
  it('requires Orca runtime state before claiming a worker was orchestrated', () => {
    const skill = readSkill()
    const toolBoundary = getSection(skill, 'Tool Boundary')

    expect(toolBoundary).toContain('bind the Run')
    expect(toolBoundary).toContain('Task with `task-create`')
    expect(toolBoundary).toContain('`omni orchestration worker-start`')
    expect(toolBoundary).toContain('`dispatch --inject` path')
    expect(toolBoundary).not.toContain('or `omni orchestration run`')
    expect(skill).toContain(
      '`coordinator-start`, `coordinator-stop`, `run`, and `run-stop` are retired scheduler commands'
    )
    // Why: the 1.7.0 guide binds Orca to hub cards; provenance stays with the executor that ran the work.
    expect(toolBoundary).toContain("Do not claim another adapter's work as")
    expect(toolBoundary).toContain('verify the task/dispatch exists')
    expect(toolBoundary).toContain('record that provenance and its actual')
    expect(toolBoundary).toContain('omni orchestration task-list --json')
    expect(toolBoundary).toContain('omni orchestration dispatch-show --task <task_id> --json')
    expect(toolBoundary).toContain('Do not rerun completed actions merely to manufacture')
  })

  it('teaches attested adoption without reviving the retired scheduler', () => {
    const skill = readSkill()
    const migration = getSection(skill, 'Contract Migration')

    expect(migration).toContain(
      'adopts a live pre-update orchestration assignment into an ordinary Run'
    )
    expect(migration).toContain(
      'preserves the existing agent process, PTY/session, terminal handle, tab/leaf/pane, worktree or folder workspace, Task, and Dispatch'
    )
    expect(migration).toContain('never restarts or replaces the worker')
    expect(migration).toContain('The retired scheduler is not revived')
    expect(migration).toContain('[LEGACY COMPATIBILITY]')
    expect(migration).toContain('[LEGACY READ-ONLY]')
    expect(migration).toContain(
      'Loss of lifecycle authority does not invalidate the existing assignment, process, or filesystem work.'
    )
    expect(migration).toContain(
      'It must not spawn, write, signal, stop, switch, focus, split, or inject a terminal.'
    )
    expect(migration).not.toContain('task-list --run run_legacy_local')
    expect(migration).toContain('run_legacy_local is an empty audit tombstone')
    expect(migration).toContain('Recovered orchestration work from a contract update')
    expect(migration).toContain('run-show --id <adopted_run_id>')
    expect(migration).toContain('task-list --run <adopted_run_id>')
    expect(migration).toContain('Legacy inspection remains available without consuming mail')
    expect(migration).toContain('run-use --id <adopted_run_id> --takeover-legacy')
    expect(migration).toContain('Takeover fences only the old coordinator')
    expect(migration).toContain('Live legacy workers keep their original Tasks, Dispatches')
    expect(migration).toContain(
      'keep the original worker as the only editor until it reaches a stable handoff point'
    )
    expect(migration).toContain('a conflict-free placement for any remaining work')
  })

  it('treats long-running worker waits as liveness checkpoints, not failures', () => {
    const skill = readSkill()

    expect(skill).toContain('Treat a `check --wait` timeout or `{count:0}` as a checkpoint')
    expect(skill).toContain('Do not stop, close, kill, or restart a worker')
    expect(skill).toContain('keep waiting instead of retrying the task')
    expect(skill).not.toContain(
      'If `check --wait` times out with no `worker_done` or `escalation`, fall back to `terminal wait --for tui-idle`, then `terminal read`.'
    )
  })

  it('keeps full handoffs out of dispatch lifecycle and off the active branch base', () => {
    const skill = readSkill()
    const fullHandoffs = getSection(skill, 'Full Handoffs')

    expect(skill).toContain('Full handoff means ownership transfer, not supervised dispatch.')
    expect(fullHandoffs).toContain(
      'Do not run `omni orchestration task-create`, `omni orchestration dispatch --inject`, or `omni orchestration check --wait` for full handoffs.'
    )
    expect(fullHandoffs).toContain(
      '`task-create` is also forbidden because it records coordinator-owned tracking state'
    )
    expect(fullHandoffs).toContain('Do not create a `taskId`/`dispatchId`')
    expect(fullHandoffs).toContain(
      'read the worker terminal after prompt delivery except to avoid losing the initial prompt'
    )
    expect(skill).toContain(
      '`--no-parent` only controls Orca lineage; it does not choose the Git base.'
    )
    expect(skill).toContain(
      'never base it on the current feature branch unless the user explicitly asks'
    )
    expect(skill).toContain(
      'omni worktree create --name <task-name> --no-parent --agent codex --prompt'
    )
    expect(fullHandoffs).toContain(
      'Before creating a new worktree from an active feature branch, decide and state whether the desired Orca lineage is child or top-level'
    )
    expect(fullHandoffs).toContain(
      'Use child worktree lineage only when the new work is conceptually stacked under or dependent on the active worktree'
    )
    expect(fullHandoffs).toContain(
      'For independent repo-wide fixes, standalone feature work, or unrelated follow-up tasks, create a top-level worktree with `--no-parent`'
    )
    expect(fullHandoffs).toContain('If the work should start from the repo default base')
    expect(fullHandoffs).toContain('omit `--base-branch`')
  })

  it('classifies handoff wording as ownership transfer unless supervision is explicit', () => {
    const skill = readSkill()
    const fullHandoffs = getSection(skill, 'Full Handoffs')

    for (const phrase of [
      'hand off',
      'handoff',
      'handover',
      'give this to another agent',
      'give this to another worktree',
      'another agent',
      'another worktree'
    ]) {
      expect(fullHandoffs).toContain(phrase)
    }

    for (const supervisionPhrase of [
      'supervise',
      'monitor',
      'wait for worker_done',
      'wait for results',
      'track completion',
      'DAG',
      'decision gate',
      'ask/reply'
    ]) {
      expect(fullHandoffs).toContain(supervisionPhrase)
    }
  })

  it('documents custom model and effort handoffs without completion monitoring', () => {
    const skill = readSkill()
    const fullHandoffs = getSection(skill, 'Full Handoffs')

    expect(fullHandoffs).toContain('Custom model/effort handoff')
    expect(fullHandoffs).toContain(
      'omni session launch --worktree id:<newFullWorktreeId> --provider codex --model gpt-5.5 --effort xhigh --prompt-file <brief.md> --json'
    )
    expect(fullHandoffs).toContain('**Launch an agent** from the omni-cli skill')
    expect(fullHandoffs).toContain('`setupAgentStartupPolicy: wait-for-setup`')
    expect(fullHandoffs).toContain('Do not monitor task completion.')
    // Why: the two-step custom-argv launch bypassed account verification; it must not return.
    expect(fullHandoffs).not.toContain('model_reasoning_effort="xhigh"')
    expect(fullHandoffs).not.toContain(
      "omni terminal create --worktree id:<newFullWorktreeId> --title <task-name> --command 'codex"
    )
    expect(fullHandoffs).not.toContain('bare create opens a fallback shell')
  })

  it('points unsupervised agents at session launch next to worker-start', () => {
    const workerLoop = getSection(readSkill(), 'Preferred Supervised Worker Loop')

    expect(workerLoop).toContain(
      'For unsupervised agents use `omni session launch`, which picks a verified account on the host'
    )
  })

  // Why: worker-start and session launch both take --model/--effort, so model or effort must
  // never send an agent back to the terminal create --command two-step.
  it('never cites model or effort as a reason for custom agent argv', () => {
    const workerTerminals = getSection(readSkill(), 'Worker Terminals')

    expect(workerTerminals).toContain('Model and effort are not custom argv')
    expect(workerTerminals).toContain(
      'pass `--model`/`--effort` to `worker-start` for a supervised worker'
    )
    expect(workerTerminals).toContain('`omni session launch --model … --effort …`')
    expect(workerTerminals).toContain('with no model/effort argv')
    expect(workerTerminals).not.toContain('for example Codex model/effort flags')
  })

  it('clarifies sidebar lineage for same-worktree orchestrated workers', () => {
    const skill = readSkill()
    const workerTerminals = getSection(skill, 'Worker Terminals')

    expect(workerTerminals).toContain(
      'Sidebar lineage and orchestration lifecycle are related but not identical.'
    )
    expect(workerTerminals).toContain(
      'A same-worktree worker may appear as a peer under that worktree in the sidebar'
    )
    expect(workerTerminals).toContain('while remaining a child dispatch in orchestration state')
    expect(workerTerminals).toContain(
      'only an actual child worktree creates visible parent/child worktree lineage'
    )
    expect(workerTerminals).toContain(
      'Create a new worktree only when the user explicitly requests one or a concrete checkout or filesystem conflict makes sharing unsafe or impossible'
    )
    expect(workerTerminals).toContain(
      'Independent tasks, parallel execution, convenience, or a preference for separate checkouts are not isolation requirements.'
    )
    expect(workerTerminals).toContain(
      'When a new worktree is allowed, use child lineage for isolated work that is stacked under or dependent on the active worktree'
    )
    expect(workerTerminals).toContain('use `--no-parent` when it is not stacked')
  })

  it('keeps review-only completions and named next-owner fixes in their lanes', () => {
    const skill = readSkill()

    expect(skill).toContain(
      'A review-only `worker_done` reports findings; it does not authorize coordinator file edits.'
    )
    expect(skill).toContain('unless the user explicitly asked the coordinator to own fixes')
    expect(skill).toContain('dispatch or hand off fixes')
    expect(skill).toContain(
      "If the user's plan names a next owner agent " +
        '(for example, "then use opencode to create a PR")'
    )
    expect(skill).toContain('post-review corrections and PR prep belong to that named owner')
    expect(skill).toContain('the named owner edits files and creates the PR')
  })

  it('keeps post-completion workers idle without subordinating the user', () => {
    const skill = readSkill()
    const agentGuidance = getSection(skill, 'Agent Guidance')

    expect(agentGuidance).toContain('After sending `worker_done`, end that dispatched turn')
    expect(agentGuidance).toContain('idle at the agent prompt')
    expect(agentGuidance).toContain('Do not autonomously start more work, poll')
    expect(agentGuidance).toContain('A direct user instruction takes precedence')
    expect(agentGuidance).toContain('follow it without coordinator approval or a fresh Dispatch')
    expect(agentGuidance).toContain('never refuse it because of worker/coordinator roles')
    expect(agentGuidance).toContain("do not reuse the settled Dispatch's lifecycle IDs")
    expect(agentGuidance).toContain(
      'A coordinator-supervised follow-up still arrives with a fresh preamble + TASK block'
    )
    expect(skill).not.toContain('post-completion polling messages')
    expect(skill).not.toContain('every 2 minutes')
  })

  it('documents coordinator ownership decisions before accepted-completion cleanup', () => {
    const skill = readSkill()
    const workerLoop = getSection(skill, 'Preferred Supervised Worker Loop')
    const agentGuidance = getSection(skill, 'Agent Guidance')
    const nextAction = getSection(skill, 'Next Action')

    expect(workerLoop).toContain(
      '# Process every message. Reuse or Keep a worker before acknowledging its worker_done.\n' +
        '# The acknowledgment requests exact release for an eligible finite worker:\n' +
        'omni orchestration check --ack <delivery_id> --wait --types worker_done,escalation,question'
    )
    expect(workerLoop).toContain(
      "choose the terminal's next owner before you acknowledge the Delivery or wait again"
    )
    expect(workerLoop).toContain(
      'read the `worker.agent_terminal_handle` field of `worker-show --dispatch <dispatch_id> --json`'
    )
    expect(workerLoop).toContain(
      'omni orchestration worker-start --task <next_task_id> --terminal <handle> --json` so Orca ' +
        'transfers cleanup ownership to the new Dispatch'
    )
    expect(workerLoop).toContain(
      'For legacy or opted-out workers without the policy, run `worker-release` explicitly ' +
        'when cleanup is wanted.'
    )
    expect(workerLoop).toContain('Release is post-completion cleanup, not cancellation')
    expect(workerLoop).toContain('omni orchestration worker-retain --dispatch <dispatch_id> --json')
    expect(workerLoop).toContain(
      'the same Dispatch can be passed to `worker-release`, which clears the requested retention'
    )
    expect(agentGuidance).toContain(
      'Coordinators must account for every settled worker terminal before acknowledging its ' +
        '`worker_done` Delivery'
    )
    expect(agentGuidance).toContain('released workers remain readable through `worker-read`')
    expect(nextAction).toContain(
      'After every accepted `worker_done`, transfer or retain an exact terminal before ' +
        'acknowledging if it must remain live. Acknowledgment requests release of an eligible finite worker.'
    )
  })

  it('documents per-invocation model and effort for supervised workers', () => {
    const workerLoop = getSection(readSkill(), 'Preferred Supervised Worker Loop')

    expect(workerLoop).toContain('opaque provider model id with `--model`')
    expect(workerLoop).toContain('`--effort` requires `--model`')
    expect(workerLoop).toContain('neither option can combine with `--terminal`')
    expect(workerLoop).toContain('--agent claude --model opus --effort high --json')
    expect(workerLoop).toContain('`launch.requested` and `launch.effective`')
  })

  it('never authorizes release from idle, timeout, or worker-side triggers', () => {
    const skill = readSkill()
    const workerLoop = getSection(skill, 'Preferred Supervised Worker Loop')
    const agentGuidance = getSection(skill, 'Agent Guidance')

    // The prohibition sentence is the guard the negative patterns below rely on.
    expect(workerLoop).toContain(
      'Do not release a worker because of a timeout, TUI idle state, heartbeat, status, question, ' +
        'escalation, or rejected/stale `worker_done`.'
    )
    expect(workerLoop).toContain(
      'do not substitute `terminal close`; follow the exact recovery action in the receipt'
    )
    expect(skill).not.toMatch(
      /release[^.]*\bon (?:a |the )?(?:tui-?idle|idle|timeout|heartbeat|question|escalation)\b/iu
    )
    expect(skill).not.toMatch(
      /\b(?:after|on|upon) (?:a |the )?(?:tui-?idle|idle state|timeout|heartbeat)\b[^.]*\brelease/iu
    )
    expect(agentGuidance).toContain(
      'Do not autonomously start more work, poll, or attempt to close the terminal yourself'
    )
    expect(agentGuidance).not.toMatch(/worker-release[^.]*\byourself\b/iu)
  })

  it('documents @grok in the Messaging group address list', () => {
    const skill = readSkill()
    const messaging = getSection(skill, 'Messaging')

    expect(messaging).toContain('`@grok`')
  })

  it('documents @cursor in the Messaging group address list', () => {
    const skill = readSkill()
    const messaging = getSection(skill, 'Messaging')

    expect(messaging).toContain('`@cursor`')
  })

  it('keeps agent-first launch, handle recovery, and inbox injection distinct', () => {
    const skill = readSkill()
    const messaging = getSection(skill, 'Messaging')
    const workerTerminals = getSection(skill, 'Worker Terminals')
    const agentFirstExample = workerTerminals.match(
      /```bash\nomni worktree create --name <task-name> --agent codex --setup run --json\n[\s\S]*?```/
    )?.[0]

    expect(workerTerminals).toContain('For an allowed new worktree, use agent-first:')
    expect(workerTerminals).toContain('fallback shell + agent pair')
    expect(workerTerminals).toContain(
      'repo setup and default-terminal settings may add intentional tabs or splits'
    )
    expect(workerTerminals).toContain('without configured default tabs')
    expect(workerTerminals).toContain(
      'only after `terminal list` or `terminal show` confirms it is an unused shell'
    )
    expect(workerTerminals).not.toContain('bare create opens a default shell')
    expect(workerTerminals).not.toContain('ends with **one** agent tab')
    expect(agentFirstExample).toBeDefined()
    expect(agentFirstExample).not.toContain('omni terminal list')
    expect(agentFirstExample).toContain('agentTerminalHandle')
    expect(agentFirstExample).toContain('startupTerminal.handle')
    expect(messaging).toContain('Prefer `agentTerminalHandle` from the create response')
    expect(messaging).toContain('Continue with the replacement handle only')
    expect(messaging).toContain('never writes to terminal input or remotely wakes another terminal')
    expect(messaging).toContain('Use `orchestration dispatch --inject` to deliver a tracked task')
  })
})

describe('orchestration install stub', () => {
  it('points at the version-matched guide and preserves the safe resolver', () => {
    const stub = readFileSync(stubPath, 'utf8')

    expect(stub).toContain('discovery stub')
    expect(stub).toContain('ORCA skills get orchestration')
    // The safe CLI-resolution contract must survive in the stub, never a bare `omni`.
    expect(stub).toContain('ORCA_CLI_COMMAND')
    expect(stub).toContain('omni-dev')
    expect(stub).toContain('omni-ide')
    expect(stub).toContain('GNOME Orca screen reader')
    expect(stub).not.toMatch(/^omni /mu)
  })

  it('does not tell agents to mutate orchestration state before loading the guide', () => {
    const preGuide = readFileSync(stubPath, 'utf8').split('## Load the full guide')[0]

    expect(preGuide).not.toContain('omni orchestration task-create')
    expect(preGuide).not.toContain('omni orchestration dispatch')
  })

  it('gives older binaries a bounded fallback instead of a dead end', () => {
    const stub = readFileSync(stubPath, 'utf8').replace(/\s+/gu, ' ')

    expect(stub).toContain('explicitly reports that `skills get` is an unknown command')
    expect(stub).toContain('do not invent commands')
    expect(stub).toContain('ask the user rather than guessing')
  })

  it('drops the changing command reference from the installable file', () => {
    const stub = readFileSync(stubPath, 'utf8')

    // Version-sensitive command detail lives in the binary-served guide now, not here.
    expect(stub).not.toContain('check --wait')
    expect(stub).not.toContain('dispatch-show')
    expect(stub.length).toBeLessThan(readFileSync(guidePath, 'utf8').length)
  })

  it('keeps the routing frontmatter identical to the guide', () => {
    const frontmatter = (text) => /^---\n[\s\S]*?\n---\n/u.exec(text)[0]

    expect(frontmatter(readFileSync(stubPath, 'utf8'))).toBe(
      frontmatter(readFileSync(guidePath, 'utf8'))
    )
  })
})
