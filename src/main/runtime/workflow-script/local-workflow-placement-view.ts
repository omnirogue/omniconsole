import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'

/**
 * Where the run was placed and who asked for it, as frozen at admission. The host's denied
 * paths stay with the launch; the view names the host, the reading and the run's folder there.
 */
export function localWorkflowPlacementView(
  host: Pick<
    LocalWorkflowHostSnapshot['host'],
    'placement' | 'requestedBy' | 'requestedById' | 'request'
  >
): Pick<LocalWorkflowView, 'placement' | 'requestedBy' | 'requestedById' | 'request'> {
  const placement = host.placement
  const dispatch = placement?.dispatch
  return {
    ...(placement
      ? {
          placement: {
            ...placement,
            ...(dispatch
              ? {
                  dispatch: {
                    root: dispatch.root,
                    home: dispatch.home,
                    hidden: [],
                    ...(dispatch.workspace ? { workspace: dispatch.workspace } : {})
                  }
                }
              : {})
          }
        }
      : {}),
    ...(host.requestedBy ? { requestedBy: host.requestedBy } : {}),
    ...(host.requestedById ? { requestedById: host.requestedById } : {}),
    ...(host.request ? { request: host.request } : {})
  }
}
