import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Canvas, type Layers } from './Canvas'
import { findSpacingViolations, findSplitNets } from './layout'
import { canvasToPng } from './screenshot'
import type { Layout, Netlist, Rect } from './types'

const SHOWN = { visible: true, opacity: 1 }
const ALL_LAYERS: Layers = { islands: SHOWN, parts: SHOWN, netLabels: SHOWN, leads: SHOWN, grid: SHOWN }
const ignore = () => {}

/**
 * Screenshot of a project that is not on screen: draws it with the same Canvas, off-screen, so
 * the picture matches what the editor would show for that tab.
 */
export async function screenshotHidden(netlist: Netlist, layout: Layout, isolation: number, bounds: Rect): Promise<string> {
  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 800px; height: 600px; display: flex'
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const problemNets = new Set([...findSpacingViolations(layout.islands), ...findSplitNets(layout.islands)])
    flushSync(() =>
      root.render(
        <Canvas
          netlist={netlist}
          layout={layout}
          onLayoutChange={ignore}
          onBeginEdit={ignore}
          selection={null}
          onSelect={ignore}
          snap={0}
          isolation={isolation}
          problemNets={problemNets}
          fitRequest={0}
          layers={ALL_LAYERS}
          tool="select"
          moveMode="part"
        />,
      ),
    )
    const svg = host.querySelector<SVGSVGElement>('svg.canvas')
    if (!svg) throw new Error('Could not draw the project')
    return await canvasToPng(svg, bounds)
  } finally {
    root.unmount()
    host.remove()
  }
}
