// Help: one plain page, a section per menu item. Every page title's ⓘ links to its
// section here (/help#<id>), so the answer is one tap from where the question is.
import { useEffect, type ReactNode } from 'react'
import { Link, useLocation, useOutletContext } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon, type IconName } from '../../components/Icon'

const MM_URL = 'https://mm.qureshi.io'
const JF_URL = 'https://jelly.qureshi.io'
const MCP_CONFIG = '{"mcpServers":{"crcmz":{"type":"http","url":"https://app.crcmz.me/mcp"}}}'

type Section = { id: string; title: string; icon: IconName; open?: string; adminOnly?: boolean; body: ReactNode }

const SECTIONS: Section[] = [
  {
    id: 'start', title: 'Getting started', icon: 'user',
    body: (
      <>
        <p>One CRCMZ account opens everything: this app, Mattermost and the Jellyfin music server. Use the email and password from your invite.</p>
        <ol>
          <li>Sign in to the app.</li>
          <li>Go to <Link to="/portal">Link PSN</Link> so you show up on Squad and your clips are credited to you.</li>
          <li>Add a passkey in <Link to="/settings/passkeys">Settings → Passkeys</Link> to sign in with Face ID or a fingerprint next time.</li>
        </ol>
        <p>On a phone, each section you open slides up from the bottom. To go back to where you were, pull the bar at the top of the page down, or tap it.</p>
      </>
    ),
  },
  {
    id: 'squad', title: 'Squad', icon: 'squad', open: '/',
    body: (
      <>
        <p>Who is online, who is in a game, today's hype meter and trophies.</p>
        <ul>
          <li><b>Chat Board:</b> tap a tile to post it in <b>The Squad</b> group on PSN.</li>
          <li><b>Message the squad:</b> type and send. It goes out from your PSN account (or from crcmz-mod until you link PSN).</li>
        </ul>
      </>
    ),
  },
  {
    id: 'clips', title: 'Clips', icon: 'clips', open: '/clips',
    body: (
      <>
        <p><b>Share a clip to the "The Squad" group on PSN and add ONE of these in the message:</b></p>
        <Table head={['Add', 'What happens']} rows={[
          ['nothing', 'Sent to the WhatsApp group (CRCMZ BOYZ).'],
          ['🔥', 'Fire reel: posted to Instagram @crcmzclan. Not sent to WhatsApp.'],
          ['😂 or fail', 'Fail reel: sent to WhatsApp, posted to Instagram once 2 people react to it there.'],
          ['rev', 'The AI Coach grades it. Not sent to WhatsApp.'],
        ]} />
        <ul>
          <li><b>Timing:</b> on the PS5, type the emoji first, then share the clip. In the PS App, share the clip, then type the emoji. Send it within 5 seconds (a follow-up text works up to 5 minutes later).</li>
          <li><b>Veto:</b> react 🛑 to a clip in WhatsApp and it is never used in a reel or the montage.</li>
          <li>Clips 60 seconds or shorter go into the daily highlights on their own.</li>
          <li><b>Edit:</b> open a reel in Clips to trim, crop, zoom, add text or subtitles, then <b>Save &amp; approve</b>.</li>
          <li><b>Send a video:</b> upload an MP4 or MOV (3 seconds to 10 minutes). It is posted to Instagram, TikTok and YouTube, credited to you.</li>
          <li><b>Montage:</b> the month's best clips are cut into a montage on the 1st at 6 AM PT. Clips are deleted 14 days after it posts.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'slap', title: 'Slap (music)', icon: 'slap', open: '/slap',
    body: (
      <>
        <p>The squad's music library. It runs on a Jellyfin server.</p>
        <ul>
          <li><b>In this app:</b> open Slap and press play. Your music account is set up for you.</li>
          <li><b>Discover:</b> Slap opens here. You get the AI mix of the week (from the library), what was just added, and what the squad is playing this week.</li>
          <li><b>New finds:</b> AI picks that are not in the library yet. <b>Listen</b> plays a 30-second preview. <b>Download</b> adds the song to the library and to your picks playlist, with you as the person who added it. Finds nobody downloads are gone after Sunday.</li>
          <li><b>Listen Together:</b> on the Together tab, tap <b>Start a room</b> or <b>Join them</b>. Everyone hears the same song; anyone can add, skip or pause.</li>
          <li><b>Stats:</b> rankings, charts and who listens to what.</li>
          <li><b>In the player:</b> it shows who added the song. Thumbs up or down and emoji reactions show who pressed them, and stay pressed on every device. Reactions also appear in the comments.</li>
          <li><b>Wrong song?</b> In the player, tap <b>⋯</b> then <b>Wrong song? Find the right one</b>. Pick the right upload, or paste a YouTube link, and it is swapped in for everyone.</li>
        </ul>
        <p><b>Jellyfin app or browser:</b></p>
        <ol>
          <li>Server URL: <Copyable text={JF_URL} /></li>
          <li>Tap <b>Sign in with CRCMZ</b>. Do not type a username or password.</li>
          <li>Sign in with your CRCMZ email and password.</li>
        </ol>
      </>
    ),
  },
  {
    id: 'whatsapp', title: 'WhatsApp', icon: 'chat', open: '/whatsapp',
    body: (
      <>
        <p>Stats for the CRCMZ BOYZ group: awards, top words and emoji, busiest hours. Founders can also switch to Professional Goopers.</p>
        <p><b>Talk to the bot in the WhatsApp group:</b></p>
        <Table head={['Type', 'What happens']} rows={[
          ['ai <question>', 'The bot answers. @mentioning it or replying to its message works too.'],
          ['catch me up', 'A summary of what you missed. Also: summarize, what did i miss, tldr.'],
          ['ask claw <question>', 'Asks Clawbot instead.'],
          ['reset claw', 'Starts Clawbot fresh.'],
          ['build me a site that …', 'The engineer builds a website and sends you a progress link.'],
          ['a photo, no caption', 'The bot says what is in it.'],
          ['🛑 reaction on a clip', 'Vetoes the clip.'],
        ]} />
        <p><b>In The Squad group on PSN:</b> type <code>ai &lt;question&gt;</code>. The answer comes within about 20 seconds.</p>
      </>
    ),
  },
  {
    id: 'giveaway', title: 'Giveaway', icon: 'giveaway', open: '/giveaway',
    body: (
      <ul>
        <li>Shows this round's prize, the countdown to the draw and the winner.</li>
        <li>Everyone wins once before anyone wins twice. The page tells you if you are still eligible.</li>
      </ul>
    ),
  },
  {
    id: 'watch', title: 'Watch', icon: 'watch', open: '/watch',
    body: (
      <ul>
        <li><b>Movies</b> is the first thing Watch shows: today's featured film, then rows of posters. <b>Continue watching</b> and <b>In our library</b> are ours; Trending, New, Highest rated and the genres are everything else. Tap a genre to turn every row into it, or <b>See all</b> for the whole list.</li>
        <li>Search finds any movie. Tap a poster for its details, cast and trailer.</li>
        <li><b>Add to library</b> brings a movie in: we pick the best copy (4K when there is one, else 1080p) and keep it on our server. Everyone gets a notification when it's added and when it's ready. Five a day each. Whoever added a movie (or an admin) can remove it with the bin.</li>
        <li><b>Watch together</b> on a movie we have starts the party with it, or switches the party to it (it asks first if everyone is watching something else).</li>
        <li>The banner at the top shows when a party is on: tap <b>Join</b>. With nothing on, <b>Start</b> opens the party and <b>Paste a link</b> takes a YouTube link or a video link. Everyone sees it at the same time.</li>
        <li>In the party, tap the camera button in the player to join with camera + mic. Tap it again to turn your camera off; the red phone leaves the call.</li>
        <li><b>Ring everyone</b> under the player rings the squad's phones into the party (the Android app rings like a phone call). Once a minute.</li>
        <li>Tap 😀 in the player to react. Three of the same in a row sets off a party.</li>
        <li>Tap ⚙ in the player for camera position, flip camera, mic and speaker, your display name, and <b>Rally</b> (tells the WhatsApp group to join).</li>
        <li>In fullscreen, the cameras sit on the video and the chat button lets you type without leaving.</li>
        <li>It keeps playing while you use the rest of the app.</li>
        <li>Under the player, <b>Library</b> has our movies and <b>Watched</b>: what this room (or just you) watched, to pick up where you left off.</li>
      </ul>
    ),
  },
  {
    id: 'huddle', title: 'Huddle', icon: 'huddle', open: '/huddle',
    body: (
      <ul>
        <li>A voice and video call. Everyone in the same room name is in the same call (the default is <code>crcmz</code>).</li>
        <li>Share your screen, blur your background, turn on the transcript, or get AI meeting notes.</li>
        <li>Starting a call in an empty room rings everyone. In a call, <b>Ring</b> rings them again: the Android app rings like a phone call, everyone else gets a notification. Once a minute.</li>
      </ul>
    ),
  },
  {
    id: 'coach', title: 'AI Coach', icon: 'coach', open: '/coach',
    body: (
      <ul>
        <li>Share a clip to The Squad on PSN with <code>rev</code> in the message. The coach grades it.</li>
        <li>Pick where the report goes: the WhatsApp group, a direct message, or nowhere.</li>
        <li>Rate each report 👍 or 👎 so it gets better.</li>
      </ul>
    ),
  },
  {
    id: 'ask', title: 'Ask AI', icon: 'ask', open: '/ask',
    body: (
      <ul>
        <li>Ask anything about the squad: who is online, who yaps the most, music taste, busiest hours.</li>
        <li>It only reads. It never posts or changes anything.</li>
        <li><b>Squad facts:</b> add facts you want the AI to know about people.</li>
      </ul>
    ),
  },
  {
    id: 'notifications', title: 'Notifications', icon: 'bell', open: '/notifications',
    body: (
      <>
        <p>The bell at the top shows everything the app told you about: Squad Up rallies, Watch Parties, Huddles, giveaways, new clips, @mentions and new movies.</p>
        <ul>
          <li><b>@mentions:</b> type <b>@</b> and a name in a Slap comment. They get it here, as a push on their phone, and as a WhatsApp and Mattermost DM.</li>
          <li><b>Tap one</b> to go straight to it. <b>Mark all read</b> clears the count.</li>
          <li><b>Phone pop-ups:</b> turn them on in <Link to="/settings/app">Settings → App</Link>. Turn the DMs off on the Notifications page.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'mattermost', title: 'Mattermost', icon: 'chat',
    body: (
      <>
        <p>The squad's own chat server, like Discord or Slack.</p>
        <ol>
          <li>Open <Copyable text={MM_URL} /> in a browser, or put it in as the server URL in the Mattermost app.</li>
          <li>Tap <b>Login with Authentik</b>.</li>
          <li>Tap the <b>black icon under the blue button</b>.</li>
          <li>Sign in with your CRCMZ email and password.</li>
        </ol>
        <p>To let the AI post in Mattermost for you, connect it in <Link to="/settings/mattermost">Settings → Mattermost</Link>.</p>
      </>
    ),
  },
  {
    id: 'portal', title: 'Link PSN', icon: 'link', open: '/portal',
    body: (
      <>
        <ol>
          <li>Sign in at <a href="https://www.playstation.com" target="_blank" rel="noreferrer">playstation.com</a>.</li>
          <li>Open the token page the Link PSN screen gives you and copy the code.</li>
          <li>Paste it on the Link PSN screen and tap link.</li>
        </ol>
        <p>The code works like your PSN password: never share it. You need to link again about every 60 days.</p>
      </>
    ),
  },
  {
    id: 'settings', title: 'Settings', icon: 'settings', open: '/settings',
    body: (
      <ul>
        <li><b>Passkeys / Password:</b> how you sign in.</li>
        <li><b>PSN:</b> your linked PlayStation account.</li>
        <li><b>Mattermost:</b> connect so the AI can post for you.</li>
        <li><b>MCP:</b> use the squad's data in Claude (see below).</li>
        <li><b>Watch:</b> where the camera bubbles sit on this device.</li>
        <li><b>App → Tab bar:</b> pick the three pages on the bar at the bottom of your phone. Ask AI stays in the middle.</li>
      </ul>
    ),
  },
  {
    id: 'mcp', title: 'Claude / MCP', icon: 'ask',
    body: (
      <ol>
        <li>Add this to your MCP client (Claude Desktop: <code>claude_desktop_config.json</code>): <Copyable text={MCP_CONFIG} /></li>
        <li>Restart the client. A browser opens.</li>
        <li>Sign in with your CRCMZ account and tap <b>Allow</b>.</li>
        <li>Turn it off any time in <Link to="/settings/mcp">Settings → MCP</Link>.</li>
      </ol>
    ),
  },
  {
    id: 'admin', title: 'Admin', icon: 'admin', open: '/admin', adminOnly: true,
    body: <p>Admins only: users, invites, PSN accounts, the clip queue and service health.</p>,
  },
]

export function HelpPage() {
  useTitle('Help')
  const { hash } = useLocation()
  const { isAdmin } = useOutletContext<{ isAdmin: boolean }>()
  const sections = SECTIONS.filter((s) => !s.adminOnly || isAdmin)

  // Arriving from a page ⓘ: go to that section (the Shell leaves the scroll alone when there is a hash).
  useEffect(() => {
    const el = hash ? document.getElementById(`help-${hash.slice(1)}`) : null
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    el.focus({ preventScroll: true })
  }, [hash])

  return (
    <div className="page page-reading help">
      <h1 className="page-h1" tabIndex={-1}>Help</h1>
      <p className="help-intro">Pick a topic. Every page also has an <Icon name="info" className="nav-icon help-inline-icon" /> next to its title that opens its part of this page.</p>
      <nav className="help-jump" aria-label="Help sections">
        {sections.map((s) => <Link key={s.id} className="chip" to={`#${s.id}`}>{s.title}</Link>)}
      </nav>
      {sections.map((s) => (
        <section key={s.id} id={`help-${s.id}`} className="glass help-card" tabIndex={-1} aria-labelledby={`help-${s.id}-h`}>
          <div className="card-head">
            <h2 className="section-h2 help-h" id={`help-${s.id}-h`}><Icon name={s.icon} />{s.title}</h2>
            {s.open && <Link className="btn btn-secondary" to={s.open}>Open</Link>}
          </div>
          <div className="help-body">{s.body}</div>
        </section>
      ))}
    </div>
  )
}

/** What to type or add, and what happens: one row each, stacked on a phone. */
function Table({ head, rows }: { head: [string, string]; rows: [string, string][] }) {
  return (
    <ul className="help-keys" aria-label={`${head[0]} and ${head[1].toLowerCase()}`}>
      {rows.map(([a, b]) => (
        <li key={a}>
          <span>{a === 'nothing' ? <b>Nothing</b> : <code>{a}</code>}</span>
          <span>{b}</span>
        </li>
      ))}
    </ul>
  )
}

function Copyable({ text }: { text: string }) {
  return (
    <span className="help-copy">
      <code>{text}</code>
      <button type="button" className="btn btn-secondary help-copy-btn" aria-label={`Copy ${text}`}
        onClick={(e) => {
          const b = e.currentTarget
          void navigator.clipboard?.writeText(text).then(() => {
            b.textContent = 'Copied'
            setTimeout(() => { b.textContent = 'Copy' }, 1500)
          })
        }}>Copy</button>
    </span>
  )
}
