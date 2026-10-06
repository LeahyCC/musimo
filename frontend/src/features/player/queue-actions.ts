/** The two things any song, album or playlist row can do with the queue. */
export const queueActions = (playNext: () => void, addToQueue: () => void) => [
  { label: 'Play next', onSelect: playNext },
  { label: 'Add to queue', onSelect: addToQueue },
]
