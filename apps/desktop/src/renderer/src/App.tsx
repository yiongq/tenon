import { chatNew, configGet, configSet, invokeRoute } from '@tenon-app/contracts'
import type { Config, LocaleSetting } from '@tenon-app/contracts'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { AppShell } from './components/shell/AppShell'
import { Thread } from './components/thread/Thread'
import { ChatProvider } from './runtime/ChatProvider'

function newSessionId(): string {
  return crypto.randomUUID()
}

export function App(): JSX.Element {
  const [sessionId, setSessionId] = useState(newSessionId)
  const [config, setConfig] = useState<Config>({ locale: 'auto', sidebarCollapsed: false })

  useEffect(() => {
    void invokeRoute(window.tenon, configGet, {}).then((result) => {
      if (result.ok) setConfig(result.data)
    })
    return window.tenon.on(chatNew.channel, () => setSessionId(newSessionId()))
  }, [])

  const patch = useCallback((changes: Partial<Config>) => {
    setConfig((current) => ({ ...current, ...changes }))
    void invokeRoute(window.tenon, configSet, changes).then((result) => {
      if (result.ok) setConfig(result.data)
    })
  }, [])

  return (
    <AppShell
      collapsed={config.sidebarCollapsed}
      onCollapsedChange={(sidebarCollapsed) => patch({ sidebarCollapsed })}
      onNewChat={() => setSessionId(newSessionId())}
      locale={config.locale}
      onLocaleChange={(locale: LocaleSetting) => patch({ locale })}
    >
      <ChatProvider key={sessionId} sessionId={sessionId}>
        <Thread />
      </ChatProvider>
    </AppShell>
  )
}
