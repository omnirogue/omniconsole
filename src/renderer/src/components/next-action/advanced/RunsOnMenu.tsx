import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { translate as t } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { RunsOnDispatch } from './RunsOnDispatch'

export function RunsOnMenu({ session, label }: { session: SidebarSession; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={t('nextAction.runsOn', 'Runs on')}>
          {label} ▾
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-h-96 overflow-y-auto scrollbar-sleek" align="start">
        {open && <RunsOnDispatch session={session} onSent={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  )
}
