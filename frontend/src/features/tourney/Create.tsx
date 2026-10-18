// New tournament: game → mode → format and rules → name. Every choice comes
// from the server's catalogue, so a game's modes and allowed formats live in one place.
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { api, useCatalog, type Format, type Settings } from '../../lib/tourney'
import { errText } from './Report'

export function CreatePage() {
  useTitle('New tournament')
  const cat = useCatalog()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [game, setGame] = useState('')
  const [mode, setMode] = useState('')
  const [format, setFormat] = useState<Format | ''>('')
  const [size, setSize] = useState(1)
  const [rules, setRules] = useState<Partial<Settings>>({})
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const g = cat.data?.games[game]
  const md = g?.modes[mode]
  const step = !game ? 1 : !mode ? 2 : 3
  const suggested = useMemo(() => {
    if (!g || !md || !format) return ''
    const fmtWord = { knockout: 'Cup', double_elim: 'Bracket', league: 'League', groups: 'World Cup', ffa: 'Series' }[format]
    return `${g.short} ${md.label} ${fmtWord}`
  }, [g, md, format])

  const pickGame = (k: string) => { setGame(k); setMode(''); setFormat(''); setRules({}) }
  const pickMode = (k: string) => {
    const m = g!.modes[k]!
    setMode(k); setFormat(m.default_format); setSize(m.team_size)
    setRules({ best_of: m.default_bo, lobbies: m.lobbies, kill_points: m.kill_points })
  }
  const r = <K extends keyof Settings>(k: K, v: Settings[K]) => setRules((x) => ({ ...x, [k]: v }))

  const create = async () => {
    if (!format || !md) return
    setBusy(true); setErr('')
    try {
      const t = await api.create({ name: (name || suggested).trim(), game, mode, format, team_size: size, settings: rules })
      qc.invalidateQueries({ queryKey: ['tourney', 'list'] })
      nav(`/tourney/${t.id}`, { replace: true })
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  if (cat.isError) return <div className="page"><ErrorStrip text="Couldn't load games" onRetry={() => cat.refetch()} /></div>
  if (!cat.data) return <div className="page"><SkeletonRows n={4} height={72} /></div>
  const knockoutish = format === 'knockout' || format === 'groups'

  return (
    <div className="page tn">
      <button type="button" className="btn btn-ghost tn-back" onClick={() => (step === 1 ? nav('/tourney') : step === 2 ? setGame('') : setMode(''))}>
        <Icon name="left" className="btn-ico" />{step === 1 ? 'Tourney' : 'Back'}
      </button>
      <div className="tn-steps eyebrow" aria-label={`Step ${step} of 3`}>
        <span data-on={step >= 1}>Game</span><span data-on={step >= 2}>Mode</span><span data-on={step >= 3}>Rules</span>
      </div>
      <h1 className="page-h1" tabIndex={-1}>{step === 1 ? 'Pick a game' : step === 2 ? g!.name : `${g!.short} · ${md!.label}`}</h1>

      {step === 1 && (
        <ul className="tn-games">
          {Object.entries(cat.data.games).map(([k, x]) => (
            <li key={k}>
              <button type="button" className="tn-game glass" style={{ ['--gc' as string]: x.color }} onClick={() => pickGame(k)}>
                <span className="tn-game-short">{x.short}</span>
                <span className="tn-game-name">{x.name}</span>
                <span className="meta">{x.blurb} · {Object.keys(x.modes).length} {Object.keys(x.modes).length === 1 ? 'mode' : 'modes'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {step === 2 && (
        <ul className="tn-modes glass">
          {Object.entries(g!.modes).map(([k, m]) => (
            <li key={k}>
              <button type="button" className="tn-mode" onClick={() => pickMode(k)}>
                <span className="tn-mode-top">
                  <span className="tn-mode-name">{m.label}</span>
                  <span className="pill">{m.kind === 'ffa' ? (m.team_size > 1 ? `Squads of ${m.team_size}` : 'Every player for themselves') : m.team_size === 1 ? '1 vs 1' : `${m.team_size} vs ${m.team_size}`}</span>
                </span>
                <span className="tn-mode-blurb">{m.blurb}</span>
                <span className="meta">Scored in {m.unit.toLowerCase()} · {m.formats.map((f) => cat.data!.formats[f].label).join(', ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {step === 3 && md && (
        <div className="tn-rules">
          <fieldset className="tn-field">
            <legend className="field-label">Format</legend>
            <div className="tn-formats">
              {md.formats.map((f) => (
                <button key={f} type="button" className="tn-format" aria-pressed={format === f} onClick={() => setFormat(f)}>
                  <b>{cat.data!.formats[f].label}</b><span className="meta">{cat.data!.formats[f].blurb}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {md.team_sizes.length > 1 && (
            <Choice label={md.kind === 'ffa' ? 'Squad size' : 'Players per team'} value={size} options={md.team_sizes} onPick={setSize}
              show={(n) => (n === 1 ? 'Solo' : `${n}`)} />
          )}
          {format !== 'ffa' && md.best_of.length > 1 && !(md.legs && knockoutish && rules.legs === 2) && (
            <Choice label="Series length" value={rules.best_of ?? md.default_bo} options={md.best_of} onPick={(n) => r('best_of', n)}
              show={(n) => (n === 1 ? 'Single game' : `Best of ${n}`)} />
          )}
          {md.round_bo && md.round_bo.length > 1 && format !== 'ffa' && (rules.best_of ?? md.default_bo) > 1 && (
            <Choice label="Maps per round" value={rules.round_bo ?? 1} options={md.round_bo} onPick={(n) => r('round_bo', n)}
              show={(n) => (n === 1 ? 'Single map' : `Best of ${n} maps`)} />
          )}
          {md.legs && knockoutish && (
            <Choice label="Knockout ties" value={rules.legs ?? 1} options={[1, 2]} onPick={(n) => r('legs', n)}
              show={(n) => (n === 1 ? 'One game' : 'Home and away')} />
          )}
          {format === 'league' && (
            <Choice label="Everyone plays everyone" value={rules.league_legs ?? 1} options={[1, 2]} onPick={(n) => r('league_legs', n)}
              show={(n) => (n === 1 ? 'Once' : 'Twice')} />
          )}
          {format === 'groups' && (
            <>
              <Choice label="Group size" value={rules.group_size ?? 4} options={[3, 4, 5, 6]} onPick={(n) => r('group_size', n)} show={String} />
              <Choice label="Go through from each group" value={rules.advance ?? 2} options={[1, 2, 3]} onPick={(n) => r('advance', n)} show={(n) => `Top ${n}`} />
            </>
          )}
          {(format === 'knockout' || format === 'groups') && (
            <Toggle label="Play a 3rd-place match" on={rules.third_place ?? true} set={(v) => r('third_place', v)} />
          )}
          {format === 'double_elim' && (
            <Toggle label="Bracket reset: if the losers-bracket finalist wins the grand final, play it again" on={rules.final_reset ?? true} set={(v) => r('final_reset', v)} />
          )}
          {format === 'ffa' && (
            <>
              <Choice label="Games in the series" value={rules.lobbies ?? md.lobbies} options={[1, 2, 3, 4, 5, 6, 8, 10]} onPick={(n) => r('lobbies', n)} show={String} />
              <Choice label="Points per kill" value={rules.kill_points ?? md.kill_points} options={[0, 1, 2]} onPick={(n) => r('kill_points', n)} show={(n) => (n === 0 ? 'None' : String(n))} />
              <p className="meta tn-note">Placement points: {md.placement_points.map((p, i) => `${i + 1}${['st', 'nd', 'rd'][i] ?? 'th'} ${p}`).join(' · ')}</p>
            </>
          )}
          {game === 'custom' && (
            <div className="tn-two">
              <label className="tn-field"><span className="field-label">Game name</span>
                <input className="input" maxLength={40} placeholder="e.g. Mario Kart" value={rules.game_name ?? ''} onChange={(e) => r('game_name', e.target.value)} /></label>
              <label className="tn-field"><span className="field-label">Scored in</span>
                <input className="input" maxLength={16} placeholder="Points" value={rules.unit ?? ''} onChange={(e) => r('unit', e.target.value)} /></label>
            </div>
          )}
          <Toggle label="Announce in the WhatsApp group when it starts and when it ends" on={rules.whatsapp ?? true} set={(v) => r('whatsapp', v)} />
          <label className="tn-field"><span className="field-label">Name</span>
            <input className="input" maxLength={60} placeholder={suggested} value={name} onChange={(e) => setName(e.target.value)} /></label>
          {err && <p className="form-err" role="alert">{err}</p>}
          <div><button type="button" className="btn btn-primary" disabled={busy || !format} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create and add players'}</button></div>
        </div>
      )}
    </div>
  )
}

function Choice({ label, value, options, onPick, show }: { label: string; value: number; options: number[]; onPick: (n: number) => void; show: (n: number) => string }) {
  return (
    <fieldset className="tn-field">
      <legend className="field-label">{label}</legend>
      <div className="tn-chips">
        {options.map((n) => <button key={n} type="button" className="chip" aria-pressed={value === n} onClick={() => onPick(n)}>{show(n)}</button>)}
      </div>
    </fieldset>
  )
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="check-row"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />{label}</label>
  )
}
