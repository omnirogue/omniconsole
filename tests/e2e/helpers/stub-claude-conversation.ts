import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { readHookEndpoint } from './agent-hook-endpoint'
import { configureGoldenStubAgent, GOLDEN_STUB_READY_MARKER } from './golden-stub-agent'
import {
  getTerminalContent,
  waitForActivePaneHookDescriptor,
  waitForTerminalOutput,
  type ActivePaneHookDescriptor
} from './terminal'

/**
 * Golden-stub Claude conversations driven through the real `omni` CLI and Claude hook endpoint of
 * the app under test, shared by the session-management specs on one computer and across a pairing.
 */

/** `agentPid`: the stub's own process, which its simulated hooks name as the agent. */
export type Conversation = ActivePaneHookDescriptor & {
  transcript: Transcript
  tabId: string
  agentPid: number
}
export type Transcript = { sessionId: string; path: string }
export type CliResult = { status: number; stdout: string; stderr: string; json: unknown }

const CLI_PATH = path.join(process.cwd(), 'out', 'cli', 'index.js')

/** Runs the real `omni` CLI against the app under test, as the plain local CLI actor. */
export function runCli(userDataPath: string, args: string[]): CliResult {
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ORCA_USER_DATA_PATH: userDataPath }
    })
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    status = err.status ?? 1
    stdout = err.stdout ?? ''
    return { status, stdout, stderr: err.stderr ?? '', json: parseJsonSafely(stdout) }
  }
  return { status, stdout, stderr: '', json: parseJsonSafely(stdout) }
}

/** Non-blocking variant for a CLI call the test must run concurrently with other page actions. */
export function runCliAsync(userDataPath: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        env: { ...process.env, ORCA_USER_DATA_PATH: userDataPath }
      },
      (error, stdout, stderr) => {
        const status = error ? ((error as { code?: number }).code ?? 1) : 0
        resolve({ status, stdout, stderr, json: parseJsonSafely(stdout) })
      }
    )
  })
}

/** Unwraps the CLI's RPC envelope ({id, ok, result} | {id, ok, error}) to its payload. */
function parseJsonSafely(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as { result?: unknown; error?: unknown }
    if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed)) {
      return parsed.result ?? parsed.error ?? parsed
    }
    return parsed
  } catch {
    return null
  }
}

export async function userDataPathOf(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
}

export async function postClaudeHook(
  app: ElectronApplication,
  conversation: ActivePaneHookDescriptor & { agentPid: number },
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
      // As the real hook scripts do: the process that holds the pane is the agent reporting.
      agentPid: conversation.agentPid,
      agentPidHost: 'local',
      payload
    })
  })
  if (response.status !== 204) {
    throw new Error(`Claude ${String(payload.hook_event_name)} hook returned ${response.status}`)
  }
}

/** SETUP: one finished Claude turn, as Claude Code's hooks report it, with a transcript on disk. */
export async function finishTurn(
  app: ElectronApplication,
  conversation: ActivePaneHookDescriptor & { agentPid: number },
  transcript: Transcript,
  turn: { prompt: string; reply: string; at: number }
): Promise<void> {
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

/** SETUP: the agent takes a delivered prompt, as the UserPromptSubmit hook reports it (no Stop yet). */
export async function acceptPrompt(
  app: ElectronApplication,
  conversation: ActivePaneHookDescriptor & { agentPid: number },
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

/**
 * Launches a stub Claude tab into Chat and scopes to the tab this call created — unlike
 * launchGoldenStubAgentIntoChat's shared `.first()` root, which resolves a hidden, earlier
 * conversation's root once more than one chat tab exists.
 */
export async function launchStubIntoOwnTab(page: Page): Promise<string> {
  const tabId = await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('no active worktree')
    }
    const tab = state.createTab(worktreeId, undefined, undefined, {
      launchAgent: 'claude',
      viewMode: 'chat',
      pendingStartup: {
        command: 'golden-stub-agent',
        launchAgent: 'claude',
        startupCommandDelivery: 'shell-ready'
      }
    } as never)
    state.setActiveTabType('terminal')
    return tab.id
  })
  await expect(page.locator('[data-native-chat-root="true"]:visible')).toBeVisible({
    timeout: 30_000
  })
  return tabId
}

export async function startStubConversation(
  page: Page,
  userDataPath: string,
  title: string
): Promise<Conversation> {
  await configureGoldenStubAgent(page, { agent: 'claude', chatView: true })
  const tabId = await launchStubIntoOwnTab(page)
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
  const descriptor = await waitForActivePaneHookDescriptor(page)
  const agentPid = Number(
    /\[GOLDEN_STUB_AGENT_PID\] (\d+)/.exec(await getTerminalContent(page, 20_000))?.[1]
  )
  if (!Number.isSafeInteger(agentPid) || agentPid <= 1) {
    throw new Error(`setup: the stub in ${descriptor.paneKey} did not show its pid`)
  }
  const transcript = { sessionId: randomUUID(), path: '' }
  // The same `omni session rename` under test names each stub conversation so list/DOM
  // assertions can address them by title.
  const renamed = runCli(userDataPath, [
    'session',
    'rename',
    '--pane',
    descriptor.paneKey,
    '--title',
    title,
    '--json'
  ])
  if (renamed.status !== 0) {
    throw new Error(
      `setup: renaming ${descriptor.paneKey} to "${title}" failed: ${renamed.stdout}${renamed.stderr}`
    )
  }
  return { ...descriptor, tabId, transcript, agentPid }
}
