import { useMemo } from 'react'
import { ImageIcon, Palette, Swords } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { OmniRogueModelArenaModal } from '../omnirogue-arena/OmniRogueModelArenaModal'
import type { OmniRogueModelArenaService } from '../omnirogue-arena/omnirogue-model-arena-helpers'
import { OmniRogueAssetInspector } from '../omnirogue-media/OmniRogueAssetInspector'
import { OmniRogueBrandKitDrawer } from '../omnirogue-media/OmniRogueBrandKitDrawer'
import type { OmniRogueBrandKitService } from '../omnirogue-media/omnirogue-brand-kit-helpers'
import { OmniRogueSpendGuardBanner } from './OmniRogueSpendGuardBanner'
import { sessionSpendGuardLimits, useOmniRogueSessionSpend } from './omnirogue-session-spend-guard'

export type OmniRoguePreviewTool = 'arena' | 'brandKits' | 'assets'

function unavailable(): Promise<never> {
  return Promise.reject(
    new Error(
      translate('omnirogueTools.serviceUnavailable', 'This OmniRogue service is not live yet.')
    )
  )
}

// Why: neither the IDE nor api.omnirogue.com serves these yet; the panels show their load errors.
const ARENA_SERVICE: OmniRogueModelArenaService = {
  quote: unavailable,
  run: unavailable,
  vote: unavailable
}
const BRAND_KIT_SERVICE: OmniRogueBrandKitService = { list: unavailable, save: unavailable }

/** Spend guard and tool entries for the credits popover; shown only with OmniSI previews on. */
export function OmniRoguePreviewToolButtons({
  onOpen
}: {
  onOpen: (tool: OmniRoguePreviewTool) => void
}) {
  const sessions = useOmniRogueSessionSpend()
  const limits = useMemo(() => sessionSpendGuardLimits(sessions), [sessions])
  const tools = [
    {
      id: 'arena' as const,
      icon: Swords,
      label: translate('omnirogueTools.arena', 'Model Arena')
    },
    {
      id: 'brandKits' as const,
      icon: Palette,
      label: translate('omnirogueTools.brandKits', 'Brand Kits')
    },
    {
      id: 'assets' as const,
      icon: ImageIcon,
      label: translate('omnirogueTools.assets', 'Assets')
    }
  ]
  return (
    <div className="space-y-2" data-testid="omnirogue-preview-tools">
      <OmniRogueSpendGuardBanner limits={limits} />
      <div className="grid grid-cols-3 gap-1.5">
        {tools.map(({ id, icon: Icon, label }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-1.5 text-[11px]"
            onClick={() => onOpen(id)}
          >
            <Icon className="size-3" aria-hidden="true" />
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** The panels live outside the popover so closing it does not unmount an open dialog. */
export function OmniRoguePreviewToolPanels({
  tool,
  onClose
}: {
  tool: OmniRoguePreviewTool | null
  onClose: () => void
}) {
  const creditsApi = window.api?.omnirogue?.credits
  const close = (open: boolean) => {
    if (!open) {
      onClose()
    }
  }
  return (
    <>
      <OmniRogueModelArenaModal
        service={ARENA_SERVICE}
        creditsApi={creditsApi}
        open={tool === 'arena'}
        onOpenChange={close}
        showTrigger={false}
      />
      <OmniRogueBrandKitDrawer
        open={tool === 'brandKits'}
        onOpenChange={close}
        contextKey="omnirogue"
        service={BRAND_KIT_SERVICE}
        onApply={onClose}
      />
      <Sheet open={tool === 'assets'} onOpenChange={close}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader className="sr-only">
            <SheetTitle>{translate('omnirogueTools.assets', 'Assets')}</SheetTitle>
          </SheetHeader>
          <OmniRogueAssetInspector asset={null} className="m-4" />
        </SheetContent>
      </Sheet>
    </>
  )
}
