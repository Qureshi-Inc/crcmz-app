// PS-3 · Slap: the squad's music. Discover (the week's mix, charts and new finds),
// Listen (the Jellyfin library), Together (one shared room anyone online can drive)
// and Stats (the Slaptastic dashboard).
import { useOutletContext, useSearchParams } from 'react-router-dom'
import * as Tabs from '@radix-ui/react-tabs'
import type { ShellContext } from '../../app/Shell'
import { useTitle } from '../../app/title'
import { ApiError } from '../../lib/http'
import { slapName, useLibrary, useSlapMe, useTrackComments } from '../../lib/slap'
import { TrackFocus } from './Comments'
import { Discover } from './Discover'
import { Listen } from './Listen'
import { Stats } from './Stats'
import { Together } from './Together'
import { playList, usePlayer } from './player'
import { HelpLink } from '../../components/HelpLink'

type Tab = 'discover' | 'listen' | 'together' | 'stats'
const TABS: Tab[] = ['discover', 'listen', 'together', 'stats']

export function SlapPage() {
  useTitle('Slap')
  const [params, setParams] = useSearchParams()
  const { isAdmin } = useOutletContext<ShellContext>()
  const me = useSlapMe()
  const s = usePlayer()
  // No tab means Discover, unless the link points into the library (older links did).
  const tab = (TABS.find((t) => t === params.get('tab'))
    ?? (['lib', 'open', 'q'].some((k) => params.has(k)) ? 'listen' : 'discover')) as Tab
  // A mention notification opens /app/slap?track=<id>: show that track's thread.
  const trackId = /^[0-9a-z]{1,64}$/i.test(params.get('track') ?? '') ? params.get('track')! : null
  const lib = useLibrary()
  const thread = useTrackComments(trackId)
  const libTrack = trackId ? lib.data?.tracks.find((t) => t.id === trackId) : undefined
  const first = thread.data?.comments[0]
  const focus = trackId ? (libTrack ?? (first ? { id: trackId, title: first.title, artist: first.artist, album: '' } : { id: trackId, title: '', artist: '', album: '' })) : null
  const closeFocus = () => setParams((p) => { const n = new URLSearchParams(p); n.delete('track'); return n }, { replace: true })

  function setTab(t: string) {
    setParams((p) => {
      const n = new URLSearchParams()
      if (t !== 'discover') n.set('tab', t)
      // Library position only means something on Listen.
      if (t === 'listen') for (const k of ['lib', 'open', 'q']) { const v = p.get(k); if (v) n.set(k, v) }
      return n
    }, { replace: true })
  }

  const who = me.data ? slapName(me.data.slap_user) || me.data.name : null
  const unlinked = me.error instanceof ApiError && me.error.status === 409

  return (
    <div className="page">
      <div className="slap-head">
        <div>
          <h1 className="page-h1" tabIndex={-1}>Slap<HelpLink id="slap" /></h1>
          <p className="slap-sub meta" aria-live="polite">
            {who ? <>Listening as <b>{who}</b>{me.data?.created ? ' · your music account was just made' : ''}</>
              : unlinked ? 'Your music account needs an admin' : ' '}
          </p>
        </div>
      </div>
      <TrackFocus track={focus} onClose={closeFocus} onPlay={libTrack ? () => playList([libTrack]) : undefined} />
      <Tabs.Root value={tab} onValueChange={setTab} className="slap-tabs">
        <Tabs.List className="seg seg-4" aria-label="Slap view">
          <Tabs.Trigger value="discover" className="seg-tab">Discover</Tabs.Trigger>
          <Tabs.Trigger value="listen" className="seg-tab">Listen</Tabs.Trigger>
          <Tabs.Trigger value="together" className="seg-tab">
            Together{s.mode === 'together' && s.room ? <span className="seg-n num"> · {s.room.members.length}</span> : null}
          </Tabs.Trigger>
          <Tabs.Trigger value="stats" className="seg-tab">Stats</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="discover"><Discover isAdmin={isAdmin} /></Tabs.Content>
        <Tabs.Content value="listen"><Listen isAdmin={isAdmin} /></Tabs.Content>
        <Tabs.Content value="together"><Together onBrowse={() => setTab('listen')} /></Tabs.Content>
        <Tabs.Content value="stats"><Stats me={me.data?.slap_user ?? null} /></Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
