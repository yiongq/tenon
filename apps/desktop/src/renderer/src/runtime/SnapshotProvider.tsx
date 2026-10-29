import { chatEvent } from '@tenon-app/contracts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Rounds } from '@/lib/snapshots'
import { SnapshotRefresh } from './snapshot-refresh'

const SnapshotContext = createContext<{
  sessionId: string
  data: Rounds | null
  refresh: () => Promise<Rounds | null>
}>({ sessionId: '', data: null, refresh: async () => null })
export const useSnapshotRounds = () => useContext(SnapshotContext)

/** One read model for the title menu, tools and settlements. Remounted on session changes. */
export function SnapshotProvider({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  const [data, setData] = useState<Rounds | null>(null)
  const controller = useRef<SnapshotRefresh | null>(null)
  const refresh = useCallback(() => controller.current?.refresh() ?? Promise.resolve(null), [])
  useEffect(() => {
    const current = new SnapshotRefresh(window.tenon, sessionId, setData)
    controller.current = current
    const update = () => {
      void current.refresh()
    }
    update()
    const detach = window.tenon.on(chatEvent.channel, current.event)
    window.addEventListener('focus', update)
    // Retention can change while this session is idle in a visible window.
    const timer = window.setInterval(update, 30_000)
    return () => {
      current.dispose()
      controller.current = null
      detach()
      window.removeEventListener('focus', update)
      window.clearInterval(timer)
    }
  }, [sessionId])
  const value = useMemo(() => ({ sessionId, data, refresh }), [sessionId, data, refresh])
  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>
}
