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

// Before the first paint: the CSS keyed on it (the macOS title bar's drag region and clearance).
document.documentElement.dataset['platform'] = window.tenon.platform

// The interface face loads with the first frame; the prose and code faces would load only when the
// first reply needs them, and that reply's Latin letters and digits could be laid out before they
// arrive. Ask for them now (bundled files, a few milliseconds); in Chinese the prose face is the
// alias that leaves CJK punctuation to the system font (fonts.css), the same file.
for (const family of ['Source Serif 4', 'Tenon Serif Latin', 'Source Code Pro']) {
  document.fonts.load(`1em "${family}"`).catch(() => undefined)
}

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
