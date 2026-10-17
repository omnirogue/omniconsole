// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomComposer } from './RoomComposer'
import { roomDraft } from './room-draft'
import { detail, ID, USER } from '../../../../shared/room-test-fixtures'
import { mentionKey, mentionRoster, mentionToken } from '../../../../shared/room-mentions'

afterEach(cleanup)
describe('room composer', () => {
  it('binds a picker chip to its exact id and sends readable labels plus people ids', async () => {
    const send = vi.fn().mockResolvedValue(true)
    render(<RoomComposer detail={detail} send={send} />)
    const input = screen.getByRole('textbox', { name: 'Room message' })
    fireEvent.change(input, { target: { value: '@Sal', selectionStart: 4 } })
    fireEvent.click(screen.getByRole('option'))
    expect(screen.getByText('@Sal', { selector: '[data-slot="badge"]' })).toHaveAttribute(
      'title',
      USER
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toMatchObject({
      content: '@Sal',
      mentionedUserIds: [USER],
      targetAgentIds: []
    })
    await waitFor(() => expect(input).toHaveValue(''))
  })
  it('does not route hand-typed tokens and excludes manual agents without consuming target slots', () => {
    const agents = Array.from({ length: 7 }, (_, i) => ({
      ...detail.agents[0],
      id: `a0000000-0000-4000-8000-00000000000${i}`,
      name: `Agent ${i}`,
      mode: i < 2 ? ('manual' as const) : ('mentions' as const)
    }))
    const roster = { ...detail, agents }
    const mentions = mentionRoster(roster),
      draft = mentions.map(mentionToken).join(' ')
    const selected = roomDraft(draft, roster, new Set(mentions.map(mentionKey)))
    expect(selected.targetAgentIds).toEqual(agents.slice(2).map((agent) => agent.id))
    expect(selected.valid).toBe(true)
    expect(roomDraft(draft, roster, new Set()).targetAgentIds).toEqual([])
  })
  it('enforces five automatic agents, twenty people and 3000 readable characters', () => {
    const agents = Array.from({ length: 6 }, (_, i) => ({
      ...detail.agents[0],
      id: `${ID.slice(0, -1)}${i}`,
      name: `Agent ${i}`
    }))
    const members = Array.from({ length: 21 }, (_, i) => ({
      userId: `user${i}`,
      name: `Person ${i}`,
      role: 'member'
    }))
    for (const roster of [
      { ...detail, agents },
      { ...detail, members }
    ]) {
      const mentions = mentionRoster(roster)
      expect(
        roomDraft(mentions.map(mentionToken).join(' '), roster, new Set(mentions.map(mentionKey)))
          .valid
      ).toBe(false)
    }
    expect(roomDraft('x'.repeat(3000), detail, new Set()).valid).toBe(true)
    expect(roomDraft('x'.repeat(3001), detail, new Set()).valid).toBe(false)
  })
  it('keeps the same event id on an unchanged failed draft and prevents double submit', async () => {
    const send = vi.fn().mockResolvedValue(false)
    render(<RoomComposer detail={detail} send={send} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello', selectionStart: 5 } })
    const button = screen.getByRole('button', { name: 'Send' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(button).not.toBeDisabled())
    expect(send).toHaveBeenCalledTimes(1)
    fireEvent.click(button)
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0])
  })
  it('lets the keyboard select mentions and leaves IME confirmation alone', () => {
    render(<RoomComposer detail={detail} send={vi.fn()} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(input).toHaveValue('@')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue(`@[Sal](user:${USER}) `)
  })
})
