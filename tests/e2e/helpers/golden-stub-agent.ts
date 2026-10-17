import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { focusActiveTerminalInput, waitForTerminalOutput } from './terminal'
import type { BuiltInWindowsTerminalShell } from '../../../src/shared/windows-terminal-shell'

export const GOLDEN_STUB_READY_MARKER = 'GOLDEN_STUB_AGENT_READY'
export const GOLDEN_STUB_EXIT_MARKER = 'GOLDEN_STUB_AGENT_EXITED'

/** Agents exposed by the fixture directory for tab-bar detection. */
export const GOLDEN_STUB_AGENTS = [
  { id: 'codex', menuItemName: /^Codex(?:\s|$)/i },
  { id: 'claude', menuItemName: /^Claude(?:\s|$)/i }
] as const

const fixtureDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'golden-stub-agent')

export function getGoldenStubAgentLaunchEnv(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: [fixtureDir, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter)
  }
}

export type GoldenStubStartupScreen = 'codex-update' | 'codex-trust' | 'claude-trust'

/** Launch env that makes the stub draw one of the captured startup screens over its composer. */
export function getGoldenStubStartupScreenEnv(
  screen: GoldenStubStartupScreen,
  delayMs = 800
): NodeJS.ProcessEnv {
  return {
    ...getGoldenStubAgentLaunchEnv(),
    GOLDEN_STUB_STARTUP: screen,
    GOLDEN_STUB_STARTUP_DELAY_MS: String(delayMs)
  }
}

export async function configureGoldenStubAgent(
  page: Page,
  options: {
    agent?: (typeof GOLDEN_STUB_AGENTS)[number]['id']
    agentArgs?: string
    /** Windows default shell the launch command must survive; ignored elsewhere. */
    windowsShell?: BuiltInWindowsTerminalShell
    /** Open the launched tab in the Chat view (terminal-backed native chat). */
    chatView?: boolean
  } = {}
): Promise<void> {
  const agent = options.agent ?? 'codex'
  await page.evaluate(
    async ({ agent, agentArgs, windowsShell, chatView }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      await store.getState().updateSettings({
        defaultTuiAgent: agent,
        agentCmdOverrides: { [agent]: 'golden-stub-agent' },
        agentDefaultArgs: { [agent]: agentArgs },
        ...(windowsShell ? { terminalWindowsShell: windowsShell } : {}),
        ...(chatView ? { experimentalNativeChat: true, openAgentTabsInChatByDefault: true } : {})
      })
    },
    {
      agent,
      agentArgs: options.agentArgs ?? '',
      windowsShell: options.windowsShell ?? null,
      chatView: options.chatView ?? false
    }
  )
}

/**
 * Launch the stub as an OmniConsole-launched Codex tab that opens in Chat.
 *
 * Why not the tab-bar menu: since #117 the menu lists only agents whose account
 * usage was verified live, which a stub cannot supply. The store path below is
 * what that menu ends up calling for a terminal-backed chat launch.
 */
export async function launchGoldenStubAgentIntoChat(
  page: Page,
  agent: (typeof GOLDEN_STUB_AGENTS)[number]['id'] = 'codex'
): Promise<string> {
  const tabId = await page.evaluate(async (launchAgent) => {
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
      launchAgent,
      viewMode: 'chat',
      pendingStartup: {
        command: 'golden-stub-agent',
        launchAgent,
        startupCommandDelivery: 'shell-ready'
      }
    } as never)
    state.setActiveTabType('terminal')
    return tab.id
  }, agent)
  await expect(page.locator('[data-native-chat-root="true"]').first()).toBeVisible({
    timeout: 30_000
  })
  return tabId
}

export async function launchGoldenStubAgentFromNewTab(
  page: Page,
  menuItemName: RegExp = /^Codex(?:\s|$)/i
): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const launchOption = page.getByRole('menuitem', { name: menuItemName }).first()
  await expect(launchOption).toBeVisible({ timeout: 15_000 })
  await launchOption.click({ force: true })
  await focusActiveTerminalInput(page)
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
}
