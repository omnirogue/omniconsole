import React from 'react'
import { Megaphone } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { SidebarNavMemberButton } from './SidebarNavMemberButton'

/**
 * Advertising sits under Work rather than becoming a fifth destination: it is how
 * the companies are doing, read at the account level. Reads only.
 */
export function AdvertisingSidebarEntry(): React.JSX.Element {
  const active = useAppStore((state) => state.activeView === 'advertising')
  const openAdvertisingPage = useAppStore((state) => state.openAdvertisingPage)
  return (
    <SidebarNavMemberButton
      icon={Megaphone}
      label={translate('nav.advertising', 'Advertising')}
      active={active}
      onClick={openAdvertisingPage}
    />
  )
}
