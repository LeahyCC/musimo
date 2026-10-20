import { useEffect } from 'react'

import { ListenerGate } from '../features/listener/sheet'
import { useLayout } from '../lib/layout'
import { ClassicShell } from './shell/classic'
import { RoomShell } from './shell/room'

/**
 * Picks the layout from Settings › Yours. `data-layout` on <html> is what switches the fonts in
 * style.css; `public/theme-boot.js` sets it before the first frame and this keeps it current.
 */
export function Shell() {
  const layout = useLayout()

  useEffect(() => {
    document.documentElement.dataset.layout = layout
  }, [layout])

  return <ListenerGate>{layout === 'room' ? <RoomShell /> : <ClassicShell />}</ListenerGate>
}
