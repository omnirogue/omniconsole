// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarOrderedGroup, type OrderedSidebarItem } from './SidebarOrderedGroup'
import { clearSidebarDrag } from './sidebar-drag'
import {
  EMPTY_SIDEBAR_LAYOUT,
  withHidden,
  withOrder,
  withoutHidden,
  type SidebarLayout
} from '../../../../shared/sidebar-layout'

// A minimal store stand-in: the group reads four fields and writes through two.
let layout: SidebarLayout = EMPTY_SIDEBAR_LAYOUT
let customizing = false
const setOrder = vi.fn((scope: string, ids: readonly string[]) => {
  layout = withOrder(layout, scope, ids)
})
const hideRow = vi.fn((id: string, label: string) => {
  layout = withHidden(layout, id, label)
})
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      sidebarLayout: layout,
      sidebarCustomizing: customizing,
      setSidebarOrder: setOrder,
      hideSidebarRow: hideRow,
      restoreSidebarRow: (id: string) => {
        layout = withoutHidden(layout, id)
      },
      resetSidebarLayout: () => {
        layout = EMPTY_SIDEBAR_LAYOUT
      }
    })
}))

let host: HTMLDivElement
let root: Root

function items(ids: readonly string[], reveal: readonly string[] = []): OrderedSidebarItem[] {
  return ids.map((id) => ({
    id,
    label: id.toUpperCase(),
    reveal: reveal.includes(id),
    node: <button type="button">{id}</button>
  }))
}

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node)
  })
}

function rows(): string[] {
  return [...host.querySelectorAll('[data-sidebar-row]')].map(
    (element) => element.getAttribute('data-sidebar-row') ?? ''
  )
}

/** A DragEvent jsdom does not implement, with the one field the drop side needs. */
function fire(element: Element, type: string, clientY: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  })
  Object.defineProperty(event, 'target', { value: element })
  act(() => {
    element.dispatchEvent(event)
  })
}

/** Pick a row up and let the deferred drag record land, as a real gesture does. */
async function pickUp(id: string): Promise<void> {
  const row = host.querySelector(`[data-sidebar-row="${id}"]`)
  if (!row) {
    throw new Error(`no row ${id}`)
  }
  fire(row, 'dragstart', 0)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  layout = EMPTY_SIDEBAR_LAYOUT
  customizing = false
  setOrder.mockClear()
  hideRow.mockClear()
  clearSidebarDrag()
  host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('a reorderable sidebar group', () => {
  it('draws rows in the built-in order when nothing was arranged', () => {
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b', 'c'])} />)
    expect(rows()).toEqual(['a', 'b', 'c'])
  })

  it('draws them in the person’s saved order instead', () => {
    layout = withOrder(EMPTY_SIDEBAR_LAYOUT, 'nav', ['c', 'a'])
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b', 'c'])} />)
    expect(rows()).toEqual(['c', 'a', 'b'])
  })

  it('records the drag one tick after dragstart, not inside it', async () => {
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b'])} />)
    const row = host.querySelector('[data-sidebar-row="a"]')
    if (!row) {
      throw new Error('no row')
    }
    fire(row, 'dragstart', 0)
    // Chromium cancels a drag whose start mutates the document, so nothing has
    // changed yet: the source row is not faded and no drop target is live.
    fire(host.querySelector('[data-sidebar-row="b"]') as Element, 'dragover', 100)
    expect(host.querySelector('[data-drop]')).toBeNull()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fire(host.querySelector('[data-sidebar-row="b"]') as Element, 'dragover', 100)
    expect(host.querySelector('[data-drop]')).not.toBeNull()
  })

  it('saves the new order when a row is dropped on the far half of another', async () => {
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b', 'c'])} />)
    await pickUp('a')
    const target = host.querySelector('[data-sidebar-row="c"]') as Element
    fire(target, 'dragover', 1000)
    fire(target, 'drop', 1000)
    expect(setOrder).toHaveBeenCalledWith('nav', ['b', 'c', 'a'])
  })

  it('ignores a drag that came from another group', async () => {
    render(
      <>
        <SidebarOrderedGroup scope="nav" items={items(['a', 'b'])} />
        <SidebarOrderedGroup scope="other" items={items(['x', 'y'])} />
      </>
    )
    await pickUp('x')
    const target = host.querySelectorAll('[data-sidebar-row="a"]')[0]
    fire(target, 'dragover', 1000)
    fire(target, 'drop', 1000)
    expect(setOrder).not.toHaveBeenCalled()
  })

  it('does not start a reorder from a control inside the row', async () => {
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b'])} />)
    const inner = host.querySelector('[data-sidebar-row="a"] button') as Element
    fire(inner, 'dragstart', 0)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const target = host.querySelector('[data-sidebar-row="b"]') as Element
    fire(target, 'dragover', 1000)
    expect(host.querySelector('[data-drop]')).toBeNull()
  })
})

describe('hiding a row', () => {
  it('leaves it out once the person put it away', () => {
    layout = withHidden(EMPTY_SIDEBAR_LAYOUT, 'b', 'B')
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b', 'c'])} />)
    expect(rows()).toEqual(['a', 'c'])
  })

  it('still draws a hidden row that carries something needing the person', () => {
    layout = withHidden(EMPTY_SIDEBAR_LAYOUT, 'b', 'B')
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b', 'c'], ['b'])} />)
    // Collapsed, never hidden: a preference may not hide work that needs a human.
    expect(rows()).toEqual(['a', 'b', 'c'])
  })

  it('offers the hide and move controls only while Customize is on', () => {
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b'])} />)
    expect(host.querySelector('[aria-label="Hide A from the sidebar"]')).toBeNull()
    customizing = true
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b'])} />)
    expect(host.querySelector('[aria-label="Hide A from the sidebar"]')).not.toBeNull()
  })

  it('names the row in every control, so the keyboard reaches a specific one', () => {
    customizing = true
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b'])} />)
    const hide = host.querySelector('[aria-label="Hide B from the sidebar"]') as HTMLButtonElement
    act(() => hide.click())
    expect(hideRow).toHaveBeenCalledWith('b', 'B')
  })

  it('disables the move controls at the ends rather than doing nothing silently', () => {
    customizing = true
    render(<SidebarOrderedGroup scope="nav" items={items(['a', 'b', 'c'])} />)
    expect((host.querySelector('[aria-label="Move A up"]') as HTMLButtonElement).disabled).toBe(
      true
    )
    expect((host.querySelector('[aria-label="Move C down"]') as HTMLButtonElement).disabled).toBe(
      true
    )
    const down = host.querySelector('[aria-label="Move A down"]') as HTMLButtonElement
    expect(down.disabled).toBe(false)
    act(() => down.click())
    expect(setOrder).toHaveBeenCalledWith('nav', ['b', 'a', 'c'])
  })
})

describe('where a drop lands on an expanded row', () => {
  it('reads the pointer against the row header, not the expanded children', async () => {
    // A company expanded to show its departments is a tall row. Measuring the
    // whole element would put the midpoint far below the header, so a drop just
    // under the name would read as "before" when the person meant "after".
    const tall: OrderedSidebarItem[] = [
      {
        id: 'a',
        label: 'A',
        node: (
          <div>
            <button type="button">a</button>
            <div style={{ height: 400 }}>children</div>
          </div>
        )
      },
      { id: 'b', label: 'B', node: <button type="button">b</button> }
    ]
    render(<SidebarOrderedGroup scope="nav" items={tall} />)
    const row = host.querySelector('[data-sidebar-row="a"]') as HTMLElement
    const header = row.querySelector('[data-sidebar-row-header]') as HTMLElement
    // The header is short; the whole row is tall.
    header.getBoundingClientRect = () => ({ top: 0, height: 24 }) as DOMRect
    row.getBoundingClientRect = () => ({ top: 0, height: 424 }) as DOMRect
    await pickUp('b')
    fire(row, 'dragover', 20)
    // 20px is past the header's midpoint of 12, so this is "after".
    expect(row.getAttribute('data-drop')).toBe('after')
    fire(row, 'drop', 20)
    expect(setOrder).toHaveBeenCalledWith('nav', ['a', 'b'])
  })
})

describe('a hidden group cannot take its children with it', () => {
  it('still draws a group the person hid while a child needs them', () => {
    // This is the Companies case: each company and department carries its own reveal,
    // but hiding the GROUP would remove the whole tree, so a company needing a person
    // would vanish behind a preference. The group needs a reveal of its own.
    layout = withHidden(EMPTY_SIDEBAR_LAYOUT, 'nav:companies', 'Companies')
    render(
      <SidebarOrderedGroup
        scope="nav"
        rowDrag={false}
        items={[
          { id: 'nav:work', label: 'Work', node: <button type="button">work</button> },
          {
            id: 'nav:companies',
            label: 'Companies',
            reveal: true,
            node: <button type="button">companies</button>
          }
        ]}
      />
    )
    expect(rows()).toEqual(['nav:work', 'nav:companies'])
  })

  it('honours the hide once nothing inside needs them', () => {
    layout = withHidden(EMPTY_SIDEBAR_LAYOUT, 'nav:companies', 'Companies')
    render(
      <SidebarOrderedGroup
        scope="nav"
        rowDrag={false}
        items={[
          { id: 'nav:work', label: 'Work', node: <button type="button">work</button> },
          {
            id: 'nav:companies',
            label: 'Companies',
            reveal: false,
            node: <button type="button">companies</button>
          }
        ]}
      />
    )
    expect(rows()).toEqual(['nav:work'])
  })
})
