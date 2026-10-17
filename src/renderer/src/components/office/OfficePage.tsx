import { Suspense, lazy } from 'react'

import { translate } from '@/i18n/i18n'


// Why lazy: the office pulls in three.js, a navmesh pathfinder and a flow editor.
// Nobody pays for that bundle until they open the page.
const OfficeApp = lazy(() => import('@/office/App'))

/**
 * The 3D fleet office as a first-class view.
 *
 * It used to be a URL opened in an embedded browser tab, which meant it could
 * only ever see what the backoffice served it. Rendered here it is inside this
 * app's React tree, so it reads the same live worktree state everything else on
 * screen does.
 */
export function OfficePage(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {translate('auto.components.office.OfficePage.loading', 'Loading the office…')}
          </div>
        }
      >
        <OfficeApp />
      </Suspense>
    </div>
  )
}

export default OfficePage
