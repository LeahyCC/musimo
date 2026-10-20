import { useEffect, useLayoutEffect } from 'react'

import { ListenerGate } from '../features/listener/sheet'
import { useLayout } from '../lib/layout'
import { ClassicShell } from './shell/classic'
import { usePhoneStage } from './shell/phone-stage'
import { RoomShell } from './shell/room'

/**
 * Picks the layout from Settings › Yours. `data-layout` on <html> is what switches the fonts in
 * style.css; `public/theme-boot.js` sets it before the first frame and this keeps it current.
 * `data-stage` marks a phone's full screen Now Playing, so the bar heights read as nothing there.
 */
export function Shell() {
  const layout = useLayout()
  const stage = usePhoneStage()

  useEffect(() => {
    document.documentElement.dataset.layout = layout
  }, [layout])

  // Before paint, so the bars and the heights style.css reads from it change in the same frame.
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-stage', stage)
  }, [stage])

  return <ListenerGate>{layout === 'room' ? <RoomShell /> : <ClassicShell />}</ListenerGate>
}
