import type { LibraryTrack, MusicResult } from '../../api'

/** Shown when the account is signed in but the account-file command is empty and this file does not already play. */
export const COMMAND_REQUIRED = 'The account file command is required.'
/** A free account that is not allowed a full file. */
export const FREE_ACCOUNT = 'This Deezer account cannot play a full song.'
/** A country block or a song the account cannot play. A clip does not replace it. */
export const UNAVAILABLE = 'This song is not available on the Deezer account.'
export const BUSY = 'The Deezer account is busy.'
export const ACCOUNT_SOURCE = 'Deezer account'
export const LIBRARY_SOURCE = 'Library'
export const PREVIEW_SOURCE = 'Preview'

export type DeezerListen = {
  ready: boolean
  detail: string
  command: boolean
  cached: number[]
  unavailable: number[]
}

export type CatalogPress = 'play' | 'preview' | 'cancel' | 'none'

export type CatalogAction = {
  label: string
  title?: string
  disabled: boolean
  press: CatalogPress
}

type Row = {
  id: number
  spotify_id?: string
  preview: string
  ownership?: string
  matched_song?: string
}

/** A Spotify row is not a Deezer track. Account Play does not apply to it. */
export function isDeezerTrack(item: Row) {
  return !item.spotify_id && item.id > 0
}

/** Play is offered only for a usable account, and only when a full file can actually be played. */
export function canAccountPlay(item: Row, listen: DeezerListen | undefined) {
  if (!listen?.ready || !isDeezerTrack(item)) return false
  if (listen.unavailable.includes(item.id)) return false
  if (item.ownership === 'owned' && item.matched_song) return true
  return listen.command || listen.cached.includes(item.id)
}

export function catalogAction(input: {
  item: Row
  playingPreview: boolean
  playingAccount: boolean
  fetching: boolean
  previewState?: 'finding' | 'none' | 'ready'
  listen?: DeezerListen
}): CatalogAction {
  const { item, listen } = input
  if (input.fetching && isDeezerTrack(item))
    return { label: 'Fetching…', title: 'Cancel', disabled: false, press: 'cancel' }
  if (input.playingAccount) return { label: 'Pause', disabled: false, press: 'play' }
  if (input.playingPreview) return { label: 'Pause', disabled: false, press: 'preview' }
  if (!isDeezerTrack(item)) return previewAction(item, input.previewState)
  if (listen?.unavailable.includes(item.id))
    return { label: 'Unavailable', title: UNAVAILABLE, disabled: true, press: 'none' }
  if (canAccountPlay(item, listen)) return { label: 'Play', disabled: false, press: 'play' }
  const hint = rowHint(item, listen)
  const preview = previewAction(item, input.previewState)
  return hint ? { ...preview, title: hint } : preview
}

function rowHint(item: Row, listen: DeezerListen | undefined) {
  if (!listen) return ''
  if (!listen.ready) return listen.detail
  if (!listen.command && !listen.cached.includes(item.id)) return COMMAND_REQUIRED
  return ''
}

function previewAction(item: Row, state?: 'finding' | 'none' | 'ready'): CatalogAction {
  if (state === 'none')
    return { label: 'No preview', title: 'No preview available', disabled: true, press: 'none' }
  if (item.preview) return { label: 'Preview', disabled: false, press: 'preview' }
  return { label: 'Find preview', disabled: false, press: 'preview' }
}

/** The queue entry for a Deezer song. An owned song keeps the library id and plays from disk. */
export function toQueueTrack(item: MusicResult): LibraryTrack {
  const art = item.art.startsWith('https://') ? item.art : ''
  if (item.ownership === 'owned' && item.matched_song)
    return {
      id: item.matched_song,
      title: item.title,
      artist: item.artist,
      album: item.album,
      duration: item.duration,
      coverArt: art,
      playCount: 0,
      origin: 'library',
    }
  return {
    id: `dz-${item.id}`,
    title: item.title,
    artist: item.artist,
    album: item.album,
    duration: item.duration,
    coverArt: art,
    playCount: 0,
    origin: 'deezer',
    deezerId: item.id,
  }
}

/** What Now Playing names. Spotify stays a preview; it is not account audio. */
export function sourceName(library: LibraryTrack | null, preview: { spotify_id?: string } | null) {
  if (library?.origin === 'deezer') return ACCOUNT_SOURCE
  if (library) return LIBRARY_SOURCE
  if (preview?.spotify_id) return 'Spotify preview'
  if (preview) return PREVIEW_SOURCE
  return ''
}

/** Stop an account stream when the sign-in is no longer usable. */
export function accountStreamStopped(origin: string | undefined, ready: boolean | undefined) {
  return origin === 'deezer' && ready === false
}
