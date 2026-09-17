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
