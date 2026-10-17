import { translate } from '@/i18n/i18n'
import { FileSearch } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { LLMMessage } from '../core/llm/types'
import type { AgenticSystem, AgentNode } from '../data/agents'
import type { Task } from '../integration/store/coreStore'
import { USER_COLOR, USER_COLOR_LIGHT, USER_COLOR_SOFT } from '../theme/brand'
import { Avatar } from './components/Avatar'

type ChatMessagesProps = {
  chatMessages: LLMMessage[]
  agent: AgentNode
  activeTeam: AgenticSystem
  tasks: Task[]
  setActiveAuditTaskId: (taskId: string | null) => void
}

export function ChatMessages({
  chatMessages,
  agent,
  activeTeam,
  tasks,
  setActiveAuditTaskId
}: ChatMessagesProps) {
  return (
    <>
      {chatMessages
        .filter((msg) => !msg.metadata?.internal)
        .map((msg, i) => (
          <div
            key={i}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`flex items-start gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'} max-w-[90%]`}
            >
              {/* Avatar / Icon */}
              <div className="shrink-0 mt-1">
                {msg.role === 'assistant' ? (
                  <Avatar
                    type={agent?.index === activeTeam.leadAgent.index ? 'lead' : 'sub'}
                    color={agent?.color}
                    size={32}
                  />
                ) : (
                  <Avatar type="user" color={USER_COLOR} size={32} />
                )}
              </div>

              <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={`px-4 py-2.5 rounded-[20px] text-[14px] leading-relaxed shadow-sm border ${
                    msg.role === 'user' ? 'rounded-tr-none' : 'rounded-tl-none'
                  }`}
                  style={
                    msg.role === 'user'
                      ? {
                          backgroundColor: USER_COLOR_LIGHT,
                          borderColor: USER_COLOR_SOFT,
                          color: '#27272a' // text-darkDelegation
                        }
                      : {
                          backgroundColor: '#1a2233', // dark assistant bubble
                          borderColor: '#2b3a55',
                          color: '#e7edf5'
                        }
                  }
                >
                  {msg.role === 'assistant' ? (
                    <div className="markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>

                      {msg.metadata?.reviewTaskId && (
                        <div className="mt-4 p-4 bg-white/50 rounded-2xl border border-zinc-200/50 flex flex-wrap items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
                          <div className="flex items-center gap-2 pr-2">
                            <div
                              className="p-2 rounded-xl flex-shrink-0"
                              style={{ backgroundColor: USER_COLOR_LIGHT, color: USER_COLOR }}
                            >
                              <FileSearch size={18} />
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-zinc-600">
                              {tasks.find((t) => t.id === msg.metadata?.reviewTaskId)?.status ===
                              'on_hold'
                                ? translate(
                                    'office.panels.chatPanel.reviewRequested',
                                    'Review Requested'
                                  )
                                : translate(
                                    'office.panels.chatPanel.reviewProcessed',
                                    'Review Processed'
                                  )}
                            </span>
                          </div>

                          {tasks.find((t) => t.id === msg.metadata?.reviewTaskId)?.status ===
                            'on_hold' && (
                            <button
                              onClick={() => {
                                const reviewTaskId = msg.metadata?.reviewTaskId
                                if (reviewTaskId) {
                                  setActiveAuditTaskId(reviewTaskId)
                                }
                              }}
                              className="flex-1 min-w-[120px] px-4 py-2 bg-darkDelegation text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-black active:scale-95 transition-all shadow-sm whitespace-nowrap"
                            >
                              {translate('office.panels.chatPanel.reviewTask', 'Review Task')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  )}
                </div>

                <div className="flex items-center gap-2 mt-2 px-1">
                  <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">
                    {msg.role === 'user'
                      ? translate('office.panels.chatPanel.you', 'You')
                      : agent?.name?.split(' ')[0] || translate('office.panels.chatPanel.ai', 'AI')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
    </>
  )
}
