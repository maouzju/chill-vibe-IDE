import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './crash-logger-renderer'
import './index.css'
import App from './App.tsx'
import { AppFatalBoundary } from './components/AppFatalBoundary'

type MainBootstrapWindow = Window & {
  __CHILL_VIBE_ROOT__?: ReturnType<typeof createRoot>
}

document.documentElement.dataset.theme = 'dark'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Chill Vibe root element was not found.')
}

const bootstrapWindow = window as MainBootstrapWindow
const appRoot = bootstrapWindow.__CHILL_VIBE_ROOT__ ?? createRoot(rootElement)
bootstrapWindow.__CHILL_VIBE_ROOT__ = appRoot

appRoot.render(
  <StrictMode>
    <AppFatalBoundary>
      <App />
    </AppFatalBoundary>
  </StrictMode>,
)
