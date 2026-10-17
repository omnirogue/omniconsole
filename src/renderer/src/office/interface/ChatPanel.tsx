// @ts-nocheck
import { translate } from '@/i18n/i18n'
import { Send } from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getAllAgents } from '../data/agents'
import { USER_COLOR, USER_COLOR_LIGHT } from '../theme/brand'
import { useCoreStore } from '../integration/store/coreStore'
import { useActiveTeam } from '../integration/store/teamStore'
import { useUiStore } from '../integration/store/uiStore'
import { useSceneManager } from '../simulation/SceneContext'
import { ChatMessages } from './ChatMessages'

const ChatPanel: React.FC = () => {
  const { isChatting, isThinking, selectedNpcIndex, setIsTyping, setActiveAuditTaskId } =
    useUiStore()
  const scene = useSceneManager()
  const activeTeam = useActiveTeam()
  const agents = getAllAgents(activeTeam)

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [typingActivity, setTypingActivity] = useState(0)

  const agent =
    selectedNpcIndex !== null ? (agents.find((a) => a.index === selectedNpcIndex) ?? null) : null

  // Combine store messages with project histories if needed,
  // but unified useCoreStore is the source of truth for history.
  const coreStore = useCoreStore()
  const chatMessages = useMemo(
    () => (selectedNpcIndex !== null ? coreStore.agentHistories[selectedNpcIndex] || [] : []),
    [coreStore.agentHistories, selectedNpcIndex]
  )

  useEffect(() => {
    if (typingActivity === 0) {
      return
    }
    const timer = setTimeout(() => setIsTyping(false), 1000)
    return () => clearTimeout(timer)
  }, [typingActivity, setIsTyping])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [chatMessages, isThinking, isChatting])

  useEffect(() => {
    const viewport = scrollRef.current
    if (!isChatting || !viewport) {
      return
    }
    const timer = setTimeout(() => {
      viewport.scrollTop = viewport.scrollHeight
    }, 100)
    return () => clearTimeout(timer)
  }, [isChatting])

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const pastedText = e.clipboardData.getData('text')
    setInput(pastedText)
  }

  const handleSend = async () => {
    if (!input.trim() || isThinking) {
      return
    }
    setTypingActivity(0)
    setIsTyping(false)

    const text = input
    setInput('')
    await scene?.sendMessage(text)
  }

  if (!isChatting || !agent) {
    return null
  }

  return (
    <div className="flex flex-col h-full bg-white relative overflow-hidden shrink-0 pointer-events-auto">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-sleek p-1 space-y-6">
        <ChatMessages
          chatMessages={chatMessages}
          agent={agent}
          activeTeam={activeTeam}
          tasks={coreStore.tasks}
          setActiveAuditTaskId={setActiveAuditTaskId}
        />

        {isThinking && (
          <div className="flex items-start gap-3">
            <div className="w-4 h-4 text-zinc-300 animate-pulse mt-1">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L14.85 9.15L22 12L14.85 14.85L12 22L9.15 14.85L2 12L9.15 9.15L12 2Z" />
              </svg>
            </div>
            <div className="bg-zinc-50 px-4 py-3 rounded-2xl rounded-tl-none">
              <div className="flex gap-1">
                <div
                  className="w-1.5 h-1.5 bg-zinc-300 rounded-full animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <div
                  className="w-1.5 h-1.5 bg-zinc-300 rounded-full animate-bounce"
                  style={{ animationDelay: '150ms' }}
                />
                <div
                  className="w-1.5 h-1.5 bg-zinc-300 rounded-full animate-bounce"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-2 border-t border-zinc-50">
        <div className="relative flex items-center gap-2">
          <div className="flex-1 relative">
            <textarea
              value={input}
              onChange={(e) => {
                const val = e.target.value
                setInput(val)

                // Show player talking animation while typing
                if (val.length > 0) {
                  setIsTyping(true)
                  setTypingActivity((activity) => activity + 1)
                } else {
                  setTypingActivity(0)
                  setIsTyping(false)
                }
              }}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={translate(
                'office.panels.chatPanel.messagePlaceholder',
                'Message (↵ to send)'
              )}
              className="w-full bg-white border border-zinc-200 rounded-2xl px-3 py-3 text-sm focus:outline-none focus:ring-2 transition-all resize-none pr-12 [scrollbar-width:none]"
              style={{
                borderColor: input.trim() ? USER_COLOR : undefined,
                boxShadow: input.trim() ? `0 0 0 2px ${USER_COLOR_LIGHT}` : undefined
              }}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim() || isThinking}
            style={{ backgroundColor: !input.trim() || isThinking ? undefined : agent.color }}
            className={`h-11 w-11 shrink-0 rounded-2xl flex items-center justify-center font-black text-xs uppercase tracking-widest transition-all active:scale-95 ${
              !input.trim() || isThinking
                ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
                : 'text-white shadow-lg hover:brightness-90'
            }`}
          >
            <Send size={16} strokeWidth={3} />
          </button>
        </div>
        <p className="text-[8px] text-zinc-400 mt-2 text-center font-medium uppercase tracking-wider">
          {translate('office.panels.chatPanel.newLineShortcut', 'Shift + ↵ for new line')}
        </p>
      </div>
    </div>
  )
}

export default ChatPanel
