// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  HandoffDetail,
  HandoffReceiveSummary
} from '../../../../shared/console-handoff-contract'
import { HandoffTransferBar } from './HandoffTransferBar'
import { handoffFileOutcomeCounts } from './useHandoffTransfer'
import { readPendingHandoff } from './handoff-request-memory'

const api = vi.hoisted(() => ({ materialize: vi.fn(), respond: vi.fn(), pickFolder: vi.fn() }))
vi.mock('./handoff-client', () => ({ handoffApi: () => api }))
vi.mock('./HandoffSessionButton', () => ({ HandoffSessionButton: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, number>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key) => String(values?.[key]))
}))
const detail = { thread: { id: 'hth_one' } } as HandoffDetail
const summary = {
  files: {
    files: [
      { outcome: 'written' },
      { outcome: 'unchanged' },
      { outcome: 'refused' },
      { outcome: 'written' }
    ]
  }
} as HandoffReceiveSummary
const changed = vi.fn()
function show() {
  return render(
    <HandoffTransferBar scope="test" detail={detail} onChanged={changed} onReply={vi.fn()} />
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    value: { repos: { pickFolder: api.pickFolder } },
    configurable: true
  })
  api.pickFolder.mockResolvedValue('/chosen')
  api.materialize.mockResolvedValue({ ok: true, data: summary })
  api.respond.mockResolvedValue({ ok: true, data: detail })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('counts outcomes, including refusals, without reporting them as written', () => {
  expect(handoffFileOutcomeCounts(summary)).toEqual({ written: 2, unchanged: 1, refused: 1 })
})
it('has no Mark done button; the recipient bar only saves files, starts a session, or replies', () => {
  show()
  expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save files…' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy()
})
it('retains the chosen destination across a lost response and remount', async () => {
  api.materialize.mockRejectedValueOnce(new Error('Offline'))
  const view = show()
  fireEvent.click(screen.getByRole('button', { name: 'Save files…' }))
  await screen.findByText('Offline')
  const saved = readPendingHandoff('test', 'act:hth_one:save-files')
  expect(saved?.kind).toBe('materialize')
  view.unmount()
  show()
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving files' }))
  await screen.findByText('2 written · 1 unchanged · 1 refused')
  expect(api.pickFolder).toHaveBeenCalledOnce()
  expect(api.materialize.mock.calls).toEqual([
    [{ threadId: 'hth_one', workspacePath: '/chosen', filesOnly: true }],
    [{ threadId: 'hth_one', workspacePath: '/chosen', filesOnly: true }]
  ])
  expect(readPendingHandoff('test', 'act:hth_one:save-files')).toBeNull()
})
it('does nothing when the folder picker is cancelled', async () => {
  api.pickFolder.mockResolvedValue(null)
  show()
  fireEvent.click(screen.getByRole('button', { name: 'Save files…' }))
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save files…' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  expect(api.materialize).not.toHaveBeenCalled()
  expect(readPendingHandoff('test', 'act:hth_one:save-files')).toBeNull()
})
