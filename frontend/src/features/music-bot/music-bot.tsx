import { useEffect, useRef } from 'react'

import { useNavigate, useSearch } from '@tanstack/react-router'

import { PageTitle } from '../../components/page-title'
import { useLayout } from '../../lib/layout'
import { usePhone } from '../../lib/use-phone'
import { useBotChat } from './bot-chat'
import { ClassicBotPage, PhoneBotPage, RoomBotPage } from './bot-page'
import { ChatPanel } from './chat-panel'
import { usePetLook } from './use-pet'

/**
 * The full-page chat: where the sidebar's Octive entry and the phone's top bar link go. It is
 * the same conversation as the pet's popover, so a chat carries between them. Classic draws one
 * column; the Listening room puts the result in a Draft panel beside it.
 */
export function MusicBotPage() {
  const chat = useBotChat()
  const phone = usePhone()
  const layout = useLayout()
  const pixel = usePetLook().pixel
  const { setOpen } = chat

  // Reading the page counts as reading any reply, so the pet's dot clears here too.
  useEffect(() => {
    setOpen(true)
    return () => setOpen(false)
  }, [setOpen])

  useOpeningPrompt()

  // The Windows 95 skin keeps its own window-style chat; the two layouts are for the other skins.
  if (pixel)
    return (
      <>
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

  const Page = layout === 'room' ? RoomBotPage : ClassicBotPage
  return (
    <>
      <h1 className="sr-only">Music bot</h1>
      {phone ? (
        <PhoneBotPage autoFocus={false} look={layout === 'room' ? 'room' : 'page'} />
      ) : (
        <Page autoFocus />
      )}
    </>
  )
}

/**
 * Home's Octive chips link here with `?prompt=`. Once the model is ready the prompt is sent, once,
 * and the parameter is dropped so a reload or Back does not ask again.
 */
function useOpeningPrompt() {
  const chat = useBotChat()
  const navigate = useNavigate()
  const { prompt } = useSearch({ from: '/music-bot' })
  const sent = useRef<string | null>(null)
  const ready = Boolean(chat.settings.data && chat.model && !chat.locked)

  useEffect(() => {
    if (!prompt || !ready || sent.current === prompt) return
    sent.current = prompt
    void navigate({ to: '/music-bot', search: {}, replace: true })
    void chat.send(prompt)
  }, [prompt, ready, chat, navigate])
}
