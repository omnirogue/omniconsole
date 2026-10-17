import { useEffect, useRef } from 'react'
import { Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type StarNagToastProps = {
  id: string | number
}

function StarNagToast({ id }: StarNagToastProps): React.JSX.Element {
  return (
    <div className="relative w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg border border-border bg-popover p-3.5 text-popover-foreground shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-status-success-border bg-status-success-background text-status-success"
              aria-hidden="true"
            >
              <Check className="size-3.5" />
            </span>
            <div className="text-sm font-semibold">
              {translate(
                'auto.components.star.nag.StarNagToastHost.onboardingCompleted',
                'Onboarding completed!'
              )}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => toast.dismiss(id)}
          aria-label={translate('auto.components.star.nag.StarNagToastHost.dismiss', 'Dismiss')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

export function StarNagToastHost(): null {
  const activeToastIdRef = useRef<string | number | null>(null)
  const activeToastResolvedRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const dismissActiveToast = (): void => {
      if (activeToastIdRef.current === null) {
        return
      }
      activeToastResolvedRef.current?.()
      toast.dismiss(activeToastIdRef.current)
    }
    const unsubscribeShow = window.api.starNag.onShow((payload) => {
      if (payload?.surface !== 'toast') {
        return
      }
      dismissActiveToast()
      let resolved = false
      const markResolved = (): void => {
        resolved = true
      }
      activeToastResolvedRef.current = markResolved
      const id = toast.custom((toastId) => <StarNagToast id={toastId} />, {
        duration: Infinity,
        closeButton: false,
        dismissible: false,
        unstyled: true,
        onDismiss: () => {
          if (activeToastIdRef.current === id) {
            activeToastIdRef.current = null
            activeToastResolvedRef.current = null
          }
          if (!resolved) {
            void window.api.starNag.dismiss()
          }
        },
        onAutoClose: () => {
          if (activeToastIdRef.current === id) {
            activeToastIdRef.current = null
            activeToastResolvedRef.current = null
          }
        }
      })
      activeToastIdRef.current = id
    })
    const unsubscribeHide = window.api.starNag.onHide(dismissActiveToast)
    return () => {
      unsubscribeShow()
      unsubscribeHide()
    }
  }, [])

  return null
}
