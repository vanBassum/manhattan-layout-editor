// Every project file in src/examples is offered under File > Examples, called by its file name.

import type { Project } from '../types'
import { projectFromFile, projectNameOf } from './projectFormat'

const EXAMPLE_FILES = import.meta.glob<string>('../examples/*.manhattan.json', { query: '?raw', import: 'default', eager: true })
const FIRST_VISIT_EXAMPLE = '../examples/Astable multivibrator.manhattan.json'

export interface Example {
  name: string
  /** A fresh copy: each is a project of its own, so it gets its own guid. */
  open: () => Project
}

const exampleFrom = (path: string, text: string): Example => ({
  name: projectNameOf(path.replace(/^.*\//, '')),
  open: () => ({ ...projectFromFile(text), guid: crypto.randomUUID() }),
})

export const EXAMPLES: Example[] = Object.entries(EXAMPLE_FILES)
  .map(([path, text]) => exampleFrom(path, text))
  .sort((a, b) => a.name.localeCompare(b.name))

/** What a browser that has never been here opens. */
export const firstVisitExample = () => exampleFrom(FIRST_VISIT_EXAMPLE, EXAMPLE_FILES[FIRST_VISIT_EXAMPLE])
