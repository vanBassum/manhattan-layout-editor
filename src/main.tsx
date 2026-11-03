import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { openProjectStore } from './documents/projectStore'
import './index.css'

await openProjectStore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
