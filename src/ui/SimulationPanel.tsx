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
import { NumberField, TextField } from './panels'
import { formatQuantity } from './quantity'
import { ScopePlot, type ScopeTrace } from './ScopePlot'

const NO_SIMULATION: Simulation = { sources: [], models: {} }

interface SimulationPanelProps {
  /** With the schematic's nets: the schematic is what gets simulated. */
  netlist: Netlist
  definitions: Record<string, ComponentDefinition> | undefined
  simulation: Simulation | undefined
  onChange: (simulation: Simulation) => void
}

type Analysis = 'operating point' | 'transient'

type Outcome = { point: OperatingPoint; warnings: string[] } | { trace: Transient; sourceNet: string; warnings: string[] } | { error: string }

/** What a run gave, with the netlist it ran, so the panel can tell when the schematic has changed since. */
type Run = { analysis: Analysis; netlist: string } & Outcome

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

/** Sets up the sources and SPICE models of the schematic, and shows its operating point or its response over time. */
export function SimulationPanel({ netlist, definitions, simulation = NO_SIMULATION, onChange }: SimulationPanelProps) {
  const [run, setRun] = useState<Run | null>(null)
  const [running, setRunning] = useState(false)
  const nets = useMemo(
    () => [...new Set(netlist.components.flatMap((c) => c.pins.map((p) => p.net)))].filter((n) => n && !isGroundNet(n)).sort(naturalCompare),
    [netlist],
  )

  // The circuit as it stands; its problems are shown before anything runs.
  const circuit = useMemo((): { circuit: SpiceCircuit } | { problems: string[] } => {
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
    setRun({ analysis, netlist: text, ...outcome })
    setRunning(false)
  }

  const { sources } = simulation
  const changeSources = (next: Source[]) => onChange({ ...simulation, sources: next })
  const undrivenNet = nets.find((n) => !sources.some((s) => s.net === n))
  const hasWave = waveSources(sources).length > 0

  return (
    <div className="simulation">
      <div className="simulation-setup">
        <span className="field-label">Sources</span>
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

        <Models netlist={netlist} simulation={simulation} onChange={onChange} />

        {'problems' in circuit ? (
          <ul className="check-list">
            {circuit.problems.map((problem) => (
              <li key={problem} className="warn">{problem}</li>
            ))}
          </ul>
        ) : (
          <div className="run-buttons">
            <button disabled={running} onClick={() => runAnalysis('operating point', circuit.circuit)} title="DC voltages and currents with the circuit at rest">
              Operating point
            </button>
            <button
              disabled={running || !hasWave}
              onClick={() => runAnalysis('transient', circuit.circuit)}
              title={hasWave ? 'The circuit driven by its square and sine sources, over five periods' : 'Give a source a square or sine wave first'}
            >
              Transient
            </button>
          </div>
        )}
        {running && <p className="muted">Running…</p>}
      </div>

      <div className="simulation-results">
        {run ? (
          <RunResult run={run} outdated={'problems' in circuit || netlistFor(run.analysis, circuit.circuit) !== run.netlist} />
        ) : (
          <p className="muted">Run the operating point or a transient to see the results here.</p>
        )}
      </div>
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
    <>
      <span className="field-label">Models</span>
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
    </>
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
      {'error' in run ? (
        <pre className="error simulation-log">{run.error}</pre>
      ) : (
        <>
          {'point' in run ? <OperatingPointResult point={run.point} /> : <TransientResult trace={run.trace} sourceNet={run.sourceNet} />}
          {run.warnings.length > 0 && <pre className="warn simulation-log">{run.warnings.join('\n')}</pre>}
        </>
      )}
      <details>
        <summary className="muted">SPICE netlist</summary>
        <pre className="simulation-log">{run.netlist}</pre>
      </details>
    </div>
  )
}

function OperatingPointResult({ point }: { point: OperatingPoint }) {
  return (
    <>
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
    </>
  )
}

/** The slowest wave source's net and one net of choice on the scope; the net starts as an output when the schematic names one. */
function TransientResult({ trace, sourceNet }: { trace: Transient; sourceNet: string }) {
  const probeNets = [...trace.volts.keys()].filter((net) => net !== sourceNet).sort(naturalCompare)
  const [probe, setProbe] = useState(() => probeNets.find((net) => /out/i.test(net)) ?? probeNets[0])
  const traces: ScopeTrace[] = [{ net: sourceNet, volts: trace.volts.get(sourceNet)!, series: 1 }]
  if (probe && trace.volts.has(probe)) traces.push({ net: probe, volts: trace.volts.get(probe)!, series: 2 })
  return (
    <>
      <label className="probe-field">
        <span className="field-label">Show</span>
        <NetSelect nets={probeNets} value={probe} label="Net shown with the source" onChange={setProbe} />
      </label>
      <ScopePlot time={trace.time} traces={traces} />
    </>
  )
}

const Quantity = ({ label, text }: { label: string; text: string }) => (
  <>
    <dt>{label}</dt>
    <dd>{text}</dd>
  </>
)
