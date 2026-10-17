import { translate } from '@/i18n/i18n'
import { Check, Copy } from 'lucide-react'
import React, { useState } from 'react'

export const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className={`p-1 rounded transition-all cursor-pointer ${copied ? 'text-emerald-500' : 'text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100'}`}
      title={translate('office.panels.logCopyButton.copyToClipboard', 'Copy to clipboard')}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  )
}
