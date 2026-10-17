// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useAppStore } from '@/store'
import { NextStepsImproveThis } from './NextStepsImproveThis'
import { improveThisPrompt, improveThisSeed } from './next-steps-improve-this'

const mocks = vi.hoisted(() => ({
  target: 'local' as string | undefined,
  create: vi.fn(() => 'improve-tab'),
  update: vi.fn(),
  rpc: vi.fn(),
  stop: vi.fn(async () => {})
}))
vi.mock('./NextStepsKeepGoing', () => ({ stopKeepGoingForPersonAction: mocks.stop }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  AGENT_DETECTION_LOCAL_TARGET_KEY: 'local',
  getAgentDetectionTargetKeyForWorktree: () => mocks.target
}))
vi.mock('@/lib/local-workflow-conversation', () => ({
  createLocalWorkflowConversation: mocks.create,
  updateLocalWorkflowConversation: mocks.update
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const message = (role: 'user' | 'assistant', text: string, id: string): NativeChatMessage => ({
  id,
  role,
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'text', text }]
})
const MESSAGES = [
  message('user', 'Write ad copy for the spring sale.', 'u1'),
  message('assistant', 'Draft one', 'a1'),
  message('user', 'Shorter.', 'u2'),
  message('assistant', 'Spring sale: 30% off everything.', 'a2')
]
const DRAFT = { prompt: '', graph: { spec: { template: 'improve', steps: [] }, team: [] } }
const SOURCE = { worktreeId: 'wt', paneKey: 'tab:1', kind: 'pty' as const }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mocks.target = 'local'
  useAppStore.setState({
    tabsByWorktree: {
      wt: [
        {
          id: 'improve-tab',
          worktreeId: 'wt',
          localWorkflow: { preset: 'council', prompt: '', draft: DRAFT }
        }
      ]
    } as never
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('seeds Improve with the goal and the latest reply, and never while a person message follows it', () => {
  const seed = improveThisSeed(MESSAGES)
  expect(seed).toEqual({
    goal: 'Write ad copy for the spring sale.',
    reply: 'Spring sale: 30% off everything.'
  })
  expect(improveThisPrompt(seed!)).toBe(
    "Write ad copy for the spring sale.\n\nMake this better. It is the agent's latest reply in the conversation:\n\nSpring sale: 30% off everything."
  )
  expect(improveThisSeed([...MESSAGES, message('user', 'Thanks', 'u3')])).toBeNull()
  expect(improveThisSeed([])).toBeNull()
})

it('stops Keep going on the host first, then opens a prefilled Improve tab, never started', async () => {
  render(<NextStepsImproveThis conversation={SOURCE} messages={MESSAGES} />)
  fireEvent.click(screen.getByRole('button', { name: 'Improve this…' }))
  expect(mocks.stop).toHaveBeenCalledWith(SOURCE)
  expect(mocks.create).not.toHaveBeenCalled()
  await settle()
  const prompt = improveThisPrompt(improveThisSeed(MESSAGES)!)
  expect(mocks.create).toHaveBeenCalledWith('wt', 'improve')
  expect(mocks.update).toHaveBeenCalledWith('wt', 'improve-tab', {
    prompt,
    draft: { ...DRAFT, prompt }
  })
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('opens nothing when Keep going could not be stopped', async () => {
  mocks.stop.mockRejectedValueOnce(new Error('host unreachable'))
  render(<NextStepsImproveThis conversation={SOURCE} messages={MESSAGES} />)
  fireEvent.click(screen.getByRole('button', { name: 'Improve this…' }))
  await settle()
  expect(mocks.create).not.toHaveBeenCalled()
})

it('is disabled, with why, outside this computer’s workspaces, and absent without a transcript', () => {
  mocks.target = 'ssh:box'
  const { rerender } = render(<NextStepsImproveThis conversation={SOURCE} messages={MESSAGES} />)
  const button = screen.getByRole('button', { name: 'Improve this…' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.title).toBe('Improve runs on this computer’s workspaces only')
  rerender(<NextStepsImproveThis conversation={SOURCE} messages={undefined} />)
  expect(screen.queryByRole('button', { name: 'Improve this…' })).toBeNull()
})
