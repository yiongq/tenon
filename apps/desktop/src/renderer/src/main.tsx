import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { App } from './App'
import { startRendererI18n } from './i18n'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

void startRendererI18n().then((i18n) => {
  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </StrictMode>,
  )
})
