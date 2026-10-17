import { useState } from 'react'
import { companyIdentity } from '../../../../shared/company-identity'
import { cn } from '@/lib/utils'
import acme from '../../../../../resources/logos/omnirogue.png'
import omnirogue from '../../../../../resources/logos/omnirogue.png'
import apexlabs from '../../../../../resources/logos/omnirogue.png'
import betacorp from '../../../../../resources/logos/omnirogue.png'
import omniagentos from '../../../../../resources/logos/omniagentos-monogram.svg'
import personal from '../../../../../resources/logos/personal-monogram.svg'
import hardwaredirect from '../../../../../resources/logos/omniagentos-monogram.svg'
import greenwell from '../../../../../resources/logos/omniagentos-monogram.svg'

const ASSETS: Record<string, string> = {
  'acme.png': acme,
  'omnirogue.png': omnirogue,
  'apexlabs.png': apexlabs,
  'betacorp.png': betacorp,
  'omniagentos-monogram.svg': omniagentos,
  'personal-monogram.svg': personal,
  'hardwaredirect-monogram.svg': hardwaredirect,
  'greenwell-monogram.svg': greenwell
}

/**
 * A company's real mark, or its initials on the brand hue — the console's own
 * CompanyMark, so the two apps show one company the same way. Never a broken image.
 */
export function CompanyMark({
  company,
  name,
  className,
  decorative = false
}: {
  company: string
  name?: string | null
  className?: string
  decorative?: boolean
}): React.JSX.Element {
  const identity = companyIdentity(company, name)
  const src = identity.asset ? ASSETS[identity.asset] : undefined
  const [broken, setBroken] = useState(false)
  if (!src || broken) {
    return (
      <span
        aria-hidden
        data-company-mark="initials"
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white',
          className
        )}
        style={{ backgroundColor: identity.color }}
      >
        {identity.initials}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={decorative ? '' : identity.name}
      aria-hidden={decorative || undefined}
      data-company-mark={identity.kind}
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn('size-6 shrink-0 rounded-md object-contain', className)}
    />
  )
}
