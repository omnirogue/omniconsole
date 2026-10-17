// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionRowFolderChip } from './SessionRowFolderChip'

const TOP = '00000000-0000-4000-8000-000000000001'
const CHILD = '00000000-0000-4000-8000-000000000002'

beforeEach(() => {
  localStorage.clear()
  useSessionFolders.setState({
    metadata: {
      ...emptySessionFolderMetadata(),
      folders: [
        { id: TOP, name: 'OmniRogue' },
        { id: CHILD, name: 'Checkout', parentId: TOP }
      ],
      membership: { filed: CHILD, loose: SAVED_SESSIONS_FOLDER_ID }
    }
  })
  useSessionSidebarView.setState({
    view: {
      ...emptySessionSidebarView(),
      lens: 'state',
      layout: 'full',
      hidden: [`folder:${TOP}`]
    },
    loaded: true,
    showHidden: false
  })
})

afterEach(cleanup)

describe('SessionRowFolderChip', () => {
  it('shows where a row is filed and opens Folders there, hidden parent included', () => {
    render(<SessionRowFolderChip viewKey="filed" session={{}} />)
    const chip = screen.getByRole('button', { name: 'Show in Folders: OmniRogue / Checkout' })
    expect(chip.textContent).toBe('OmniRogue / Checkout')
    fireEvent.click(chip)
    const { view, showHidden } = useSessionSidebarView.getState()
    expect(view.lens).toBeUndefined()
    expect(view.layout).toBe('full')
    expect(view.collapsed).toEqual(
      expect.arrayContaining([`folder:${TOP}:open`, `folder:${CHILD}:open`])
    )
    expect(showHidden).toBe(true)
  })

  it('names Saved Sessions for a row filed there', () => {
    render(<SessionRowFolderChip viewKey="loose" session={{}} />)
    expect(screen.getByRole('button', { name: 'Show in Folders: Saved Sessions' })).toBeTruthy()
  })

  it('stays out of the Folders and Focus views, and off unfiled rows', () => {
    const { rerender } = render(<SessionRowFolderChip viewKey="nowhere" session={{}} />)
    expect(screen.queryByRole('button')).toBeNull()
    useSessionSidebarView.setState({ view: emptySessionSidebarView() })
    rerender(<SessionRowFolderChip viewKey="filed" session={{}} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  // C3: the chip files a row as the tree does — a paired owner's explicit folder first, named from
  // the owner's catalog when this computer has not received the folder yet.
  it("files a row by its paired owner's folder, naming one this computer lacks from the owner", () => {
    const ADS = '00000000-0000-4000-8000-0000000000ad5'
    const vouched = (folderIdByOwner: string | null) => ({
      environmentId: 'env-studio',
      conversation: '0123456789abcdef01234567',
      ownerPaneKey: null,
      ownerTabId: null,
      rest: 'live' as const,
      listed: true,
      stale: false,
      ownerState: 'ready' as const,
      folderIdByOwner,
      ...(folderIdByOwner === ADS ? { folderByOwner: { id: ADS, name: 'Ads' } } : {})
    })
    // Filed locally in Checkout, but the owner files it at the top: the owner's word shows.
    const { rerender } = render(
      <SessionRowFolderChip viewKey="filed" session={{ mirroredConversation: vouched(TOP) }} />
    )
    expect(screen.getByRole('button', { name: 'Show in Folders: OmniRogue' })).toBeTruthy()
    // A folder only the owner has: named from the owner's catalog.
    rerender(
      <SessionRowFolderChip viewKey="filed" session={{ mirroredConversation: vouched(ADS) }} />
    )
    expect(screen.getByRole('button', { name: 'Show in Folders: Ads' })).toBeTruthy()
    // Explicitly unfiled on the owner: no chip, whatever the local membership says.
    rerender(
      <SessionRowFolderChip viewKey="filed" session={{ mirroredConversation: vouched(null) }} />
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
