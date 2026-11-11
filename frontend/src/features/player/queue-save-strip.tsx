import { CloudOff } from 'lucide-react'

import { cx } from '../../lib/cx'
import { usePlayer } from './player'

/**
 * A failed queue save (the player also shows it as a toast), at the head of Up next, in the room's
 * dock and on the Now Playing page alike. It follows `queueTrouble`, not the notice, which the next
 * song replaces while saves still fail. While a Retry is out the button waits and says so.
 */
export function QueueSaveStrip({ className }: { className?: string }) {
  const player = usePlayer()
  if (!player.queueTrouble) return null
  const failed = player.queueTrouble === 'failed'
  return (
    <div
      data-ui="queue-save-strip"
      className={cx(
        'flex items-center gap-[8px] rounded-[10px] bg-warn-bg py-[6px] pr-[6px] pl-[10px] text-small text-warn',
        className,
      )}
    >
      <CloudOff aria-hidden="true" size={14} className="shrink-0" />
      <span className="flex-1 text-text">
        {failed ? 'Queue not saved to server' : 'Another browser saved the queue'}
      </span>
      <button
        type="button"
        disabled={failed && player.queueSaving}
        className="h-[28px] shrink-0 rounded-[6px] border-0 bg-warn/15 px-[8px] text-small font-medium text-warn disabled:opacity-60 coarse:min-h-11"
        onClick={failed ? player.retryQueueSave : () => location.reload()}
      >
        {failed ? (player.queueSaving ? 'Saving…' : 'Retry') : 'Reload'}
      </button>
    </div>
  )
}
