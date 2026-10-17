import { useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useRightPanelPicture } from './right-panel-picture-store'
import { shrinkPictureToDataUrl } from './shrink-picture'

/**
 * The right panel's Picture view: a picture the person chose, shown when they pick it as the
 * panel's resting view. A conversation's own page still takes over while it is on screen.
 */
export function RightPanelPicture(): React.JSX.Element {
  const picture = useRightPanelPicture((state) => state.picture)
  const setPicture = useRightPanelPicture((state) => state.setPicture)
  const clearPicture = useRightPanelPicture((state) => state.clearPicture)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const choose = async (file: File | undefined): Promise<void> => {
    if (!file) {
      return
    }
    setBusy(true)
    try {
      const dataUrl = await shrinkPictureToDataUrl(file)
      if (!setPicture(dataUrl)) {
        toast.error(
          translate(
            'rightPanelPicture.saveFailed',
            'This device could not keep the picture. Try a smaller one.'
          )
        )
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('rightPanelPicture.readFailed', 'This picture could not be read.')
      )
    } finally {
      setBusy(false)
    }
  }

  const chooseButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 bg-background/80 text-xs backdrop-blur"
      disabled={busy}
      onClick={() => inputRef.current?.click()}
    >
      <ImagePlus className="size-3.5" />
      {picture
        ? translate('rightPanelPicture.change', 'Change picture')
        : translate('rightPanelPicture.choose', 'Choose picture')}
    </Button>
  )

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-right-panel-picture=""
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Why reset: picking the same file again must still fire a change.
          event.target.value = ''
          void choose(file)
        }}
      />
      {picture ? (
        <>
          <img src={picture} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute right-2 top-2 flex items-center gap-1">
            {chooseButton}
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="bg-background/80 backdrop-blur"
              aria-label={translate('rightPanelPicture.remove', 'Remove picture')}
              title={translate('rightPanelPicture.remove', 'Remove picture')}
              onClick={clearPicture}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-xs text-muted-foreground">
            {translate(
              'rightPanelPicture.empty',
              'Choose a picture to show here while no conversation page is on screen. It stays on this device.'
            )}
          </p>
          {chooseButton}
        </div>
      )}
    </div>
  )
}
