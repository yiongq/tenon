import {
  chatQueueEvent,
  invokeRoute,
  providerList,
  sessionFacts,
  sessionModelChoice,
  sessionSelectModel,
} from '@tenon-app/contracts'
import type { ProviderEntryContract, SessionModelChoice } from '@tenon-app/contracts'
import { useAuiState } from '@assistant-ui/react'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { ProviderSettings } from '@/components/settings/ProviderSettings'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useConversation } from '@/runtime/conversation'
import { TypeModelDialog } from './TypeModelDialog'

/**
 * The model menu (spec 02 §模型菜单与输入框; M5, M6, A11, A14, A15, A16, B14, A9): which model — and
 * thinking level — this session's next message goes to.
 *
 * Grouped by provider, listing only configured ones; an unconfigured provider keeps one greyed row
 * that opens the settings card. Each row names its target host (「本机」 for loopback only). A row
 * that holds text conversations only is greyed in a task. A choice that would send a conversation
 * with history from this machine or a private network to a public host turns the menu into a
 * confirmation first; a round the kernel held for that reason opens the same confirmation.
 */

type Row = ProviderEntryContract['models'][number]

interface Choice {
  readonly providerId: string
  readonly modelId: string
  readonly effort: string | null
}

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'confirm'; readonly host: string; readonly choice: Choice }

const LIST: View = { kind: 'list' }

/** What the menu draws from, read in one round trip; a failed read leaves that part as it was. */
async function loadMenu(sessionId: string): Promise<{
  entries: ProviderEntryContract[] | null
  choice: SessionModelChoice | null
  profile: 'chat' | 'cowork' | null
}> {
  const [list, choice, facts] = await Promise.all([
    invokeRoute(window.tenon, providerList, {}),
    invokeRoute(window.tenon, sessionModelChoice, { sessionId }),
    invokeRoute(window.tenon, sessionFacts, { sessionId }),
  ])
  return {
    entries: list.ok ? list.data : null,
    choice: choice.ok ? choice.data : null,
    profile: facts.ok ? facts.data.profile : null,
  }
}

/** The session's hand-typed choice, shown as a row of its own provider (A15). */
const HAND_TYPED = (id: string): Row => ({ id, mark: 'unverified-text-only', listing: 'main' })

export function ModelMenu(): JSX.Element {
  const { t } = useTranslation()
  /** A catalogue key that arrives as DATA (a `nameKey`, a `purposeKey`), as the settings card does. */
  const fromData = (key: string): string => t(key as never)
  const { sessionId, startSession } = useConversation()
  const running = useAuiState((s) => s.thread.isRunning)
  const hasHistory = useAuiState((s) => s.thread.messages.length > 0)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>(LIST)
  const [entries, setEntries] = useState<readonly ProviderEntryContract[]>([])
  const [current, setCurrent] = useState<SessionModelChoice | null>(null)
  const [profile, setProfile] = useState<'chat' | 'cowork'>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [typing, setTyping] = useState<ProviderEntryContract | null>(null)

  const reload = useCallback(
    (): Promise<void> =>
      loadMenu(sessionId).then((loaded) => {
        if (loaded.entries !== null) setEntries(loaded.entries)
        if (loaded.choice !== null) setCurrent(loaded.choice)
        if (loaded.profile !== null) setProfile(loaded.profile)
      }),
    [sessionId],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  // A round the kernel held for a public host: the menu opens on the same confirmation.
  useEffect(
    () =>
      window.tenon.on(chatQueueEvent.channel, (payload) => {
        const parsed = chatQueueEvent.payload.safeParse(payload)
        if (!parsed.success || parsed.data.sessionId !== sessionId) return
        const held = parsed.data.held
        if (held === undefined) return
        void invokeRoute(window.tenon, sessionModelChoice, { sessionId }).then((choice) => {
          if (!choice.ok) return
          setCurrent(choice.data)
          setView({ kind: 'confirm', host: held.host, choice: choice.data })
          setOpen(true)
        })
      }),
    [sessionId],
  )

  const choose = async (choice: Choice): Promise<void> => {
    const written = await invokeRoute(window.tenon, sessionSelectModel, { sessionId, ...choice })
    setOpen(false)
    setView(LIST)
    if (written.ok) await reload()
  }

  /** 「用新模型开新会话」: a new session whose draft already holds the choice; none of the old content. */
  const newSessionWith = async (choice: Choice): Promise<void> => {
    const next = crypto.randomUUID()
    const written = await invokeRoute(window.tenon, sessionSelectModel, {
      sessionId: next,
      ...choice,
    })
    setOpen(false)
    setView(LIST)
    if (written.ok && written.data.ok) startSession(next)
  }

  const entryOf = (providerId: string): ProviderEntryContract | undefined =>
    entries.find((entry) => entry.id === providerId)
  const rowOf = (choice: SessionModelChoice | null): Row | undefined =>
    choice === null
      ? undefined
      : entryOf(choice.providerId)?.models.find((row) => row.id === choice.modelId)

  /**
   * A row picked: the confirmation first when a conversation with history would leave this machine
   * or a private network for a public host (A9); true when that is what it did.
   */
  const pick = (entry: ProviderEntryContract, row: { id: string }): boolean => {
    const choice: Choice = { providerId: entry.id, modelId: row.id, effort: null }
    const before = current === null ? undefined : entryOf(current.providerId)?.endpoint
    const goesPublic =
      hasHistory &&
      before !== undefined &&
      before.reach !== 'public' &&
      entry.endpoint.reach === 'public'
    if (goesPublic) {
      setView({ kind: 'confirm', host: entry.endpoint.host, choice })
      return true
    }
    void choose(choice)
    return false
  }

  const hostLabel = (entry: ProviderEntryContract): string =>
    entry.endpoint.reach === 'loopback' ? t('model.host.local') : entry.endpoint.host

  const secondLine = (entry: ProviderEntryContract, row: Row): string => {
    if (row.mark === 'local-text-only') {
      return t('model.mark.localTextOnly', { host: hostLabel(entry) })
    }
    if (row.mark === 'unverified-text-only') return t('model.mark.unverified')
    const purpose = row.purposeKey === undefined ? row.id : fromData(row.purposeKey)
    return t('model.row.line', { purpose, host: hostLabel(entry) })
  }

  /** A level's name from the catalogue; a vendor level it has no entry for shows as the vendor's. */
  const levelName = (level: string): string => {
    const key = `model.effort.level.${level}`
    const name = t(key as never)
    return name === key ? level : name
  }

  const row = rowOf(current)
  const effortShown = current?.effort ?? row?.defaultEffort
  const triggerText =
    current === null
      ? t('model.trigger.label')
      : row?.effortLevels !== undefined && effortShown !== undefined
        ? t('model.trigger.withEffort', { model: current.modelId, effort: levelName(effortShown) })
        : current.modelId
  const configured = entries.filter((entry) => entry.configured)
  const handTyped =
    current !== null && row === undefined && entryOf(current.providerId) !== undefined
      ? current
      : null

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) void reload()
          else setView(LIST)
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              data-testid="model-menu-trigger"
              aria-label={t('model.trigger.label')}
              className="ctl-h shrink-0 gap-1 px-2 font-sans text-ui-sm text-text-secondary"
            />
          }
        >
          <span className="max-w-48 truncate" data-testid="model-menu-current">
            {triggerText}
          </span>
          <ChevronDownIcon className="size-4 text-text-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="min-w-72" data-testid="model-menu">
          {view.kind === 'confirm' ? (
            <DropdownMenuGroup data-testid="model-confirm">
              <DropdownMenuLabel className="max-w-72 whitespace-normal">
                {t('model.confirm.title', { host: view.host })}
              </DropdownMenuLabel>
              <DropdownMenuItem
                data-testid="model-confirm-switch"
                onClick={() => void choose(view.choice)}
              >
                {t('model.confirm.switch')}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="model-confirm-new-chat"
                onClick={() => void newSessionWith(view.choice)}
              >
                {t('model.confirm.newChat')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          ) : (
            <>
              {running ? (
                <DropdownMenuLabel data-testid="model-next-message">
                  {t('model.nextMessage')}
                </DropdownMenuLabel>
              ) : null}
              {entries.map((entry) =>
                entry.configured ? (
                  <DropdownMenuGroup key={entry.id} data-testid={`model-group-${entry.id}`}>
                    <DropdownMenuLabel>{fromData(entry.nameKey)}</DropdownMenuLabel>
                    {[
                      ...entry.models.filter((candidate) => candidate.listing === 'main'),
                      ...(handTyped?.providerId === entry.id
                        ? [HAND_TYPED(handTyped.modelId)]
                        : []),
                    ].map((candidate) => {
                      const textOnly = candidate.mark !== 'verified'
                      const blocked = profile === 'cowork' && textOnly
                      const checked =
                        current?.providerId === entry.id && current.modelId === candidate.id
                      return (
                        <DropdownMenuItem
                          key={candidate.id}
                          data-testid={`model-row-${entry.id}-${candidate.id}`}
                          disabled={blocked}
                          closeOnClick={false}
                          onClick={() => void pick(entry, candidate)}
                          className="items-start"
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                            {checked ? <CheckIcon /> : null}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="text-ui text-text-primary">{candidate.id}</span>
                            <span className="text-micro text-text-muted">
                              {blocked
                                ? t('model.row.textOnlyInTask')
                                : secondLine(entry, candidate)}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                ) : (
                  <DropdownMenuItem
                    key={entry.id}
                    data-testid={`model-unconfigured-${entry.id}`}
                    className="text-text-muted"
                    onClick={() => setSettingsOpen(true)}
                  >
                    {t('model.notConfigured', { provider: fromData(entry.nameKey) })}
                  </DropdownMenuItem>
                ),
              )}
              {row?.effortLevels !== undefined && current !== null ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger data-testid="model-effort">
                      {t('model.effort.menu')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent data-testid="model-effort-levels">
                      {running ? (
                        <DropdownMenuLabel className="max-w-64 whitespace-normal">
                          {t('model.nextMessageCache')}
                        </DropdownMenuLabel>
                      ) : null}
                      {row.effortLevels.map((level, i, all) => (
                        <DropdownMenuItem
                          key={level}
                          data-testid={`model-effort-${level}`}
                          onClick={() => void choose({ ...current, effort: level })}
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            {effortShown === level ? <CheckIcon /> : null}
                          </span>
                          {level === row.defaultEffort
                            ? t('model.effort.default', { level: levelName(level) })
                            : i === all.length - 1
                              ? t('model.effort.highest', { level: levelName(level) })
                              : levelName(level)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              ) : null}
              <DropdownMenuSeparator />
              {configured.length === 0 ? null : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="model-more">
                    {t('model.more')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {configured.flatMap((entry) =>
                      entry.models
                        .filter((candidate) => candidate.listing === 'more')
                        .map((candidate) => (
                          <DropdownMenuItem
                            key={`${entry.id}-${candidate.id}`}
                            data-testid={`model-row-${entry.id}-${candidate.id}`}
                            closeOnClick={false}
                            onClick={() => void pick(entry, candidate)}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="text-ui text-text-primary">{candidate.id}</span>
                              <span className="text-micro text-text-muted">
                                {secondLine(entry, candidate)}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        )),
                    )}
                    {configured.map((entry) => (
                      <DropdownMenuItem
                        key={`${entry.id}-type`}
                        data-testid={`model-type-${entry.id}`}
                        onClick={() => setTyping(entry)}
                      >
                        {t('model.typeModelFor', { provider: fromData(entry.nameKey) })}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem data-testid="model-manage" onClick={() => setSettingsOpen(true)}>
                {t('model.manage')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ProviderSettings
        open={settingsOpen}
        onOpenChange={(next) => {
          setSettingsOpen(next)
          if (!next) void reload()
        }}
      />
      <TypeModelDialog
        key={typing?.id ?? 'closed'}
        entry={typing}
        providerName={typing === null ? '' : fromData(typing.nameKey)}
        onClose={() => setTyping(null)}
        onUse={(modelId) => {
          if (typing === null) return
          const entry = typing
          setTyping(null)
          // The menu closed when the dialog opened: the confirmation needs it open again.
          if (pick(entry, { id: modelId })) setOpen(true)
        }}
      />
    </>
  )
}
