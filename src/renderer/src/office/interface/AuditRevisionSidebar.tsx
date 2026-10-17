import { translate } from '@/i18n/i18n'
import type { TaskRevision } from '../integration/store/coreStore'
import { USER_COLOR } from '../theme/brand'
import { InfoBubble } from './components/InfoBubble'

type AuditRevisionSidebarProps = {
  revisions: TaskRevision[]
  isViewMode: boolean
  selectedRevisionIndex: number | null
  setSelectedRevisionIndex: (index: number | null) => void
}

export function AuditRevisionSidebar({
  revisions,
  isViewMode,
  selectedRevisionIndex,
  setSelectedRevisionIndex
}: AuditRevisionSidebarProps) {
  if (revisions.length === 0) {
    return null
  }

  return (
    <div className="w-56 shrink-0 flex flex-col pt-4 animate-in fade-in slide-in-from-right-4 duration-700">
      <div className="flex items-center gap-2 mb-6" style={{ color: USER_COLOR }}>
        <div
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ backgroundColor: USER_COLOR }}
        />
        <span className="text-[10px] font-black uppercase tracking-widest">
          {translate('office.panels.auditModal.versionHistory', 'Version History')}
        </span>
        <InfoBubble
          text={translate(
            'office.panels.auditModal.versionHistoryHelp',
            'View previous iterations of this task. You can see how the work evolved or revert to a stronger version.'
          )}
        />
      </div>
      <div className="space-y-2 overflow-y-auto scrollbar-sleek pr-2 max-h-[60vh]">
        {revisions.map((rev, idx) => (
          <button
            key={idx}
            onClick={() => setSelectedRevisionIndex(idx)}
            className={`
              w-full text-left p-2.5 rounded-xl transition-all border group/rev
              ${
                selectedRevisionIndex === idx
                  ? 'bg-darkDelegation border-darkDelegation text-white shadow-xl'
                  : 'bg-white border-zinc-100 text-darkDelegation hover:border-zinc-300 hover:bg-zinc-50'
              }
            `}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                {translate('office.panels.auditModal.versionLabel', 'Version {{version}}', {
                  version: idx + 1
                })}
              </span>
              <span className="text-[9px] font-bold opacity-50 uppercase">
                {new Date(rev.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </div>
            {rev.feedback && (
              <p
                className={`text-[12px] leading-tight line-clamp-2 italic ${selectedRevisionIndex === idx ? 'text-zinc-300' : 'text-zinc-500'}`}
              >
                {translate('office.panels.auditModal.quotedFeedback', '"{{feedback}}"', {
                  feedback: rev.feedback
                })}
              </p>
            )}
          </button>
        ))}
        {/* Current one indicator */}
        {!isViewMode && (
          <button
            onClick={() => setSelectedRevisionIndex(null)}
            className={`
              w-full text-left p-3 rounded-xl transition-all border mt-2 flex flex-col gap-1
              ${
                selectedRevisionIndex === null
                  ? 'bg-emerald-50 border-emerald-100'
                  : 'bg-white border-zinc-100 hover:border-emerald-200'
              }
            `}
          >
            <span className="text-[12px] font-black uppercase tracking-widest text-emerald-600">
              {translate('office.panels.auditModal.activeReview', 'Active Review')}
            </span>
            <p className="text-[12px] text-emerald-400 font-medium leading-none">
              {translate('office.panels.auditModal.inReview', 'In review process...')}
            </p>
          </button>
        )}
      </div>
    </div>
  )
}
