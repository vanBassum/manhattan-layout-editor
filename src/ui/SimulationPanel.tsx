import { useEffect, useMemo, useState } from 'react'
import { errorText } from '../errorText'
import { isGroundNet, naturalCompare } from '../model/netlist'
import type { ComponentDefinition, Netlist, Simulation, Source } from '../model/types'
import { runSpice } from '../simulation/ngspice'
import {
  operatingPointNetlist,
  partValue,
  readOperatingPoint,
  readTransient,
  spiceCircuit,
  transientNetlist,
  valuesNeedingModels,
  waveSources,
  type OperatingPoint,
  type SpiceCircuit,
  type Transient,
} from '../simulation/spiceNetlist'
import { Icon } from './icons'
import { NumberField, Section, TextField } from './panels'
import { formatQuantity } from './quantity'
import { ScopePlot, type Cursors, type ScopeTrace, type SeriesSlot } from './ScopePlot'
import { measure } from '../simulation/waveform'

type Analysis = 'operating point' | 'transient'

const ANALYSES: { analysis: Analysis; label: string }[] = [
  { analysis: 'operating point', label: 'Operating point (DC)' },
  { analysis: 'transient', label: 'Transient' },
]

type Outcome = { point: OperatingPoint; warnings: string[] } | { trace: Transient; sourceNet: string; warnings: string[] } | { error: string }

/** What a run gave, with the netlist it ran, so the panel can tell when the schematic has changed since. */
type Run = { analysis: Analysis; netlist: string; milliseconds: number } & Outcome

/** The netlist `analysis` runs for the circuit as it is now; undefined for a transient without a wave source. */
function netlistFor(analysis: Analysis, circuit: SpiceCircuit): string | undefined {
  if (analysis === 'operating point') return operatingPointNetlist(circuit)
  return waveSources(circuit.sources).length ? transientNetlist(circuit) : undefined
}

/** The source as `shape`; a new wave starts at 1 kHz. */
function withShape(source: Source, shape: Source['shape']): Source {
  if (shape === 'dc') return { net: source.net, shape, volts: source.volts }
  return { net: source.net, shape, volts: source.volts, hertz: source.shape === 'dc' ? 1e3 : source.hertz }
}

/** The simulation's state, shared by its sidebar (set-up and Run) and its pane (results). */
export interface SimulationSession {
  tab: Analysis
  setTab: (tab: Analysis) => void
  /** The circuit as it stands, or why it cannot be simulated. */
  circuit: { circuit: SpiceCircuit } | { problems: string[] }
  /** The last run of each analysis. */
  runs: Partial<Record<Analysis, Run>>
  running: boolean
  /** Whether the tab shown can run now. */
  canRun: boolean
  runTab: () => void
}

/**
 * Runs analyses of the schematic and keeps the last run of each. Runs belong to the project they
 * ran: another `projectId` starts without any.
 */
export function useSimulation(netlist: Netlist, definitions: Record<string, ComponentDefinition> | undefined, simulation: Simulation, projectId: string): SimulationSession {
  const [tab, setTab] = useState<Analysis>('operating point')
  const [stored, setStored] = useState<{ projectId: string; runs: Partial<Record<Analysis, Run>> }>({ projectId, runs: {} })
  const [running, setRunning] = useState(false)
  const runs = stored.projectId === projectId ? stored.runs : {}

  // The circuit as it stands; its problems are shown before anything runs.
  const circuit = useMemo((): SimulationSession['circuit'] => {
    try {
      return { circuit: spiceCircuit(netlist, definitions, simulation) }
    } catch (e) {
      return { problems: errorText(e).split('\n') }
    }
  }, [netlist, definitions, simulation])

  const runAnalysis = async (analysis: Analysis, built: SpiceCircuit) => {
    const text = netlistFor(analysis, built)
    if (text === undefined) return
    setRunning(true)
    const started = performance.now()
    let outcome: Outcome
    try {
      const { vectors, warnings } = await runSpice(text)
      outcome =
        analysis === 'operating point'
          ? { point: readOperatingPoint(built, vectors), warnings }
          : { trace: readTransient(built, vectors), sourceNet: waveSources(built.sources)[0].net, warnings }
    } catch (e) {
      outcome = { error: errorText(e) }
    }
    const run: Run = { analysis, netlist: text, milliseconds: performance.now() - started, ...outcome }
    setStored((previous) => ({ projectId, runs: { ...(previous.projectId === projectId ? previous.runs : {}), [analysis]: run } }))
    setRunning(false)
  }

  const canRun = !('problems' in circuit) && netlistFor(tab, circuit.circuit) !== undefined
  return {
    tab,
    setTab,
    circuit,
    runs,
    running,
    canRun,
    runTab: () => {
      if (!('problems' in circuit)) runAnalysis(tab, circuit.circuit)
    },
  }
}

interface SimulationSidebarProps {
  session: SimulationSession
  /** With the schematic's nets: the schematic is what gets simulated. */
  netlist: Netlist
  simulation: Simulation
  onChange: (simulation: Simulation) => void
}

/** The simulation's sidebar: its sources, the models its semiconductors need, and Run. */
export function SimulationSidebar({ session, netlist, simulation, onChange }: SimulationSidebarProps) {
  const nets = useMemo(
    () => [...new Set(netlist.components.flatMap((c) => c.pins.map((p) => p.net)))].filter((n) => n && !isGroundNet(n)).sort(naturalCompare),
    [netlist],
  )
  const { sources } = simulation
  const changeSources = (next: Source[]) => onChange({ ...simulation, sources: next })
  const undrivenNet = nets.find((n) => !sources.some((s) => s.net === n))
  const { tab, circuit, running, canRun } = session

  return (
    <>
      <Section title="Run">
        <div className="simulation-run">
          {'problems' in circuit && (
            <ul className="check-list">
              {circuit.problems.map((problem) => (
                <li key={problem} className="warn">{problem}</li>
              ))}
            </ul>
          )}
          {tab === 'transient' && !('problems' in circuit) && !canRun && <p className="warn">Give a source a square or sine wave to run a transient.</p>}
          <button className="run-button" disabled={running || !canRun} onClick={session.runTab}>
            {running ? 'Running…' : `Run ${tab}`}
          </button>
        </div>
      </Section>
      <Section title={`Sources (${sources.length})`}>
        <div className="source-list">
          {sources.map((source, k) => (
            <SourceFields
              key={k}
              nets={nets}
              source={source}
              onChange={(changed) => changeSources(sources.map((s, i) => (i === k ? changed : s)))}
              onRemove={() => changeSources(sources.filter((_, i) => i !== k))}
            />
          ))}
          <button disabled={!undrivenNet} onClick={() => undrivenNet && changeSources([...sources, { net: undrivenNet, shape: 'dc', volts: 12 }])}>
            <Icon name="plus" />Add source
          </button>
        </div>
      </Section>
      <Models netlist={netlist} simulation={simulation} onChange={onChange} />
    </>
  )
}

/** The simulation's pane: a tab per analysis with its last run. */
export function SimulationResults({ session }: { session: SimulationSession }) {
  const { tab, setTab, runs, circuit } = session
  const run = runs[tab]
  return (
    <div className="simulation-results">
      <div className="analysis-tabs" role="tablist" aria-label="Analysis">
        {ANALYSES.map(({ analysis, label }) => (
          <button key={analysis} role="tab" aria-selected={tab === analysis} className={tab === analysis ? 'active' : ''} onClick={() => setTab(analysis)}>
            {label}
          </button>
        ))}
      </div>
      {run ? (
        <RunResult run={run} outdated={'problems' in circuit || netlistFor(run.analysis, circuit.circuit) !== run.netlist} />
      ) : (
        <p className="muted">Press Run to see the {tab} here.</p>
      )}
    </div>
  )
}

function NetSelect({ nets, value, label, onChange }: { nets: string[]; value: string; label: string; onChange: (net: string) => void }) {
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {/* A net the schematic no longer has stays listed, so it can be seen and changed. */}
      {!nets.includes(value) && <option value={value}>{value}</option>}
      {nets.map((net) => (
        <option key={net} value={net}>{net}</option>
      ))}
    </select>
  )
}

interface SourceFieldsProps {
  nets: string[]
  source: Source
  onChange: (source: Source) => void
  onRemove: () => void
}

/** One source: its net and shape, its voltage (peak for a wave) and a wave's frequency. */
function SourceFields({ nets, source, onChange, onRemove }: SourceFieldsProps) {
  return (
    <div className="source-fields">
      <NetSelect nets={nets} value={source.net} label="Source net" onChange={(net) => onChange({ ...source, net })} />
      <select value={source.shape} aria-label="Shape" onChange={(e) => onChange(withShape(source, e.target.value as Source['shape']))}>
        <option value="dc">DC</option>
        <option value="square">Square</option>
        <option value="sine">Sine</option>
      </select>
      <button className="icon-button" title="Remove source" aria-label="Remove source" onClick={onRemove}>
        ×
      </button>
      <NumberField
        label={source.shape === 'dc' ? 'Voltage' : 'Peak voltage'}
        value={source.volts}
        unit={source.shape === 'dc' ? 'V' : 'Vpk'}
        step={source.shape === 'dc' ? 0.5 : 0.1}
        onCommit={(volts) => onChange({ ...source, volts })}
      />
      {source.shape !== 'dc' && (
        <TextField
          value={formatQuantity(source.hertz, 'Hz')}
          label="Frequency"
          placeholder="e.g. 1k or 1MHz"
          onCommit={(text) => {
            const hertz = partValue(text)
            if (hertz !== undefined && hertz > 0) onChange({ ...source, hertz })
          }}
        />
      )}
    </div>
  )
}

/** The models of the transistors and diodes, each editable as SPICE text. */
function Models({ netlist, simulation, onChange }: { netlist: Netlist; simulation: Simulation; onChange: (simulation: Simulation) => void }) {
  const needed = valuesNeedingModels(netlist)
  const [editing, setEditing] = useState<string | null>(null)
  if (needed.size === 0) return null
  const changeModel = (value: string, text: string) => {
    const { [value]: _old, ...others } = simulation.models
    onChange({ ...simulation, models: text.trim() ? { ...others, [value]: text } : others })
  }
  return (
    <Section title={`Models (${needed.size})`}>
      <ul className="model-list">
        {[...needed].map(([value, refs]) => (
          <li key={value}>
            <button className="model-row" aria-expanded={editing === value} onClick={() => setEditing(editing === value ? null : value)}>
              <span className="value">{value || '(no value)'}</span>
              <span className="muted">{refs.join(' ')}</span>
              <span className={simulation.models[value] ? 'ok' : 'warn'}>{simulation.models[value] ? 'model' : 'missing'}</span>
            </button>
            {editing === value && (
              <ModelText
                value={simulation.models[value] ?? ''}
                placeholder={`.model ${value} NPN(IS=1e-14 BF=200 ...)`}
                onCommit={(text) => changeModel(value, text)}
              />
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** SPICE model text, committed when the field loses focus, so an edit is one undo step. */
function ModelText({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <textarea
      className="model-text"
      rows={6}
      spellCheck={false}
      value={draft}
      placeholder={placeholder}
      aria-label="SPICE model"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  )
}

function RunResult({ run, outdated }: { run: Run; outdated: boolean }) {
  return (
    <div className="simulation-result">
      {outdated && <p className="warn">The circuit changed since this run.</p>}
      {'point' in run && <OperatingPointResult point={run.point} />}
      {'trace' in run && <TransientResult trace={run.trace} sourceNet={run.sourceNet} />}
      <SimulationLog run={run} />
    </div>
  )
}

/** What ngspice did: the analysis, its warnings or error, how long it took, and the netlist it ran. */
function SimulationLog({ run }: { run: Run }) {
  const analysis =
    'trace' in run
      ? `Transient: 0 … ${formatQuantity(run.trace.time[run.trace.time.length - 1], 's')}, ${run.trace.time.length} points`
      : run.analysis === 'operating point'
        ? 'DC operating point'
        : 'Transient'
  return (
    <details className="card" open>
      <summary className="card-title">Simulation log</summary>
      <ul className="log-list">
        <li className="ok">ngspice (WebAssembly)</li>
        <li className={'error' in run ? 'error' : 'ok'}>{analysis}</li>
        {'warnings' in run && run.warnings.map((warning) => <li key={warning} className="warn">{warning}</li>)}
        {'error' in run ? (
          <li>
            <pre className="error simulation-log">{run.error}</pre>
          </li>
        ) : (
          <li className="ok">Finished in {Math.round(run.milliseconds)} ms</li>
        )}
      </ul>
      <details>
        <summary className="muted">SPICE netlist</summary>
        <pre className="simulation-log">{run.netlist}</pre>
      </details>
    </details>
  )
}

function OperatingPointResult({ point }: { point: OperatingPoint }) {
  return (
    <section className="card">
      <h3 className="card-title">Operating point</h3>
      <dl className="properties counts">
        {[...point.volts].filter(([net]) => !isGroundNet(net)).sort(([a], [b]) => naturalCompare(a, b)).map(([net, volts]) => (
          <Quantity key={net} label={net} text={formatQuantity(volts, 'V')} />
        ))}
        {point.dcSources.map((s) => (
          <Quantity key={`source-${s.net}`} label={`${s.net} source`} text={`${formatQuantity(s.amps, 'A')} · ${formatQuantity(s.amps * s.volts, 'W')}`} />
        ))}
      </dl>
      {point.transistors.length > 0 && (
        <table className="transistor-table">
          <thead>
            <tr><th>Part</th><th>Vbe</th><th>Vce</th><th>Ic</th><th>Ib</th></tr>
          </thead>
          <tbody>
            {point.transistors.map((t) => (
              <tr key={t.ref}>
                <td>{t.ref}</td>
                <td>{formatQuantity(t.vbe, 'V')}</td>
                <td>{formatQuantity(t.vce, 'V')}</td>
                <td>{formatQuantity(t.ic, 'A')}</td>
                <td>{formatQuantity(t.ib, 'A')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** Up to three nets share one axis: three colours stay distinguishable wherever their lines cross. */
const MAX_TRACES = 3

/**
 * The transient: the nets shown (the wave source's net and an output to start with), the plot with
 * cursors A and B, and measurements of every shown net.
 */
function TransientResult({ trace, sourceNet }: { trace: Transient; sourceNet: string }) {
  const nets = [...trace.volts.keys()].sort(naturalCompare)
  // Each shown net keeps the colour slot it got when it was switched on.
  const [shown, setShown] = useState<Map<string, SeriesSlot>>(() => {
    const output = nets.find((net) => net !== sourceNet && /out/i.test(net)) ?? nets.find((net) => net !== sourceNet)
    return new Map<string, SeriesSlot>(output ? [[sourceNet, 1], [output, 2]] : [[sourceNet, 1]])
  })
  const [cursors, setCursors] = useState<Cursors>({})
  const toggle = (net: string) => {
    const next = new Map(shown)
    if (next.has(net)) next.delete(net)
    else {
      const free = ([1, 2, 3] as const).find((slot) => ![...next.values()].includes(slot))
      if (free === undefined) return
      next.set(net, free)
    }
    setShown(next)
  }
  const traces: ScopeTrace[] = [...shown].map(([net, series]) => ({ net, series, volts: trace.volts.get(net)! }))
  const end = trace.time[trace.time.length - 1]
  const setCursor = (cursor: keyof Cursors, text: string) => {
    const seconds = partValue(text)
    if (seconds !== undefined && seconds <= end) setCursors({ ...cursors, [cursor]: seconds })
  }
  const span = cursors.a !== undefined && cursors.b !== undefined ? Math.abs(cursors.b - cursors.a) : undefined
  const full = shown.size >= MAX_TRACES

  return (
    <>
      <section className="card">
        <h3 className="card-title">Transient — {traces.map((t) => `V(${t.net})`).join(', ') || 'no nets shown'}</h3>
        <div className="trace-chips" role="group" aria-label="Nets shown">
          {nets.map((net) => {
            const slot = shown.get(net)
            return (
              <button
                key={net}
                className={slot ? 'trace-chip on' : 'trace-chip'}
                aria-pressed={slot !== undefined}
                disabled={!slot && full}
                title={!slot && full ? `At most ${MAX_TRACES} nets at once` : undefined}
                onClick={() => toggle(net)}
              >
                {slot && <span className={`line-key series-${slot}`} aria-hidden="true" />}
                {net}
              </button>
            )
          })}
        </div>
        {traces.length > 0 && (
          <ScopePlot time={trace.time} traces={traces} cursors={cursors} onCursor={(cursor, seconds) => setCursors({ ...cursors, [cursor]: seconds })} />
        )}
        <p className="muted hint">Click the plot to place cursor A, Shift+click for B.</p>
      </section>
      <div className="card-row">
        <section className="card">
          <h3 className="card-title">Cursors</h3>
          <div className="cursor-fields">
            {(['a', 'b'] as const).map((cursor) => (
              <label key={cursor}>
                <span className="cursor-badge">{cursor.toUpperCase()}</span>
                <TextField
                  value={cursors[cursor] === undefined ? '' : formatQuantity(cursors[cursor]!, 's')}
                  label={`Cursor ${cursor.toUpperCase()}`}
                  placeholder="click the plot"
                  onCommit={(text) => setCursor(cursor, text)}
                />
              </label>
            ))}
            <span>Δt = {span === undefined ? '–' : formatQuantity(span, 's')}</span>
            <span>f = {span ? formatQuantity(1 / span, 'Hz') : '–'}</span>
          </div>
        </section>
        <section className="card">
          <h3 className="card-title">Measurements</h3>
          <table className="measurement-table">
            <thead>
              <tr><th>Net</th><th>max</th><th>min</th><th>pk-pk</th><th>avg</th></tr>
            </thead>
            <tbody>
              {traces.map((t) => {
                const m = measure(trace.time, t.volts)
                return (
                  <tr key={t.net}>
                    <td><span className={`line-key series-${t.series}`} aria-hidden="true" />{t.net}</td>
                    <td>{formatQuantity(m.max, 'V')}</td>
                    <td>{formatQuantity(m.min, 'V')}</td>
                    <td>{formatQuantity(m.peakToPeak, 'V')}</td>
                    <td>{formatQuantity(m.average, 'V')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      </div>
    </>
  )
}

const Quantity = ({ label, text }: { label: string; text: string }) => (
  <>
    <dt>{label}</dt>
    <dd>{text}</dd>
  </>
)
