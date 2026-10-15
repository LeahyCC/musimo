import { useEffect } from 'react'

import { PageTitle } from '../../components/page-title'
import { usePhone } from '../../lib/use-phone'
import { useBotChat } from './bot-chat'
import { ChatPanel } from './chat-panel'

/**
 * The full-page chat: where the sidebar's Music bot entry and the phone's top bar link go. It is
 * the same conversation as the pet's popover, so a chat carries between them.
 */
export function MusicBotPage() {
  const chat = useBotChat()
  const phone = usePhone()
  const { setOpen } = chat

  // Reading the page counts as reading any reply, so the pet's dot clears here too.
  useEffect(() => {
    setOpen(true)
    return () => setOpen(false)
  }, [setOpen])

  return (
    <>
      {/* A phone gives the whole screen to the chat, whose header names it; the page keeps its
          heading for screen readers. */}
      {phone ? (
        <h1 className="sr-only">Music bot</h1>
      ) : (
        <PageTitle title="Music bot" eyebrow="YOUR LIBRARY, IN YOUR WORDS" />
      )}
      <section
        data-bot-page
        data-ui="panel"
        aria-label={`Chat with ${chat.name}`}
        className="mx-auto bg-raised h-[calc(100dvh-var(--topbar-height)-var(--player-height)-var(--nav-height)-var(--safe-bottom)-260px)] min-h-[520px] max-w-[760px] overflow-hidden rounded-[16px] border border-line-strong max-phone:-mx-[20px] max-phone:-mt-[24px] max-phone:h-[calc(100dvh-var(--topbar-height)-var(--safe-top)-var(--player-height)-var(--nav-height)-var(--safe-bottom))] max-phone:min-h-[420px] max-phone:rounded-none max-phone:border-x-0 max-phone:border-t-0"
      >
        <ChatPanel layout="page" autoFocus={!phone} />
      </section>
    </>
  )
}
