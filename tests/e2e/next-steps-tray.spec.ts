import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_READY_MARKER,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  waitForActivePaneHookDescriptor,
  waitForTerminalOutput,
  type ActivePaneHookDescriptor
} from './helpers/terminal'

/**
 * Suggested next steps: the reply's own steps lead with no AI call, Run, the one-click Yes to a
 * session's question, and Keep going following the session's plan until the person types.
 */

test.use({
  // Why: JEV must never reach TypeSafe from a test; it fails open when off.
  launchEnv: {
    ...getGoldenStubAgentLaunchEnv(),
    JEV_DECISIONS_DISABLED: '1',
    GOLDEN_STUB_RECEIPTS: '1'
  }
})

// Each step carries a short token the stub's receipts show, whatever the terminal's width.
const STEPS = [
  'Add a regression test for empty input [tok-step1]',
  'Document the empty-input behaviour in the parser notes [tok-step2]',
  'Tidy the parser module comments [tok-step3]'
] as const

const REPLY = [
  'I fixed the parser so empty input returns an empty list, and the unit tests pass (reply-one).',
  '',
  'Next steps:',
  ...STEPS.map((step, at) => `${at + 1}. ${step}`)
].join('\n')

const SUBMITTED = '[GOLDEN_STUB_AGENT_SUBMITTED]'

/** What the suggester would answer; any call for a turn that proposed its own steps is a failure. */
const AI_SET = [
  {
    title: 'Run the parser unit tests once more',
    prompt: 'Run the parser unit tests once more and say whether they pass. [tok-ai1]',
    why: 'Confirms the empty-input fix holds.',
    risk: 'safe',
    kind: 'verify'
  }
] as const

type Conversation = ActivePaneHookDescriptor & { chat: Locator; tray: Locator }
type Transcript = { sessionId: string; path: string }

/** SETUP: the one-shot command the AI suggester runs, as the codex override. */
async function configureSuggester(page: Page, command: string): Promise<void> {
  await page.evaluate(async (suggester) => {
    const store = window.__store!
    const settings = store.getState().settings!
    await store.getState().updateSettings({
      agentCmdOverrides: { ...settings.agentCmdOverrides, codex: suggester },
      nextStepSuggestions: { enabled: true, ...settings.nextStepSuggestions, agent: 'codex' }
    })
  }, command)
}

/**
 * A suggester that records every turn it is asked about (by the reply's `reply-…` marker) and
 * answers `AI_SET`; anything else, such as suggested starts, fails.
 */
function writeRecordingSuggester(scratchDir: string): { script: string; calls: () => string } {
  const script = path.join(scratchDir, 'recording-suggester.sh')
  const log = path.join(scratchDir, 'suggester-calls.log')
  // The prompt may arrive on stdin or as the last argument.
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'input="$(cat; printf %s "$*")"',
      'case "$input" in',
      `  *reply-*) printf '%s\\n' "$input" | grep -o 'reply-[a-z]*' | head -n 1 >> '${log}'; printf '%s\\n' '${JSON.stringify({ suggestions: AI_SET })}' ;;`,
      '  *) exit 1 ;;',
      'esac',
      ''
    ].join('\n')
  )
  chmodSync(script, 0o755)
  return { script, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') }
}

/** The stub's receipt lines (`RECEIPT n: …`), one per prompt it ever received, as rendered. */
async function stubReceipts(page: Page): Promise<string> {
  const screen = await getTerminalContent(page, 20_000)
  return [...screen.matchAll(/RECEIPT \d+: [\w/ -]*/g)]
    .map((match) => match[0].trimEnd())
    .join('\n')
}

async function startStubConversation(page: Page, suggester: string): Promise<Conversation> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await configureGoldenStubAgent(page, { agent: 'claude', chatView: true })
  await configureSuggester(page, suggester)
  await launchGoldenStubAgentIntoChat(page, 'claude')
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
  const descriptor = await waitForActivePaneHookDescriptor(page)
  const chat = page.locator('[data-native-chat-root="true"]').first()
  return { ...descriptor, chat, tray: chat.locator('[data-next-steps-tray]') }
}

async function postClaudeHook(
  app: ElectronApplication,
  conversation: ActivePaneHookDescriptor,
  payload: Record<string, unknown>
): Promise<void> {
  const endpoint = await readHookEndpoint(app)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': endpoint.token },
    body: JSON.stringify({
      paneKey: conversation.paneKey,
      tabId: conversation.paneKey.split(':')[0],
      worktreeId: conversation.worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload
    })
  })
  if (response.status !== 204) {
    throw new Error(`Claude ${String(payload.hook_event_name)} hook returned ${response.status}`)
  }
}

/**
 * SETUP: one finished Claude turn as Claude Code's hooks report it, with its transcript on disk,
 * so the host observes a real turn and reads the reply's own steps.
 */
async function finishTurn(
  app: ElectronApplication,
  conversation: ActivePaneHookDescriptor,
  transcript: Transcript,
  turn: { prompt: string; reply: string; at: number }
): Promise<void> {
  // Why stamped earlier: a reply newer than the host's turn stamp hides the tray until it catches up.
  const line = (role: 'user' | 'assistant', text: string, at: number) => ({
    sessionId: transcript.sessionId,
    uuid: `${transcript.sessionId}-${role}-${at}`,
    timestamp: new Date(at).toISOString(),
    type: role,
    message:
      role === 'user'
        ? { role, content: [{ type: 'text', text }] }
        : { model: 'claude-opus-4', content: [{ type: 'text', text }] }
  })
  appendFileSync(
    transcript.path,
    `${[line('user', turn.prompt, turn.at), line('assistant', turn.reply, turn.at + 1_000)]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`
  )
  const session = { session_id: transcript.sessionId, transcript_path: transcript.path }
  await postClaudeHook(app, conversation, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: turn.prompt
  })
  await postClaudeHook(app, conversation, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: turn.reply
  })
}

/**
 * SETUP: the agent takes a delivered prompt, as Claude Code's UserPromptSubmit hook reports it.
 * The host confirms a delivery to an idle agent only on this turn start, so a real agent's Stop
 * always comes after it.
 */
async function acceptPrompt(
  app: ElectronApplication,
  conversation: ActivePaneHookDescriptor,
  transcript: Transcript,
  prompt: string
): Promise<void> {
  await postClaudeHook(app, conversation, {
    session_id: transcript.sessionId,
    transcript_path: transcript.path,
    hook_event_name: 'UserPromptSubmit',
    prompt
  })
}

const FIRST_TURN = { prompt: 'Fix the parser crash on empty input.', reply: REPLY }

async function expectRows(tray: Locator, titles: readonly string[]): Promise<void> {
  await expect(tray.getByText(titles[0]!, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(tray.getByText('Suggested next steps', { exact: true })).toBeVisible()
  for (const title of titles) {
    await expect(tray.getByText(title, { exact: true })).toBeVisible()
    await expect(tray.getByRole('checkbox', { name: title, exact: true })).not.toBeChecked()
    await expect(tray.getByRole('button', { name: `Run: ${title}`, exact: true })).toBeVisible()
  }
}

test.describe('Suggested next steps tray', () => {
  let scratchDir: string
  let transcript: Transcript
  test.beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-next-steps-'))
    const sessionId = randomUUID()
    transcript = { sessionId, path: path.join(scratchDir, `${sessionId}.jsonl`) }
    writeFileSync(transcript.path, '')
  })
  test.afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true })
  })

  test("shows the reply's steps as the tray, asks no AI, and runs only the ticked one", async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    test.skip(process.platform === 'win32', 'the recording suggester is a POSIX shell script')
    const suggester = writeRecordingSuggester(scratchDir)
    const conversation = await startStubConversation(orcaPage, suggester.script)
    await finishTurn(electronApp, conversation, transcript, {
      ...FIRST_TURN,
      at: Date.now() - 10_000
    })
    const { tray } = conversation

    await expectRows(tray, STEPS)
    // The session's own steps are the turn's answer: no AI call, no AI rows beside them.
    await orcaPage.waitForTimeout(4_000)
    expect(suggester.calls()).toBe('')
    await expect(tray.getByText('Thinking of next steps…', { exact: true })).toHaveCount(0)
    await expect(tray.getByText(AI_SET[0].title, { exact: true })).toHaveCount(0)
    await expect(tray.getByRole('button', { name: 'Run all safe (3)', exact: true })).toBeEnabled()
    await expect(tray.getByRole('button', { name: 'Run selected (0)', exact: true })).toBeDisabled()
    await expect(
      tray.getByRole('button', { name: 'Save for later (0)', exact: true })
    ).toBeDisabled()
    await expect(
      tray.getByRole('button', { name: 'Dismiss suggestions', exact: true })
    ).toBeVisible()
    await expect(tray.getByRole('switch', { name: 'Keep going', exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('next-steps-tray.png') })

    // A middle row: a dispatcher that always sends the first step fails here.
    await tray.getByRole('checkbox', { name: STEPS[1], exact: true }).click()
    await expect(tray.getByRole('checkbox', { name: STEPS[1], exact: true })).toBeChecked()
    await expect(
      tray.getByRole('button', { name: 'Save for later (1)', exact: true })
    ).toBeEnabled()
    await tray.getByRole('button', { name: 'Run selected (1)', exact: true }).click()

    // The chosen prompt reaches the agent as the person's own message.
    await waitForTerminalOutput(orcaPage, `${SUBMITTED} Please go ahead`, 30_000)
    await expect.poll(() => stubReceipts(orcaPage), { timeout: 5_000 }).toContain('tok-step2')
    // An answered turn offers nothing more.
    await expect(tray.getByText(STEPS[1], { exact: true })).toHaveCount(0, { timeout: 15_000 })
    // Why a pause: had the unticked steps been queued, one drain tick would show or send them.
    await orcaPage.waitForTimeout(4_000)
    await expect(orcaPage.locator('[data-prompt-queue-entry]')).toHaveCount(0)
    const receipts = await stubReceipts(orcaPage)
    expect(receipts).toBe('RECEIPT 1: tok-step2')
    expect(receipts).not.toMatch(/tok-step1|tok-step3/)
    await orcaPage.screenshot({ path: testInfo.outputPath('next-steps-ran-one.png') })
  })

  test('one click on "Yes" answers a session that asked, whatever the risk label', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    test.skip(process.platform === 'win32', 'the recording suggester is a POSIX shell script')
    const suggester = writeRecordingSuggester(scratchDir)
    const conversation = await startStubConversation(orcaPage, suggester.script)
    const proposal =
      'make those two wording fixes, and save the rebuilt originals as backups next to the skills [tok-yes1]'
    await finishTurn(electronApp, conversation, transcript, {
      prompt: 'Check the three rewritten skills.',
      reply: `I rebuilt the three skills and found two wording problems (reply-ask).\n\nShould I ${proposal}?`,
      at: Date.now() - 10_000
    })
    const { tray } = conversation
    const title = `M${proposal.slice(1)}`
    const answer = tray.locator('[data-next-steps-answer="yes"]')
    await expect(answer).toBeVisible({ timeout: 30_000 })
    await expect(answer.getByRole('button', { name: /^Yes: / })).toHaveCount(1)
    // "Backups" reads risky: it is left out of "Run all safe", yet Yes is one click.
    await expect(tray.getByRole('button', { name: 'Run all safe (0)', exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('next-steps-yes.png') })
    await answer.getByRole('button', { name: `Yes: ${title}`, exact: true }).click()

    await expect.poll(() => stubReceipts(orcaPage), { timeout: 30_000 }).toBe('RECEIPT 1: tok-yes1')
    await waitForTerminalOutput(orcaPage, `${SUBMITTED} Please go ahead`, 5_000)
    await expect(answer).toHaveCount(0, { timeout: 15_000 })
    expect(suggester.calls()).toBe('')
  })

  test('Keep going follows the session’s plan round after round, and stops when the person types', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    test.skip(process.platform === 'win32', 'the recording suggester is a POSIX shell script')
    const suggester = writeRecordingSuggester(scratchDir)
    const conversation = await startStubConversation(orcaPage, suggester.script)
    await finishTurn(electronApp, conversation, transcript, {
      ...FIRST_TURN,
      at: Date.now() - 10_000
    })
    const { tray, chat } = conversation

    // The reply's own steps, with no AI call.
    await expectRows(tray, STEPS)
    const keepGoing = tray.getByRole('switch', { name: 'Keep going', exact: true })
    await expect(keepGoing).toBeEnabled({ timeout: 15_000 })
    await expect(keepGoing).not.toBeChecked()
    await keepGoing.click()

    // Round 1 goes out with no click: the session's own first step, behind its visible marker.
    const running = chat.locator('[data-next-steps-keep-going-running]')
    await expect(running).toContainText(/^Keep going · Next steps · round 1 of \d+/)
    await expect(running.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    await expect
      .poll(() => stubReceipts(orcaPage), { timeout: 30_000 })
      .toMatch(/^RECEIPT 1: KG1\/\d+ tok-step1$/)
    await waitForTerminalOutput(orcaPage, `${SUBMITTED} [Keep going 1/`, 5_000)
    await orcaPage.screenshot({ path: testInfo.outputPath('keep-going-round-1.png') })

    // Round 1's turn finishes and the reply proposes again: round 2 goes (it never stops itself).
    // Why the marker alone: the host takes a recorded prompt that prefixes what it sent.
    const markerOf = async (round: number) => {
      const found = new RegExp(`\\[Keep going ${round}/\\d+ · kg-[^\\]\\s]+\\]`).exec(
        await getTerminalContent(orcaPage)
      )
      if (!found) {
        throw new Error(`Round ${round}'s Keep going marker is not on the stub's screen`)
      }
      return found[0]
    }
    const firstMarker = await markerOf(1)
    await acceptPrompt(electronApp, conversation, transcript, firstMarker)
    // Why a pause: the drain settles the delivery on that turn start, before the turn can finish.
    await orcaPage.waitForTimeout(3_000)
    await finishTurn(electronApp, conversation, transcript, {
      prompt: firstMarker,
      reply: [
        'Added the regression test; the parser tests pass (reply-two).',
        '',
        'Next steps:',
        '1. Cover whitespace-only input in the parser tests [tok-step4]',
        '2. Tidy the parser test names [tok-step5]'
      ].join('\n'),
      at: Date.now() - 2_000
    })
    await expect
      .poll(() => stubReceipts(orcaPage), { timeout: 30_000 })
      .toMatch(/^RECEIPT 1: KG1\/\d+ tok-step1\nRECEIPT 2: KG2\/\d+ tok-step4$/)
    await orcaPage.screenshot({ path: testInfo.outputPath('keep-going-round-2.png') })

    // The person types: Keep going stops for good, before round 2's turn finishes.
    const composer = chat.locator('textarea').last()
    await composer.click()
    await composer.pressSequentially('actually, wait')
    await expect(chat.getByText('Stopped: you started typing', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(running).toHaveCount(0)
    await finishTurn(electronApp, conversation, transcript, {
      prompt: await markerOf(2),
      reply: 'Done (reply-three).\n\nNext steps:\n1. Update the changelog [tok-step6]',
      at: Date.now() - 1_000
    })
    await expectRows(tray, ['Update the changelog [tok-step6]'])
    // Why a pause: an enabled Keep going sends from a pending set within one 2 s tick.
    await orcaPage.waitForTimeout(6_000)
    expect(await stubReceipts(orcaPage)).toMatch(
      /^RECEIPT 1: KG1\/\d+ tok-step1\nRECEIPT 2: KG2\/\d+ tok-step4$/
    )
    expect(await getTerminalContent(orcaPage)).not.toMatch(/KG3\/|tok-step6/)
    // Every turn proposed its own steps: the suggester was never asked.
    expect(suggester.calls()).toBe('')
    await orcaPage.screenshot({ path: testInfo.outputPath('keep-going-stopped-typing.png') })
  })
})
