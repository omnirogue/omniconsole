import { useEffect, useState } from 'react'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { supportsSidebarGroups } from '../../../../shared/sidebar-custom-groups'

export function useSidebarGroupsSupport(): boolean {
  const [supported, setSupported] = useState(() => supportsSidebarGroups(isPairedWebClientWindow()))
  useEffect(() => {
    if (!isPairedWebClientWindow()) {
      return
    }
    let disposed = false
    void window.api.runtime
      .getStatus()
      .then((status) => {
        if (!disposed) {
          setSupported(supportsSidebarGroups(true, status.capabilities))
        }
      })
      .catch(() => {
        /* The creation control stays unavailable until the host answers. */
      })
    return () => {
      disposed = true
    }
  }, [])
  return supported
}
