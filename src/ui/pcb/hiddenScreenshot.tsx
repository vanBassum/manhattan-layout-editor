import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Canvas, DEFAULT_PCB_GRID_LINES_PER_MAJOR } from './Canvas'
import { findProblemNets } from '../../layout'
import type { BuiltNetlist, Layout, Rect } from '../../types'
import { ALL_LAYERS } from '../layers'
import { canvasToPng } from './screenshot'

const ignore = () => {}

/**
 * Screenshot of a project that is not on screen: draws it with the same Canvas, off-screen, so
 * the picture matches what the editor would show for that tab.
 */
export async function screenshotHidden(netlist: BuiltNetlist, layout: Layout, isolation: number, bounds: Rect): Promise<string> {
  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 800px; height: 600px; display: flex'
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  const root = createRoot(host)
  try {
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
          problemNets={findProblemNets(layout.islands)}
          fitRequest={0}
          layers={ALL_LAYERS}
          tool="select"
          moveMode="part"
          rectHandles={false}
          gridLinesPerMajor={DEFAULT_PCB_GRID_LINES_PER_MAJOR}
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
