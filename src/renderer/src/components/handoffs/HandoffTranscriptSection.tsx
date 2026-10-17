import { translate } from '@/i18n/i18n'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { HandoffFiles } from './HandoffFiles'
import { HandoffSessionButton } from './HandoffSessionButton'

export function HandoffTranscriptSection({
  detail,
  file,
  canStart = false,
  onDownload
}: {
  detail: HandoffDetail
  canStart?: boolean
  file: HandoffDetail['files'][number]
  onDownload: (file: HandoffDetail['files'][number]) => Promise<void>
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold text-muted-foreground">
        {translate('handoffs.sessionTranscript6a016', 'Session transcript')}
      </h2>
      <HandoffFiles threadId={detail.thread.id} files={[file]} onDownload={onDownload} />
      {canStart && <HandoffSessionButton detail={detail} mode="continue" />}
    </section>
  )
}
