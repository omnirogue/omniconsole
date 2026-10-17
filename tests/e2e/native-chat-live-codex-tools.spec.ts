import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'
import { readPaneIdentitySnapshot } from './helpers/terminal-pane-identity'
import { stripAnsiEscapeSequences } from '../../src/shared/ansi-escape-sequences'
import { tokenizeStartupCommand } from '../../src/shared/tui-agent-startup-shell'

const LIVE_CODEX = process.env.OMNI_LIVE_CODEX ?? ''
test.skip(!LIVE_CODEX, 'set OMNI_LIVE_CODEX to the real Codex binary')
test.use({ launchEnv: { PATH: `${path.dirname(LIVE_CODEX)}:${process.env.PATH ?? ''}` } })

function descendantProcesses(root: number): { pid: number; parent: number; name: string }[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)!
      return { pid: Number(match[1]), parent: Number(match[2]), name: match[3] }
    })
  const descendants = new Set([root])
  for (let size = -1; size !== descendants.size;) {
    size = descendants.size
    for (const row of rows) {
      if (descendants.has(row.parent)) {
        descendants.add(row.pid)
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid))
}

function codexDescendant(root: number): number {
  const descendants = descendantProcesses(root)
  const targets = descendants.filter((row) => path.basename(row.name) === 'codex')
  if (targets.length !== 1) {
    throw new Error(
      `Expected one Codex under test PTY ${root}; found ${targets.length}: ${JSON.stringify(descendants)}`
    )
  }
  return targets[0].pid
}

type ProcessIdentity = { pid: number; startedAt: string; argv: string }
function readProcessIdentity(pid: number): ProcessIdentity | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' }
  })
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) {
    return null
  }
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Could not inspect test process ${pid}: ${result.stderr}`)
  }
  const match = result.stdout.trim().match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)
  if (!match) {
    throw new Error(`Could not identify test process ${pid}`)
  }
  return { pid, startedAt: match[1].replace(/\s+/g, ' '), argv: match[2] }
}

function expectSandboxedCodex(argv: string): void {
  const parsed = tokenizeStartupCommand(argv, 'posix')
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  expect(parsed.tokens[parsed.tokens.indexOf('--sandbox') + 1]).toBe('workspace-write')
  expect(parsed.tokens[parsed.tokens.indexOf('--ask-for-approval') + 1]).toBe('on-request')
  expect(parsed.tokens).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(parsed.tokens).not.toContain('--yolo')
}

test('real sandboxed Codex: tool details, approval, Stop, crash and same-session Resume', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  test.setTimeout(900_000)
  test.skip(process.platform !== 'darwin', 'this live process-identity check uses macOS lsof')
  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  if (isolatedHome === os.homedir()) {
    throw new Error('Expected a disposable test home')
  }
  const codexHome = path.join(isolatedHome, '.codex')
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  for (const name of [
    'auth.json',
    'config.toml',
    'hooks.json',
    'installation_id',
    'version.json'
  ]) {
    const source = path.join(os.homedir(), '.codex', name)
    if (existsSync(source)) {
      copyFileSync(source, path.join(codexHome, name))
    }
  }
  const timeline: string[] = []
  const chat = orcaPage.locator('[data-native-chat-root="true"]:visible').first()
  const composer = chat.locator('textarea').first()
  const record = async (label: string) => {
    timeline.push(`${new Date().toISOString()} ${label}\n${await chat.innerText()}\n`)
    writeFileSync(testInfo.outputPath('timeline.log'), timeline.join('\n'))
    await orcaPage.screenshot({ path: testInfo.outputPath(`${timeline.length}-${label}.png`) })
  }
  const send = async (prompt: string) => {
    await composer.fill(prompt)
    await composer.press('Enter')
  }
  const waitForComposer = async () => {
    const intervention = chat.locator('[data-native-chat-startup-intervention]').first()
    let readySince = 0
    await expect(async () => {
      if (await intervention.isVisible()) {
        readySince = 0
        const kind = await intervention.getAttribute('data-native-chat-startup-intervention')
        const actions: Record<string, string> = {
          'automation-review': 'Continue without it',
          'trust-prompt': 'Trust and continue',
          'update-available': 'Skip this time',
          'model-migration': 'Continue'
        }
        const name = actions[kind ?? '']
        if (!name) {
          throw new Error(`Codex needs manual setup: ${kind}`)
        }
        // Only trust the fixture-owned project. Copied user hooks keep their
        // original path-scoped consent and are explicitly declined in Chat.
        timeline.push(`${new Date().toISOString()} startup: ${kind}; chose ${name}`)
        await intervention.getByRole('button', { name, exact: true }).click()
      }
      const identity = await readPaneIdentitySnapshot(orcaPage)
      const ptyId = identity?.panes.find((pane) => pane.leafId === identity.activeLeafId)?.ptyId
      const screen = ptyId
        ? stripAnsiEscapeSequences(
            await orcaPage.evaluate(async (id) => {
              const snapshot = await window.api.pty.getMainBufferSnapshot(id, { scrollbackRows: 0 })
              return snapshot?.data ?? ''
            }, ptyId)
          )
        : ''
      const ready =
        /›/.test(screen) &&
        !/Hooks\s*need\s*review|hook\s*needs\s*review|Do\s*you\s*trust|Update\s*available/i.test(
          screen
        ) &&
        !(await intervention.isVisible()) &&
        (await composer.isVisible())
      if (!ready) {
        readySince = 0
      } else if (!readySince) {
        readySince = Date.now()
      }
      // Chat can expose its textarea before Codex paints a startup overlay.
      expect(readySince > 0 && Date.now() - readySince >= 1500).toBe(true)
    }).toPass({ timeout: 120_000, intervals: [500] })
  }
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(async (codexHome) => {
      await window.__store!.getState().updateSettings({
        defaultTuiAgent: 'codex',
        agentDefaultArgs: { codex: '--sandbox workspace-write --ask-for-approval on-request' },
        agentDefaultEnv: { codex: { CODEX_HOME: codexHome } },
        experimentalNativeChat: true,
        // Direct Chat launch currently forces bypass permissions. Launch the
        // sandboxed Terminal session first, then view that same process in Chat.
        openAgentTabsInChatByDefault: false,
        experimentalStructuredNativeChat: false
      })
    }, codexHome)
    await expect(async () => {
      await orcaPage.keyboard.press('Escape')
      await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
      await expect(orcaPage.getByRole('menuitem', { name: /^Codex(?:\s|$)/i }).first()).toBeVisible(
        { timeout: 5_000 }
      )
    }).toPass({ timeout: 120_000, intervals: [3_000] })
    const previousTabId = (await readPaneIdentitySnapshot(orcaPage))?.tabId
    if (!previousTabId) {
      throw new Error('Expected the existing fixture terminal before launching Codex')
    }
    await orcaPage
      .getByRole('menuitem', { name: /^Codex(?:\s|$)/i })
      .first()
      .click()
    // New-tab launch is async; the old shell already has a valid PTY binding.
    await expect
      .poll(async () => (await readPaneIdentitySnapshot(orcaPage))?.tabId ?? previousTabId, {
        timeout: 120_000,
        message: 'Codex launch did not select a new terminal tab'
      })
      .not.toBe(previousTabId)
    const launchedPtyId = await waitForActivePanePtyId(orcaPage, 120_000)
    let launchParentPid = 0
    await expect
      .poll(
        async () => {
          launchParentPid = await orcaPage.evaluate(
            async (ptyId) =>
              (await window.api.pty.management.listSessions()).sessions.find(
                (session) => session.sessionId === ptyId && session.isAlive
              )?.pid ?? 0,
            launchedPtyId
          )
          return launchParentPid
        },
        {
          timeout: 30_000,
          message: `No daemon process owner for the new Codex PTY ${launchedPtyId}`
        }
      )
      .toBeGreaterThan(0)
    let launchPid = 0
    await expect(() => {
      launchPid = codexDescendant(launchParentPid)
    }).toPass({ timeout: 60_000, intervals: [250] })
    // The renderer's launch registry may still be empty at hook review. Read
    // actual argv from the one Codex process owned by this disposable PTY.
    const readLaunchArgs = () =>
      execFileSync('ps', ['-p', String(launchPid), '-o', 'command='], {
        encoding: 'utf8'
      }).trim()
    const launchArgs = readLaunchArgs()
    expectSandboxedCodex(launchArgs)
    timeline.push(
      `${new Date().toISOString()} test Codex pid=${launchPid}; actual argv: ${launchArgs}`
    )
    await orcaPage.getByRole('radio', { name: 'Chat', exact: true }).click()
    expect(await waitForActivePanePtyId(orcaPage)).toBe(launchedPtyId)
    await expect(chat).toBeVisible({ timeout: 120_000 })
    await waitForComposer()
    expect(codexDescendant(launchParentPid)).toBe(launchPid)
    expect(readLaunchArgs()).toBe(launchArgs)
    expect(stripAnsiEscapeSequences(await getTerminalContent(orcaPage))).not.toContain('YOLO mode')
    await send(
      'UI diagnostic only. Remember the code word TERN. Run exactly one shell command: sleep 4; printf CODEX-TOOL-OUTPUT. If you use JavaScript execution, emit the shell tool result with text(...). Then reply exactly CODEX-TOOLS-ONE. Do not inspect or change files or delegate.'
    )
    await expect(chat).toHaveAttribute('data-native-chat-working', 'true', { timeout: 60_000 })
    await record('working')
    await expect(chat.getByText('CODEX-TOOLS-ONE', { exact: true }).first()).toBeVisible({
      timeout: 240_000
    })
    const tools = chat.getByRole('button', { name: /^\d+×/ }).first()
    await expect(tools).toBeVisible()
    await tools.click()
    await chat
      .getByRole('button', { name: /^Result / })
      .first()
      .click()
    await expect(chat.locator('pre').filter({ hasText: 'CODEX-TOOL-OUTPUT' }).first()).toBeVisible()
    await record('tool-details')

    await send(
      'UI approval diagnostic only. Request explicit user approval using sandbox_permissions=require_escalated and justification="Allow the harmless approval diagnostic?" for the shell command printf CODEX-APPROVAL-OUTPUT. Do not run without requesting approval and do not change files. After approval reply exactly CODEX-APPROVED.'
    )
    const allow = chat.getByRole('button', { name: 'Allow', exact: true })
    await expect(allow).toBeVisible({ timeout: 120_000 })
    await expect(chat.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
    await record('approval')
    await allow.click()
    await expect(chat.getByText('CODEX-APPROVED', { exact: true }).first()).toBeVisible({
      timeout: 180_000
    })
    await send(
      'UI Stop diagnostic only. Run sleep 45 and then reply exactly CODEX-STOP-FINISHED. Do not change files or delegate.'
    )
    const stop = chat.locator('[data-native-chat-critical-action="stop"]')
    await expect(stop).toBeVisible({ timeout: 60_000 })
    const codexBeforeStop = readProcessIdentity(launchPid)
    expect(codexBeforeStop).not.toBeNull()
    let sleepIdentity: ProcessIdentity | null = null
    await expect
      .poll(
        () => {
          const candidates = descendantProcesses(launchPid).filter(
            (process) => path.basename(process.name) === 'sleep'
          )
          if (candidates.length !== 1) {
            return false
          }
          const candidate = readProcessIdentity(candidates[0].pid)
          if (!candidate || !/(?:^|\/)sleep 45$/.test(candidate.argv)) {
            return false
          }
          sleepIdentity = candidate
          return true
        },
        { timeout: 60_000, intervals: [100] }
      )
      .toBe(true)
    if (!sleepIdentity) {
      throw new Error('No exact sleep 45 child was observed under the test Codex process')
    }
    const sleeping = sleepIdentity as ProcessIdentity
    // Require a newly started sleep and a deadline far below 45 seconds, so
    // natural completion cannot satisfy the Stop assertion.
    expect(Date.now() - Date.parse(sleeping.startedAt)).toBeLessThan(5_000)
    expect(readProcessIdentity(sleeping.pid)).toEqual(sleeping)
    expect(descendantProcesses(launchPid).some((process) => process.pid === sleeping.pid)).toBe(
      true
    )
    timeline.push(
      `${new Date().toISOString()} before UI Stop: ${JSON.stringify({ codex: codexBeforeStop, sleep: sleeping })}`
    )
    await stop.click({ timeout: 5_000 })
    await expect
      .poll(
        () => {
          const current = readProcessIdentity(sleeping.pid)
          // A recycled PID is a different process; start time and argv identify
          // the original child even if the OS has already reused its PID.
          return current?.startedAt === sleeping.startedAt && current.argv === sleeping.argv
        },
        { timeout: 10_000, intervals: [100] }
      )
      .toBe(false)
    expect(readProcessIdentity(launchPid)).toEqual(codexBeforeStop)
    timeline.push(
      `${new Date().toISOString()} UI Stop terminated the exact sleep child; Codex remains alive`
    )
    await expect(chat).toHaveAttribute('data-native-chat-working', 'false', { timeout: 60_000 })
    await expect(composer).toBeVisible()
    await record('stopped')

    const identity = await readPaneIdentitySnapshot(orcaPage)
    const ptyId = identity?.panes.find((pane) => pane.leafId === identity.activeLeafId)?.ptyId
    if (!ptyId) {
      throw new Error('Cannot establish the test pane identity')
    }
    const ownership = await orcaPage.evaluate(
      async (ptyId) =>
        (await window.api.pty.management.listSessions()).sessions.find(
          (session) => session.sessionId === ptyId
        ),
      ptyId
    )
    if (!testRepoPath.includes('orca-e2e-repo-')) {
      throw new Error('Expected the fixture-owned disposable repository')
    }
    if (ptyId !== launchedPtyId || !ownership?.isAlive || ownership.pid !== launchParentPid) {
      throw new Error('Test PTY process ownership changed')
    }
    const parentPid = ownership.pid
    const pid = codexDescendant(parentPid)
    const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8'
    })
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1)
    if (
      !cwd ||
      realpathSync(cwd) !== realpathSync(testRepoPath) ||
      codexDescendant(parentPid) !== pid ||
      pid !== launchPid ||
      JSON.stringify(readProcessIdentity(pid)) !== JSON.stringify(codexBeforeStop)
    ) {
      throw new Error('Test process identity changed')
    }
    timeline.push(`Verified test process pid=${pid}, parent=${parentPid}, cwd=${cwd}`)
    process.kill(pid, 'SIGKILL')
    // The exit banner is rendered once by the shared session-work rail
    // (PtySessionWorkRail), not inside [data-native-chat-root] — scope to the
    // rail rather than the chat root so this still finds the single copy.
    const exited = orcaPage.locator(
      '[data-session-work-rail] [data-native-chat-agent-exited="true"]'
    )
    await expect(exited).toBeVisible({ timeout: 90_000 })
    await expect(chat.getByText('CODEX-TOOLS-ONE', { exact: true }).first()).toBeVisible()
    await record('crashed')
    await exited.getByRole('button', { name: /Resume/i }).click()
    await waitForComposer()
    const resumedPtyId = await waitForActivePanePtyId(orcaPage)
    expect(resumedPtyId).not.toBe(launchedPtyId)
    const resumedOwner = await orcaPage.evaluate(
      async (ptyId) =>
        (await window.api.pty.management.listSessions()).sessions.find(
          (session) => session.sessionId === ptyId && session.isAlive
        ),
      resumedPtyId
    )
    expect(resumedOwner?.pid).toBeGreaterThan(0)
    if (!resumedOwner?.pid) {
      throw new Error('No live process owner for the resumed Codex PTY')
    }
    const resumedPid = codexDescendant(resumedOwner.pid)
    expect(resumedPid).not.toBe(launchPid)
    const resumedProcess = readProcessIdentity(resumedPid)
    expect(resumedProcess).not.toBeNull()
    expectSandboxedCodex(resumedProcess!.argv)
    timeline.push(
      `${new Date().toISOString()} resumed PTY=${resumedPtyId}; actual process: ${JSON.stringify(resumedProcess)}`
    )
    await expect(chat.getByText('CODEX-TOOLS-ONE', { exact: true }).first()).toBeVisible({
      timeout: 60_000
    })
    await expect(chat.getByRole('button', { name: /GPT-6 Astra/ }).first()).toBeVisible({
      timeout: 60_000
    })
    await send(
      'UI continuity diagnostic only. Reply exactly CODEX-RESUMED followed by a space and the code word I first asked you to remember. Do not use tools or change files.'
    )
    // A status-header preview can precede the rendered transcript bubble.
    await expect(
      chat
        .locator('p')
        .filter({ hasText: /^CODEX-RESUMED TERN$/ })
        .first()
    ).toBeVisible({
      timeout: 240_000
    })
    await record('resumed-same-session')
  } finally {
    timeline.push(`Final terminal:\n${await getTerminalContent(orcaPage).catch(() => '')}`)
    writeFileSync(testInfo.outputPath('timeline.log'), timeline.join('\n'))
    await testInfo.attach('timeline', { body: timeline.join('\n'), contentType: 'text/plain' })
    rmSync(codexHome, { recursive: true, force: true })
  }
})
