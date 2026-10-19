import type React from 'react'
import { ExternalLink, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import ArtifactsPage from '../artifacts/ArtifactsPage'
import { openWorkDecisions } from '@/lib/open-work-decisions'
import { WorkSectionTitle } from './WorkSectionTitle'

export function WorkArtifactsSection(): React.JSX.Element {
  const openArtifactsPage = useAppStore((s) => s.openArtifactsPage)

  return (
    <section>
      <WorkSectionTitle
        title={translate('auto.components.work.WorkArtifactsSection.title', 'Artifacts')}
        sub={translate(
          'auto.components.work.WorkArtifactsSection.subtitle',
          'Shared pages, decisions, and reviews'
        )}
        action={
          <div className="flex items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={() => openWorkDecisions()}>
              <ExternalLink className="size-3.5" />
              {translate('auto.components.work.WorkArtifactsSection.decisions', 'Decisions')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => openArtifactsPage()}>
              <Maximize2 className="size-3.5" />
              {translate(
                'auto.components.work.WorkArtifactsSection.openFullView',
                'Open full view'
              )}
            </Button>
          </div>
        }
      />
      <div className="flex h-[520px] min-h-[360px] flex-col overflow-hidden rounded-lg border bg-card">
        <ArtifactsPage embedded />
      </div>
    </section>
  )
}
