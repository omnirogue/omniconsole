import { AlertCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'

type OutputReviewResetConfirmationProps = {
  onConfirm: () => void
  onCancel: () => void
}

export function OutputReviewResetConfirmation({
  onConfirm,
  onCancel
}: OutputReviewResetConfirmationProps) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-darkDelegation/40 backdrop-blur-md p-4 cursor-default"
      onClick={(e) => {
        e.stopPropagation()
        onCancel()
      }}
    >
      <div
        className="bg-white border border-black/10 rounded-[24px] w-96 p-8 shadow-2xl flex flex-col items-center text-center gap-6 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center text-red-500">
          <AlertCircle size={32} />
        </div>
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-darkDelegation">
            {translate(
              'office.panels.outputReviewModal.resetConfirmationTitle',
              'Are you absolutely sure?'
            )}
          </h3>
          <p className="text-xs text-zinc-400 mt-2 leading-relaxed">
            {translate(
              'office.panels.outputReviewModal.resetConfirmationDescription',
              'All progress will be lost and the project will be reset to its initial state. This action cannot be undone.'
            )}
          </p>
        </div>
        <div className="flex flex-col w-full gap-2 mt-2">
          <button
            onClick={onConfirm}
            className="w-full py-4 bg-red-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-[0.15em] hover:bg-red-600 active:scale-[0.98] transition-all"
          >
            {translate('office.panels.outputReviewModal.confirmReset', 'Yes, Reset Project')}
          </button>
          <button
            onClick={() => onCancel()}
            className="w-full py-4 bg-zinc-100 text-zinc-500 rounded-2xl text-[10px] font-black uppercase tracking-[0.15em] hover:bg-zinc-200 active:scale-[0.98] transition-all"
          >
            {translate('office.panels.outputReviewModal.cancelReset', 'No, Go Back')}
          </button>
        </div>
      </div>
    </div>
  )
}
