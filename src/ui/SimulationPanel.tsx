import { useEffect, useMemo, useState } from 'react'
import { errorText } from '../errorText'
import { isGroundNet, naturalCompare } from '../model/netlist'
import type { ComponentDefinition, Netlist, Simulation } from '../model/types'
import { runSpice } from '../simulation/ngspice'
import { operatingPointNetlist, readOperatingPoint, spiceCircuit, valuesNeedingModels, type OperatingPoint, type SpiceCircuit } from '../simulation/spiceNetlist'
import { Icon } from './icons'
import { NumberField } from './panels'

const NO_SIMULATION: Simulation = { supplies: [], models: {} }

const PREFIXES: [number, string][] = [[1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']]

/** "3.84 mA", "5.18 V", "-12.0 µA": three significant digits with the prefix that fits. */
function formatQuantity(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`
  const size = Math.abs(value)
  const [scale, prefix] = PREFIXES.find(([scale]) => size >= scale) ?? PREFIXES[PREFIXES.length - 1]
  return `${(value / scale).toPrecision(3)} ${prefix}${unit}`
}

interface SimulationPanelProps {
  /** With the schematic's nets: the schematic is what gets simulated. */
  netlist: Netlist
  definitions: Record<string, ComponentDefinition> | undefined
  simulation: Simulation | undefined
  onChange: (simulation: Simulation) => void
}

/** What a run gave, with the netlist it ran, so the panel can tell when the schematic has changed since. */
type Run = { netlist: string; point: OperatingPoint; warnings: string[] } | { netlist: string; error: string }

/** Sets up the supplies and SPICE models of the schematic and shows its DC operating point. */
export function SimulationPanel({ netlist, definitions, simulation = NO_SIMULATION, onChange }: SimulationPanelProps) {
  const [run, setRun] = useState<Run | null>(null)
  const [running, setRunning] = useState(false)
  const nets = useMemo(() => [...new Set(netlist.components.flatMap((c) => c.pins.map((p) => p.net)))].filter((n) => n && !isGroundNet(n)).sort(naturalCompare), [netlist])

  // The circuit as it stands; its problems are shown before anything runs.
  const circuit = useMemo((): { circuit: SpiceCircuit; text: string } | { problems: string[] } => {
    try {
      const built = spiceCircuit(netlist, definitions, simulation)
      return { circuit: built, text: operatingPointNetlist(built) }
    } catch (e) {
      return { problems: errorText(e).split('\n') }
    }
  }, [netlist, definitions, simulation])

  const runOperatingPoint = async () => {
    if ('problems' in circuit) return
    const { circuit: built, text } = circuit
    setRunning(true)
    try {
      const { vectors, warnings } = await runSpice(text)
      setRun({ netlist: text, point: readOperatingPoint(built, vectors), warnings })
    } catch (e) {
      setRun({ netlist: text, error: errorText(e) })
    } finally {
      setRunning(false)
    }
  }

  const changeSupplies = (supplies: Simulation['supplies']) => onChange({ ...simulation, supplies })
  const unpoweredNet = nets.find((n) => !simulation.supplies.some((s) => s.net === n))

  return (
    <div className="simulation">
      <span className="field-label">Supplies</span>
      <div className="supply-list">
        {simulation.supplies.map((supply, k) => (
          <div key={k} className="supply-row">
            <select
              value={supply.net}
              aria-label="Supply net"
              onChange={(e) => changeSupplies(simulation.supplies.map((s, i) => (i === k ? { ...s, net: e.target.value } : s)))}
            >
              {/* A supply on a net the schematic no longer has stays listed, so it can be seen and changed. */}
              {!nets.includes(supply.net) && <option value={supply.net}>{supply.net}</option>}
              {nets.map((net) => (
                <option key={net} value={net}>{net}</option>
              ))}
            </select>
            <NumberField
              label="Supply voltage"
              value={supply.volts}
              unit="V"
              step={0.5}
              onCommit={(volts) => changeSupplies(simulation.supplies.map((s, i) => (i === k ? { ...s, volts } : s)))}
            />
            <button className="icon-button" title="Remove supply" aria-label="Remove supply" onClick={() => changeSupplies(simulation.supplies.filter((_, i) => i !== k))}>
              ×
            </button>
          </div>
        ))}
        <button disabled={!unpoweredNet} onClick={() => unpoweredNet && changeSupplies([...simulation.supplies, { net: unpoweredNet, volts: 12 }])}>
          <Icon name="plus" />Add supply
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
        <button className="run-simulation" disabled={running} onClick={runOperatingPoint}>
          {running ? 'Running…' : 'Run operating point'}
        </button>
      )}

      {run && <RunResult run={run} outdated={'text' in circuit ? circuit.text !== run.netlist : true} />}
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
          <dl className="properties counts">
            {[...run.point.volts].filter(([net]) => !isGroundNet(net)).sort(([a], [b]) => naturalCompare(a, b)).map(([net, volts]) => (
              <Quantity key={net} label={net} text={formatQuantity(volts, 'V')} />
            ))}
            {run.point.supplies.map((s) => (
              <Quantity key={`supply-${s.net}`} label={`${s.net} supply`} text={`${formatQuantity(s.amps, 'A')} · ${formatQuantity(s.amps * s.volts, 'W')}`} />
            ))}
          </dl>
          {run.point.transistors.length > 0 && (
            <table className="transistor-table">
              <thead>
                <tr><th>Part</th><th>Vbe</th><th>Vce</th><th>Ic</th><th>Ib</th></tr>
              </thead>
              <tbody>
                {run.point.transistors.map((t) => (
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

const Quantity = ({ label, text }: { label: string; text: string }) => (
  <>
    <dt>{label}</dt>
    <dd>{text}</dd>
  </>
)
