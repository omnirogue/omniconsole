// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionPlaces } from '@/store/session-place-store'

const reads = vi.hoisted(() => ({
  place: {
    phase: 'ready' as const,
    place: {
      company: { id: 'cmp_click', slug: 'apexlabs', name: 'ApexLabs' },
      domain: { id: 'dom_ads', name: 'Advertising' },
      project: null
    }
  } as { phase: string; place?: unknown; message?: string }
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/components/companies/use-work-folders', () => ({
  useWorkFoldersScope: () => 'scope',
  useWorkFolders: () => ({
    data: {
      companies: [
        {
          id: 'cmp_click',
          slug: 'apexlabs',
          name: 'ApexLabs',
          domains: [
            { id: 'dom_ads', name: 'Advertising' },
            { id: 'dom_eng', name: 'Engineering' }
          ]
        }
      ]
    },
    error: null,
    loading: false,
    reload: () => {}
  })
}))
vi.mock('./use-next-step-place', () => ({ useNextStepPlace: () => reads.place }))
import { NextStepPlaceSelect } from './NextStepPlaceSelect'
afterEach(cleanup)
beforeEach(() => useSessionPlaces.setState({ places: {}, recentFolders: [], loaded: true }))

const session = { paneKey: 'tab:pane', worktreeId: 'folder:work' } as SidebarSession
const eng = {
  companyId: 'cmp_click',
  unitId: 'dom_eng',
  companyName: 'ApexLabs',
  unitName: 'Engineering'
}

it('shows the folder’s own place until a choice is made, then the choice, and can go back', () => {
  const { container } = render(<NextStepPlaceSelect session={session} />)
  const select = () => container.querySelector('[data-next-step-place]')!
  expect(select().getAttribute('data-next-step-place')).toBe('cmp_click/dom_ads')
  expect(screen.getByRole('combobox', { name: 'Company / Domain' }).textContent).toContain(
    'ApexLabs → Advertising'
  )
  expect(screen.queryByRole('button', { name: 'Use folder’s' })).toBeNull()
  act(() => useSessionPlaces.getState().setPlace('tab:pane', eng))
  expect(select().getAttribute('data-next-step-place')).toBe('cmp_click/dom_eng')
  expect(screen.getByRole('combobox', { name: 'Company / Domain' }).textContent).toContain(
    'ApexLabs → Engineering'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Use folder’s' }))
  expect(useSessionPlaces.getState().places['tab:pane']).toBeUndefined()
  expect(select().getAttribute('data-next-step-place')).toBe('cmp_click/dom_ads')
})

it('asks for a department when the folder sits in the company root, and says when the tree could not be read', () => {
  reads.place = {
    phase: 'ready',
    place: { company: { id: 'cmp_click', slug: 'apexlabs', name: 'ApexLabs' }, domain: null }
  }
  render(<NextStepPlaceSelect session={session} />)
  expect(screen.getByText('ApexLabs · choose a department')).toBeTruthy()
  cleanup()
  reads.place = { phase: 'error', message: 'offline' }
  render(<NextStepPlaceSelect session={session} />)
  expect(screen.getByText('Could not read: offline')).toBeTruthy()
})
