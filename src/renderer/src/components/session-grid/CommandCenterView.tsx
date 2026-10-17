import { lazy, Suspense } from 'react'
import { useAppStore } from '@/store'
import { isSessionGridView } from '@/lib/command-center-navigation'

const AttentionPage = lazy(() => import('../attention/AttentionPage'))
const SessionGridPage = lazy(() => import('./SessionGridPage'))

/** Both persisted view ids keep their original surface until the setting is on. */
export default function CommandCenterView({
  view = 'attention'
}: {
  view?: 'attention' | 'grid'
}): React.JSX.Element {
  const commandCenter = useAppStore((state) => state.settings?.commandCenter)
  return (
    <Suspense fallback={null}>
      {isSessionGridView(view, commandCenter) ? <SessionGridPage /> : <AttentionPage />}
    </Suspense>
  )
}
