// PS-1 · Squad: who's on, the hype meter and trophy highlights, the together card,
// ranks, and the Chat Board (sheet on mobile, panel on desktop).
import { useMemo, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import type { UseQueryResult } from '@tanstack/react-query'
import { displayName, useHype, useSquad, HYPE_MS, SQUAD_MS, type Hype, type HypeLevel, type Member, type SquadResponse, type Platform, type RankMode } from '../../lib/api'
import { ErrorStrip, SkeletonRows, SlowLoad, StaleMarker, useStale } from '../../components/states'
import { SEND_LABEL, slowLabel } from '../../lib/send'
import { usePsnControl } from '../chat/usePsnControl'
import { ChatBoard } from '../chat/ChatBoard'
import { useTitle } from '../../app/title'
import { HelpLink } from '../../components/HelpLink'

export function SquadPage() {
  useTitle('Squad')
  const squad = useSquad()
  const hype = useHype()
  const squadStale = useStale(squad, SQUAD_MS)
  const members = squad.data?.squad
  const together = useMemo(() => (members ? findTogether(members) : null), [members])

  return (
    <>
      <div className="page">
        <SquadHeader squad={squad} stale={squadStale.stale} hasTogether={together !== null} />
        <div className="strip">
          <HypeCard q={hype} />
          <StatsCard squad={squad} />
        </div>
        {together && <TogetherCard {...together} />}
        <div className="lists">
          <div className="lists-inner">
            <PresenceCard q={squad} stale={squadStale} />
            <RanksCard q={squad} />
            <SquadNumbersCard q={squad} />
          </div>
        </div>
      </div>
      <ChatBoard />
    </>
  )
}

// ── Header: h1, live count (G-05) and Squad Up (F-2) ─────────────────────────
function SquadHeader({ squad, stale, hasTogether }: { squad: UseQueryResult<SquadResponse>; stale: boolean; hasTogether: boolean }) {
  const playing = squad.data?.squad.filter((m) => m.playing).length ?? 0
  const showCount = squad.data !== undefined && !squad.isError && !stale
  return (
    <div className="squad-head">
      <div>
        <h1 className="page-h1" tabIndex={-1}>Squad<HelpLink id="squad" /></h1>
        <div className="live-count-slot">
          {showCount && (
            <p className="live-count" role="status">
              {playing > 0 ? <><b>{playing}</b> in a game right now</> : 'Nobody in a game right now'}
            </p>
          )}
        </div>
      </div>
      {/* One primary CTA per view: when a together card is up, its Rally is the primary. */}
      {!hasTogether && <SquadUpButton />}
    </div>
  )
}

const SQUAD_UP_MSG = "🎮🔥 SQUAD UP! Who's hopping on? 🕹️💥"

function SquadUpButton() {
  const ctl = usePsnControl('squad-up')
  const label = ctl.state === 'idle' ? 'Squad Up' : ctl.state === 'countdown' ? slowLabel(ctl.cooldown) : SEND_LABEL[ctl.state]
  return (
    <button
      type="button"
      className="btn btn-primary"
      data-send={ctl.state}
      aria-busy={ctl.busy || undefined}
      aria-disabled={(ctl.locked && !ctl.busy) || undefined}
      aria-describedby="squad-up-desc"
      onClick={() => { if (!ctl.locked) void ctl.fire('/v2/squad', { message: SQUAD_UP_MSG, notify: true }, { sentAnnouncement: 'Squad Up sent' }) }}
    >
      {label}
      <span id="squad-up-desc" className="sr-only">Posts to the PSN group: {SQUAD_UP_MSG}</span>
    </button>
  )
}

// ── DS-HY hype meter ─────────────────────────────────────────────────────────
const HYPE_FILL: Record<HypeLevel, string> = {
  dead: 'var(--text-dim)', cold: 'var(--text-dim)', warm: 'var(--neon-gold)',
  hot: 'var(--neon-magenta)', fire: 'var(--neon-lime)', overload: 'var(--neon-lime)',
}
const HYPE_TEXT: Record<HypeLevel, string> = {
  dead: 'var(--text-dim)', cold: 'var(--text-dim)', warm: 'var(--gold-text)',
  hot: 'var(--magenta-text)', fire: 'var(--lime-text)', overload: 'var(--lime-text)',
}
const TICKS = [0, 15, 40, 80, 120, 150]

function HypeCard({ q }: { q: UseQueryResult<Hype> }) {
  const { stale, minutes } = useStale(q, HYPE_MS)
  const h = q.data
  const level: HypeLevel = h && h.level in HYPE_FILL ? h.level : 'cold'
  const count = Math.max(0, Math.round(h?.count ?? 0))
  const frac = Math.min(1, count / 150)
  return (
    <section className="glass hype" aria-labelledby="hype-h">
      {q.isPending ? (
        <>
          <div className="skeleton" style={{ width: 72, height: 42 }} aria-hidden="true" />
          <div className="skeleton" style={{ height: 8 }} aria-hidden="true" />
          <h2 id="hype-h" className="sr-only">Today's hype</h2>
        </>
      ) : !h ? (
        <div style={{ gridColumn: '1 / -1' }}>
          <h2 id="hype-h" className="hype-title" style={{ margin: 0 }}>Today's hype</h2>
          <ErrorStrip text="Hype didn't load" onRetry={() => q.refetch()} />
        </div>
      ) : (
        <>
          <div>
            <div className="hype-num" style={{ color: HYPE_TEXT[level] }}>{count}</div>
            <div className="hype-level">{h.label}</div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="hype-title">
              <h2 id="hype-h" style={{ margin: 0, font: 'inherit' }}>Today's hype</h2>
              {stale ? <StaleMarker minutes={minutes} onRetry={() => q.refetch()} /> : <span className="meta">{count} / 150 max</span>}
            </div>
            <div className="hype-bar" role="img" aria-label={`Hype: ${count} of 150, ${h.label}`}>
              <div className="hype-fill" data-level={level} style={{ ['--hype-fill' as string]: HYPE_FILL[level], width: '100%', transform: `scaleX(${frac})` }} />
            </div>
            <div className="hype-ticks" aria-hidden="true">
              {TICKS.map((t) => <span key={t} className="hype-tick" style={{ left: `${(t / 150) * 100}%` }}>{t}</span>)}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

// ── DS-ST stat tiles ─────────────────────────────────────────────────────────
function favGame(members: Member[]): string | null {
  const counts = new Map<string, number>()
  for (const m of members) {
    const g = m.game || m.recent_game
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let best: string | null = null
  let n = 0
  for (const [g, c] of counts) if (c > n) { best = g; n = c }
  return best
}

function StatsCard({ squad }: { squad: UseQueryResult<SquadResponse> }) {
  const members = squad.data?.squad ?? []
  if (squad.isPending) {
    return <section className="glass stats" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="stat"><div className="skeleton" style={{ height: 38, width: '70%' }} /></div>)}</section>
  }
  if (!squad.data) return null // presence shows the error; no second strip for the same failure
  const withStats = members.filter((m) => m.trophy_level != null || m.has_stats)
  const plats = withStats.length ? members.reduce((a, m) => a + (m.platinum || 0), 0) : null
  const levels = members.map((m) => m.trophy_level).filter((v): v is number => typeof v === 'number')
  const top = levels.length ? Math.max(...levels) : null
  const fav = favGame(members)
  const favShort = fav && fav.length > 12 ? fav.slice(0, 12).trimEnd() + '…' : fav
  return (
    <section className="glass stats" aria-label="Squad trophy highlights">
      <div className="stat">
        <span className="stat-numeral">{plats ?? '—'}</span>
        <span className="stat-label">Platinums</span>
      </div>
      <div className="stat">
        <span className="stat-numeral">{top ?? '—'}</span>
        <span className="stat-label">Top level</span>
      </div>
      {fav && (
        <div className="stat">
          <span className="stat-game" aria-hidden="true">{favShort}</span>
          <span className="sr-only">{fav}</span>
          <span className="stat-label">Fav game</span>
        </div>
      )}
    </section>
  )
}

// ── SQ-01 Playing together + Rally ▶ (F-2) ───────────────────────────────────
type Together = { game: string; icon: string | null; who: string[] }

function findTogether(members: Member[]): Together | null {
  const by = new Map<string, Together>()
  for (const m of members) {
    if (!m.playing || !m.game) continue
    const t = by.get(m.game) ?? { game: m.game, icon: m.game_icon || null, who: [] }
    t.who.push(displayName(m))
    by.set(m.game, t)
  }
  const groups = [...by.values()].filter((t) => t.who.length >= 2).sort((a, b) => b.who.length - a.who.length)
  return groups[0] ?? null
}

function TogetherCard({ game, icon, who }: Together) {
  const ctl = usePsnControl('rally')
  const message = `🎮🔥 Squad's on ${game}! Who else is hopping in? 💥`
  const label = ctl.state === 'idle' ? 'Rally ▶' : ctl.state === 'countdown' ? slowLabel(ctl.cooldown) : SEND_LABEL[ctl.state]
  return (
    <section className="glass together" aria-labelledby="together-h">
      {icon && <img className="together-icon" src={icon} alt="" referrerPolicy="no-referrer" loading="lazy" />}
      <div className="together-main">
        <h2 id="together-h" className="together-title">🔥 {who.length} in {game}</h2>
        <p className="dim" style={{ margin: 0 }}>{who.join(', ')}</p>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        data-send={ctl.state}
        aria-busy={ctl.busy || undefined}
        aria-disabled={(ctl.locked && !ctl.busy) || undefined}
        aria-describedby="rally-desc"
        onClick={() => { if (!ctl.locked) void ctl.fire('/v2/squad', { message, notify: true }, { sentAnnouncement: 'Rally sent' }) }}
      >
        {label}
      </button>
      <span id="rally-desc" className="sr-only">Posts to the PSN group: {message}</span>
    </section>
  )
}

// ── Platform badge (top-left of the avatar; the presence dot keeps bottom-right) ─
const PLATFORM_LABEL: Record<Platform, string> = { psn: 'PlayStation', steam: 'Steam' }

function PlatformBadge({ p }: { p: Platform }) {
  return (
    <span className="platform-badge" data-platform={p} title={PLATFORM_LABEL[p]}>
      {p === 'steam' ? (
        // Tabler "brand-steam" (MIT), 24 grid.
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M16.5 5a4.5 4.5 0 1 1 -.653 8.953l-4.347 3.009l0 .038a3 3 0 0 1 -2.824 3l-.176 0a3 3 0 0 1 -2.94 -2.402l-2.56 -1.098v-3.5l3.51 1.755a2.989 2.989 0 0 1 2.834 -.635l2.727 -3.818a4.5 4.5 0 0 1 4.429 -5.302z" />
          <circle cx="16.5" cy="9.5" r="1" fill="currentColor" />
        </svg>
      ) : <span aria-hidden="true">PS</span>}
      <span className="sr-only">{PLATFORM_LABEL[p]}</span>
    </span>
  )
}

/** One line of cross-platform numbers under the status. */
function statsLine(m: Member): string | null {
  const st = m.stats
  if (!st) return null
  const bits: string[] = []
  if (st.hours_2weeks) bits.push(`${st.hours_2weeks} h last 2 wks`)
  if (st.hours_total) bits.push(`${st.hours_total.toLocaleString()} h played`)
  if (st.games) bits.push(`${st.games} games`)
  if (st.steam_top_pct) bits.push(`top ${st.steam_top_pct}% on Steam`)
  if (st.steam_games_private) bits.push('Steam games private')
  return bits.length ? bits.join(' · ') : null
}

// ── SQ-04 Who's on ───────────────────────────────────────────────────────────
function statusOf(m: Member): { state: 'playing' | 'online' | 'offline'; text: string } {
  if (m.playing && m.game) return { state: 'playing', text: `On ${m.game}` }
  if (m.online) return { state: 'online', text: 'Online' }
  const last = m.recent_game || m.game
  return { state: 'offline', text: last ? `Last: ${last}` : 'Offline' }
}
const rank = (m: Member) => (m.playing ? 0 : m.online ? 1 : 2)

function PresenceCard({ q, stale }: { q: UseQueryResult<SquadResponse>; stale: { stale: boolean; minutes: number } }) {
  const members = q.data?.squad
  const sorted = useMemo(() => (members ? members.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m) : []), [members])
  return (
    <section className="glass" aria-labelledby="whos-on-h" aria-busy={q.isPending || undefined}>
      <div className="card-head">
        <h2 id="whos-on-h" className="section-h2">Who's on</h2>
        {stale.stale && <StaleMarker minutes={stale.minutes} onRetry={() => q.refetch()} />}
      </div>
      {q.isPending ? (
        <>
          <SkeletonRows n={7} />
          <SlowLoad onRetry={() => q.refetch()} />
        </>
      ) : !q.data ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <ErrorStrip text="PSN isn't answering" onRetry={() => q.refetch()} />
        </div>
      ) : sorted.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nobody linked yet</p>
          <p className="dim" style={{ margin: 0 }}>Link your PlayStation account to show up here.</p>
          <a className="btn btn-secondary" href="/portal">Link your account</a>
        </div>
      ) : (
        <ul className="rows">
          {sorted.map((m, i) => {
            const s = statusOf(m)
            const icon = m.game_icon || m.recent_game_icon
            const mm = m.mm_username
            const line = statsLine(m)
            return (
              <li key={`${m.online_id ?? m.name ?? ''}-${i}`} className="presence-row" data-offline={s.state === 'offline' || undefined}>
                <span className="av-wrap">
                  {m.avatar ? <img className="av" src={m.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" /> : <span className="av" />}
                  <span className="presence-dot" data-offline={s.state === 'offline' || undefined} aria-hidden="true" />
                  <PlatformBadge p={m.platform_source ?? 'psn'} />
                </span>
                <div className="who">
                  <div className="who-name">
                    <span className="n">{displayName(m)}</span>
                    {mm && <span className="who-mm">@{mm}</span>}
                  </div>
                  <div className="who-status" data-state={s.state}>{s.text}</div>
                  {line && <div className="meta steam-line">{line}</div>}
                </div>
                {icon && <img className="game-icon" src={icon} alt="" referrerPolicy="no-referrer" loading="lazy" />}
                {m.primary === 'steam' && m.steam?.level != null ? (
                  <span className="row-side"><span className="row-platform">Steam · </span>Lv <b>{m.steam.level}</b></span>
                ) : m.trophy_level != null ? (
                  <span className="row-side">
                    <span className="row-platform">{m.platform ? `${m.platform} · ` : ''}</span>Lv <b>{m.trophy_level}</b>
                  </span>
                ) : m.steam?.level != null && (
                  <span className="row-side"><span className="row-platform">Steam · </span>Lv <b>{m.steam.level}</b></span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── SQ-05 Ranks: one board per mode, computed server-side (squad_view.ranks) ─
const RANK_TABS: { id: RankMode; label: string }[] = [
  { id: 'overall', label: 'Overall' }, { id: 'hours', label: 'Hours' }, { id: 'recent', label: '2 weeks' },
  { id: 'games', label: 'Games' }, { id: 'trophies', label: 'Trophies' }, { id: 'steam', label: 'Steam' },
]
const RANK_HELP: Record<RankMode, string> = {
  overall: "Hours, last 2 weeks and games, each scaled to the squad's best, averaged. PSN and Steam count the same.",
  hours: 'Lifetime hours: PSN playtime plus Steam playtime.',
  recent: "Hours in the last 2 weeks: Steam's count plus the PSN sessions we saw.",
  games: 'PSN games played plus Steam games owned.',
  trophies: 'PSN trophy level.',
  steam: 'Steam level, and where that puts you among every Steam account.',
}
const RANK_KEY = 'crcmz_app_rank_mode'

function fmtRank(v: number, unit: string): string {
  if (unit === 'h') return `${v.toLocaleString()} h`
  if (unit === 'level') return `Lv ${v}`
  if (unit === 'games') return `${v}`
  return `${v}`
}

function RanksCard({ q }: { q: UseQueryResult<SquadResponse> }) {
  const [mode, setMode] = useState<RankMode>(() => {
    try { const v = localStorage.getItem(RANK_KEY); if (RANK_TABS.some((t) => t.id === v)) return v as RankMode } catch { /* private mode */ }
    return 'overall'
  })
  const ranks = q.data?.ranks
  if (!q.data) return null // loading and error are carried by Who's on
  const board = ranks?.[mode]
  const entries = board?.entries ?? []
  const max = entries[0]?.value || 1
  function pick(m: string) {
    setMode(m as RankMode)
    try { localStorage.setItem(RANK_KEY, m) } catch { /* private mode */ }
  }
  return (
    <section className="glass" aria-labelledby="ranks-h">
      <div className="card-head"><h2 id="ranks-h" className="section-h2">Ranks</h2></div>
      <Tabs.Root value={mode} onValueChange={pick}>
        <Tabs.List className="tabstrip rank-tabs" aria-label="Rank by">
          {RANK_TABS.map((t) => <Tabs.Trigger key={t.id} value={t.id} className="tabstrip-tab">{t.label}</Tabs.Trigger>)}
        </Tabs.List>
        <p className="meta rank-help">{RANK_HELP[mode]}</p>
        {RANK_TABS.map((t) => (
          <Tabs.Content key={t.id} value={t.id}>
            {t.id !== mode ? null : entries.length === 0 ? (
              <div className="empty"><p className="dim" style={{ margin: 0 }}>Nobody has numbers for this yet.</p></div>
            ) : (
              <ol className="rows">
                {entries.map((e, i) => (
                  <li key={`${e.name}-${i}`} className="rank-row">
                    <span className="rank-pos" data-top={i < 3 || undefined}>#{i + 1}</span>
                    <span className="av-wrap" style={{ width: 36, height: 36 }}>
                      {e.avatar ? <img className="av" src={e.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" /> : <span className="av" />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="who-name">
                        <span className="n">{e.name}</span>
                        <span className="rank-value">{fmtRank(e.value, board!.unit)}</span>
                      </div>
                      {e.detail && <div className="rank-line">{e.detail}</div>}
                      <div className="rank-bar" aria-hidden="true"><i style={{ width: `${Math.round((e.value / max) * 100)}%` }} /></div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </section>
  )
}

// ── Squad numbers: squad-wide facts across both platforms ────────────────────
function SquadNumbersCard({ q }: { q: UseQueryResult<SquadResponse> }) {
  const s = q.data?.summary
  if (!s) return null
  const tiles: { label: string; value: string; sub?: string; icon?: string | null }[] = []
  if (s.hours_total) tiles.push({ label: 'Squad hours, all time', value: s.hours_total.toLocaleString() })
  if (s.hours_2weeks) tiles.push({ label: 'Squad hours, last 2 weeks', value: s.hours_2weeks.toLocaleString() })
  if (s.most_played) tiles.push({ label: 'Most played', value: s.most_played.name, sub: `${(s.most_played.hours ?? 0).toLocaleString()} h across ${s.most_played.players} ${s.most_played.players === 1 ? 'player' : 'players'}`, icon: s.most_played.icon })
  if (s.most_shared) tiles.push({ label: 'Most of you play', value: s.most_shared.name, sub: `${s.most_shared.players} of ${s.members} have played it`, icon: s.most_shared.icon })
  if (s.grinder) tiles.push({ label: 'Grinder of the fortnight', value: s.grinder.name, sub: `${s.grinder.hours} h in 2 weeks` })
  if (tiles.length === 0) return null
  return (
    <section className="glass" aria-labelledby="numbers-h">
      <div className="card-head"><h2 id="numbers-h" className="section-h2">Squad numbers</h2></div>
      <ul className="numbers">
        {tiles.map((t) => (
          <li key={t.label} className="number-tile">
            {t.icon && <img className="game-icon" src={t.icon} alt="" referrerPolicy="no-referrer" loading="lazy" />}
            <div style={{ minWidth: 0 }}>
              <div className="number-value">{t.value}</div>
              <div className="stat-label">{t.label}</div>
              {t.sub && <div className="meta">{t.sub}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
