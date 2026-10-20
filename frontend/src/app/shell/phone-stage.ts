import { useNowPlayingTakesOver } from '../../features/player/player'
import { usePhone } from '../../lib/use-phone'

/**
 * Whether a phone is showing Now Playing as a screen of its own (`nowPlayingTakesOver` under the
 * phone breakpoint). Both layouts then take their top bar and tab bar away and the page closes with
 * its own button, the way a phone's music app opens its player. `shell.tsx` mirrors this as
 * `data-stage` on <html>, and style.css does the rest from there: it hides every element marked
 * `data-stage-hide`, zeroes the bar heights and pads the page for the notch and home indicator.
 */
export function usePhoneStage() {
  const phone = usePhone()
  const takesOver = useNowPlayingTakesOver()
  return phone && takesOver
}
