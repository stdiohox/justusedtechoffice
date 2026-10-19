import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button, Textarea } from '@/components/ui/primitives'
import { isChatOpen, useChatMessages, useEndChat, useSendMessage, type Knock } from '@/hooks/useKnocks'
import { useNow } from '@/hooks/useNow'
import { officeClock } from '@/lib/office'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/office/OfficeVisuals'
import { TOUCH } from '@/lib/touch'
import { useAuthStore } from '@/stores/authStore'

/**
 * The quick chat a knock opens (0005): two people, text only, closed by
 * either of them or by itself after an hour.
 */
export function ChatPanel({
  knock,
  otherName,
  zone,
  onClose,
}: {
  knock: Knock
  otherName: string
  zone: string
  onClose: () => void
}) {
  const userId = useAuthStore((s) => s.profile?.id)
  const otherId = knock.from_user === userId ? knock.to_user : knock.from_user
  const now = useNow(15_000).getTime()
  const open = isChatOpen(knock, now)
  const { data: messages, isLoading } = useChatMessages(knock.id)
  const send = useSendMessage(knock.id)
  const end = useEndChat()
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const errorId = `chat-err-${knock.id}`

  // Into the conversation as it opens.
  useEffect(() => {
    inputRef.current?.focus()
  }, [knock.id])

  // Keep the newest message in view, unless the reader has scrolled up.
  useEffect(() => {
    const el = listRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [messages?.length])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    setProblem(null)
    send.mutate(draft, {
      onSuccess: () => setDraft(''),
      onError: (err) => setProblem(err instanceof Error ? err.message : 'Not sent.'),
    })
  }

  return (
    <section
      aria-labelledby="chat-h"
      className="hairline knock-in flex h-[520px] flex-col overflow-hidden rounded-[14px] bg-surface-raised shadow-[var(--shadow-md)]"
    >
      <div className="hairline-b flex items-center gap-3 bg-surface-sunken/60 px-4 py-3">
        <Avatar name={otherName} userId={otherId} size="sm" />
        <div className="mr-auto min-w-0">
          <h2 id="chat-h" className="truncate text-[14px] font-medium text-text-primary">
            Chat with {otherName}
          </h2>
          {open ? <p className="text-[12px] text-text-muted">Text only. Ends by itself after an hour.</p> : null}
        </div>
        {open ? (
          <Button variant="secondary" size="sm" className={TOUCH} loading={end.isPending} onClick={() => end.mutate(knock.id)}>
            End chat
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the chat panel"
          className="press flex size-8 items-center justify-center rounded-[8px] text-text-muted hover:bg-hover hover:text-text-primary max-sm:size-11"
        >
          <X size={15} />
        </button>
      </div>

      <div
        ref={listRef}
        role="log"
        aria-label="Messages"
        aria-relevant="additions"
        className="flex-1 space-y-1 overflow-y-auto px-4 py-4"
      >
        {isLoading ? null : !messages?.length ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Avatar name={otherName} userId={otherId} size="lg" />
            <p className="text-[13px] text-text-muted">You are in {otherName.split(' ')[0]}’s office. Say hello.</p>
          </div>
        ) : (
          messages.map((m, i) => {
            const mineMsg = m.sender === userId
            // Consecutive messages from one person sit together; the time
            // shows once, under the last of the run.
            const next = messages[i + 1]
            const lastOfRun = !next || next.sender !== m.sender
            return (
              <div key={m.id} className={cn('row-in flex flex-col', mineMsg ? 'items-end' : 'items-start', lastOfRun && 'pb-2')}>
                <span
                  className={cn(
                    'max-w-[85%] rounded-[14px] px-3 py-2 text-[13px] leading-[1.45] break-words whitespace-pre-wrap',
                    mineMsg ? 'bg-forest text-ivory' : 'bg-surface-sunken text-text-primary',
                    lastOfRun && (mineMsg ? 'rounded-br-[2px]' : 'rounded-bl-[2px]'),
                  )}
                >
                  <span className="sr-only">{mineMsg ? 'You' : otherName}: </span>
                  {m.body}
                </span>
                <span className={cn('tnum mt-1 text-[11px] text-text-muted', !lastOfRun && 'sr-only')}>{officeClock(zone, m.created_at)}</span>
              </div>
            )
          })
        )}
      </div>

      {open ? (
        <form onSubmit={submit} className="hairline-t space-y-2 bg-surface-raised p-3">
          <label htmlFor="chat-input" className="sr-only">
            Message to {otherName}
          </label>
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              id="chat-input"
              rows={2}
              aria-describedby={problem ? errorId : undefined}
              maxLength={1000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a new line.
                // Not mid-composition: an IME's Enter confirms a character.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
              className="min-h-[40px]"
            />
            <Button type="submit" className={TOUCH} loading={send.isPending} disabled={!draft.trim()}>
              Send
            </Button>
          </div>
          {problem ? (
            <p id={errorId} role="alert" className="text-[13px] text-state-danger">
              {problem}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="hairline-t p-3 text-[13px] text-text-muted">This chat has ended.</p>
      )}
    </section>
  )
}
