import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './crash-logger-renderer'
import './index.css'
import App from './App.tsx'
import { AppFatalBoundary } from './components/AppFatalBoundary'

document.documentElement.dataset.theme = 'dark'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppFatalBoundary>
      <App />
    </AppFatalBoundary>
  </StrictMode>,
)
