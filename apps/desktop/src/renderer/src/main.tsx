// zod's JIT probe (`new Function('')`) trips script-src 'self'; disable it before any schema
// module (i.e. before @tenon-app/contracts) is evaluated.
import './zod-csp'
import '../../styles/theme.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { App } from './App'
import { ThemeProvider } from './components/shell/ThemeProvider'
import { TooltipProvider } from './components/ui/tooltip'
import { startRendererI18n } from './i18n'
import { listenForQueue } from './runtime/queue-state'
import { listenForRunState } from './runtime/run-state'

// Subscribed before anything awaits: a `run.state` or `chat.queue` push that main sends as this
// document loads is never missed (spec 02 §进行中、暂停与 RunRegistry「何时推」).
listenForRunState(window.tenon)
listenForQueue(window.tenon)

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

void startRendererI18n().then((i18n) => {
  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <TooltipProvider>
            <App />
          </TooltipProvider>
        </ThemeProvider>
      </I18nextProvider>
    </StrictMode>,
  )
})
