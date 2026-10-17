import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionSidebarGroupIcon } from './SessionSidebarGroupIcon'

describe('SessionSidebarGroupIcon', () => {
  it('renders the stopped group created by a failed fleet run', () => {
    const markup = renderToStaticMarkup(<SessionSidebarGroupIcon kind="stopped" />)

    expect(markup).toContain('lucide-circle-stop')
  })
})
