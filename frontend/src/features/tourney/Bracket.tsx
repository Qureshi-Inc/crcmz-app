// The bracket chart: one column per round, every match placed so it sits midway
// between the two it comes from, and thin neon connectors between them.
import { Icon } from '../../components/Icon'
import { roundName, type Entrant, type Match, type Tournament } from '../../lib/tourney'

const W = 232
const H = 84
const GAP = 56
const PITCH = 104
const HEAD = 36

export function Bracket({ t, stage, onPick, title }: {
  t: Tournament; stage: Match['stage']; onPick: (m: Match) => void; title?: string
}) {
  const ents = new Map(t.entrants.map((e) => [e.id, e]))
  const ms = t.matches.filter((m) => m.stage === stage)
  if (!ms.length) return null
  const rounds = [...new Set(ms.map((m) => m.round))].sort((a, b) => a - b)
  const byRound = rounds.map((r) => ms.filter((m) => m.round === r).sort((a, b) => a.slot - b.slot))
  const most = Math.max(...byRound.map((c) => c.length))
  const height = most * PITCH
  const pos = new Map<string, { x: number; y: number }>()
  byRound.forEach((col, ci) => col.forEach((m, i) => {
    pos.set(m.id, { x: ci * (W + GAP), y: HEAD + ((i + 0.5) * height) / col.length - H / 2 })
  }))
  const champPath = championPath(t, ms)
  const width = rounds.length * W + (rounds.length - 1) * GAP

  return (
    <section className="bk" aria-label={title ?? 'Bracket'}>
      {title && <h3 className="bk-title eyebrow">{title}</h3>}
      <div className="bk-scroll">
        <div className="bk-canvas" style={{ width, height: height + HEAD }}>
          <svg className="bk-lines" width={width} height={height + HEAD} aria-hidden="true">
            {ms.map((m) => {
              const a = pos.get(m.id)
              const b = m.next_id ? pos.get(m.next_id) : undefined
              if (!a || !b) return null
              const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, xm = x1 + GAP / 2
              const lit = m.status === 'played' || m.status === 'bye'
              const gold = champPath.has(m.id)
              const color = gold ? 'var(--gold-text)' : lit ? (ents.get(m.winner_id ?? '')?.color ?? 'var(--border-control)') : undefined
              return (
                <path key={m.id} d={`M${x1} ${y1}H${xm}V${y2}H${x2}`}
                  className={`bk-line${lit ? ' lit' : ''}${gold ? ' gold' : ''}`} style={color ? { stroke: color } : undefined} />
              )
            })}
          </svg>
          {rounds.map((rnd, ci) => (
            <div key={rnd} className="bk-head eyebrow" style={{ left: ci * (W + GAP), width: W }}>
              {roundName(stage, rnd, rounds.length)}
            </div>
          ))}
          {ms.map((m) => {
            const p = pos.get(m.id)!
            return (
              <div key={m.id} className="bk-slot" style={{ left: p.x, top: p.y, width: W, height: H }}>
                <MatchCard m={m} ents={ents} t={t} onPick={onPick} gold={champPath.has(m.id) && m.next_id === null} />
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function championPath(t: Tournament, ms: Match[]): Set<string> {
  const out = new Set<string>()
  if (!t.champion_id) return out
  for (const m of ms) if (m.winner_id === t.champion_id && (m.e1 === t.champion_id || m.e2 === t.champion_id)) out.add(m.id)
  return out
}

export function MatchCard({ m, ents, t, onPick, gold = false }: {
  m: Match; ents: Map<string, Entrant>; t: Tournament; onPick: (m: Match) => void; gold?: boolean
}) {
  if (m.status === 'void') return <div className="mc mc-void" aria-hidden="true" />
  const open = m.playable || (m.status === 'played' && t.status !== 'draft')
  const body = (
    <>
      <Side m={m} side={1} ents={ents} />
      <Side m={m} side={2} ents={ents} />
      <span className="mc-meta">
        <span>{m.code}</span>
        {m.status === 'bye' && <span>bye</span>}
        {m.playable && m.series_round != null && (
          <>
            <span className="mc-series num">
              Series {m.series_round}/{t.settings.best_of}
              {' · '}{m.series_maps?.s1 ?? 0}–{m.series_maps?.s2 ?? 0} rds
            </span>
            <SeriesHistory m={m} bo={t.settings.best_of} />
          </>
        )}
        {m.playable && m.series_round == null && t.settings.best_of > 1 && (
          <span className="mc-series num">
            {'Game '}{(m.partial?.length ?? 0) + 1}/{t.settings.best_of}
            {(m.partial?.length ?? 0) > 0 && ` · ${m.partial.filter((g) => g.s1 > g.s2).length}–${m.partial.filter((g) => g.s2 > g.s1).length}`}
          </span>
        )}
        {m.playable && <span className="mc-cta">{m.partial?.length || m.series_round != null ? 'Next round' : 'Report'}</span>}
        {m.status === 'played' && m.games.length > 1 && (
          <>
            <span>{m.games.length}/{t.settings.best_of > 1 ? t.settings.best_of : m.games.length} {t.settings.round_bo > 1 ? 'series' : 'games'}</span>
            {t.settings.round_bo > 1 && <PlayedSeriesHistory games={m.games} />}
          </>
        )}
        {m.source?.startsWith('screenshot') && <span className="mc-src" title="Scored from a screenshot"><Icon name="cam" className="mc-ico" />AI</span>}
      </span>
    </>
  )
  const cls = `mc${m.playable ? ' mc-ready' : ''}${m.status === 'bye' ? ' mc-bye' : ''}${gold ? ' mc-gold' : ''}`
  return open
    ? <button type="button" className={cls} onClick={() => onPick(m)} aria-label={label(m, ents)}>{body}</button>
    : <div className={cls}>{body}</div>
}

function label(m: Match, ents: Map<string, Entrant>) {
  const a = ents.get(m.e1 ?? '')?.name ?? 'TBD', b = ents.get(m.e2 ?? '')?.name ?? 'TBD'
  return m.status === 'played' ? `${a} ${m.score1} ${b} ${m.score2}, edit result` : `Report ${a} versus ${b}`
}

function Side({ m, side, ents }: { m: Match; side: 1 | 2; ents: Map<string, Entrant> }) {
  const e = ents.get((side === 1 ? m.e1 : m.e2) ?? '')
  const wait = side === 1 ? m.wait1 : m.wait2
  const score = side === 1 ? m.score1 : m.score2
  const pens = side === 1 ? m.pens1 : m.pens2
  const won = m.status === 'played' && m.winner_id === e?.id
  const lost = m.status === 'played' && m.winner_id && m.winner_id !== e?.id
  return (
    <span className={`mc-side${won ? ' won' : ''}${lost ? ' lost' : ''}`}>
      <span className="mc-bar" style={{ background: e?.color ?? 'transparent' }} />
      <span className={`mc-name${e ? '' : ' tbd'}`}>{e?.name ?? wait ?? (m.status === 'bye' ? 'Bye' : 'TBD')}</span>
      {m.status === 'played' && (
        <span className="mc-score num">{score}{pens != null && <small> ({pens})</small>}</span>
      )}
      {m.status === 'pending' && e && (m.partial?.length > 0 || m.series_round != null) && (
        <span className="mc-score mc-live num" title="Series won">
          {m.partial?.filter((g) => (side === 1 ? g.s1 > g.s2 : g.s2 > g.s1)).length ?? 0}
        </span>
      )}
    </span>
  )
}

function SeriesHistory({ m, bo }: { m: Match; bo: number }) {
  const done = m.partial ?? []
  const curRounds = m.series_rounds ?? []
  const items = Array.from({ length: bo }, (_, i) => {
    if (i < done.length) {
      const s = done[i]
      const hist = m.series_history?.[i]
      return { state: 'done' as const, winner: (s?.s1 ?? 0) > (s?.s2 ?? 0) ? 1 : 2, rounds: hist?.rounds ?? [] }
    }
    if (i === done.length) return { state: 'live' as const, rounds: curRounds }
    return { state: 'pending' as const, rounds: [] }
  })
  return (
    <span className="mc-sh num">
      {items.map((item, i) => (
        <span key={i} className={`mc-sh-s mc-sh-${item.state}`}>
          <span className="mc-sh-lbl">S{i + 1}</span>
          {item.state === 'done' && <span className="mc-sh-w">T{item.winner}</span>}
          {item.rounds.length > 0 && (
            <span className="mc-sh-rds">
              {item.rounds.map((r, j) => (
                <span key={j} className={`mc-sh-rd ${r.s1 > r.s2 ? 'w1' : r.s2 > r.s1 ? 'w2' : ''}`}>
                  {r.s1}–{r.s2}
                </span>
              ))}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}

function PlayedSeriesHistory({ games }: { games: { s1: number; s2: number }[] }) {
  return (
    <span className="mc-sh num">
      {games.map((g, i) => (
        <span key={i} className={`mc-sh-s mc-sh-done`}>
          <span className="mc-sh-lbl">S{i + 1}</span>
          <span className="mc-sh-w">T{g.s1 > g.s2 ? 1 : 2}</span>
        </span>
      ))}
    </span>
  )
}
