import {
  invokeRoute,
  providerList,
  sessionFacts,
  sessionModelChoice,
  sessionSelectModel,
} from '@tenon-app/contracts'
import type {
  ProviderEndpoint,
  ProviderEntryContract,
  SessionModelChoice,
} from '@tenon-app/contracts'
import { useAuiState } from '@assistant-ui/react'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsModal } from '@/components/settings/SettingsModal'
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
import { customVendorGone, holdsTools, markLineKey } from '@/lib/custom-vendor'
import { confirmHostFor, heldConfirmHost } from '@/lib/data-flow'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import { useConversation } from '@/runtime/conversation'
import { TypeModelDialog } from './TypeModelDialog'

/**
 * The model menu (spec 02 §模型菜单与输入框; M5, M6, A11, A14, A15, A16, B14, A9): which model — and
 * thinking level — this session's next message goes to.
 *
 * Grouped by provider, listing only configured ones; an unconfigured provider keeps one greyed row
 * that opens the settings card. Each row names its target host (「本机」 for loopback only). A row
 * that holds text conversations only is greyed in a task. A choice — a row, a hand-typed id, a
 * thinking level — that would send history which went to this machine or a private network to a
 * public host turns the menu into a confirmation first: compared with where the history last went
 * (`session.facts`), not with the choice in effect, which a default moved elsewhere can already have
 * made public — unless the session's own choice already confirmed that host (lib/data-flow.ts). A
 * round the kernel held for that reason opens the same confirmation.
 *
 * A custom vendor instance (M6 §运行时「行标记、菜单与任务形态」) is one group of its own after the
 * builtins, named by its `displayName`. A row that passed its probe is `probed` and can be sent in a
 * task; one without a passing probe reads 「尚未通过探测」 and is greyed there like every row that holds
 * text conversations only. An instance offers no hand-typed id (§列表与上限: its rows are added on the
 * settings card, with their limits), and a session whose instance or row was removed shows its model
 * id marked 「（已删除）」 (§实例被删或改坏).
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
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  // 「下一条消息起生效」 while a Run is live or something waits (§模型菜单与输入框) — main's state, not
  // assistant-ui's, which this runtime never sets.
  const running = snapshot.running || snapshot.pending !== null
  const hasHistory = useAuiState((s) => s.thread.messages.length > 0)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>(LIST)
  const [entries, setEntries] = useState<readonly ProviderEntryContract[]>([])
  // Whether `entries` was ever read: before that, a session's instance is not 「已删除」, only unread.
  const [listed, setListed] = useState(false)
  const [current, setCurrent] = useState<SessionModelChoice | null>(null)
  const [loadedProfile, setProfile] = useState<'chat' | 'cowork'>('chat')
  // The session's own facts first: ModeSwitch changes the profile without going through this menu.
  const factsProfile = snapshot.facts?.profile ?? null
  const profile = factsProfile ?? loadedProfile
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [typing, setTyping] = useState<ProviderEntryContract | null>(null)

  const reload = useCallback(
    (): Promise<void> =>
      loadMenu(sessionId).then((loaded) => {
        if (loaded.entries !== null) {
          setEntries(loaded.entries)
          setListed(true)
        }
        if (loaded.choice !== null) setCurrent(loaded.choice)
        if (loaded.profile !== null) setProfile(loaded.profile)
      }),
    [sessionId],
  )

  // Again when the profile changes: the model in effect is that profile's default until one is chosen.
  useEffect(() => {
    void reload()
  }, [reload, factsProfile])

  // A round the kernel held for a public host — a queued send, or 「继续」 — opens the menu on the
  // same confirmation, also when the hold was pushed before this session was on screen.
  // Keyed on the hold's sequence alone: a queue push while a hold lasts (an edit, a withdraw) carries
  // `held` again as a new object, and must not reopen a confirmation the user closed.
  const { heldSeq } = snapshot
  useEffect(() => {
    const held = store.getSnapshot().held
    if (held === null || heldSeq === 0) return
    void loadMenu(sessionId).then((loaded) => {
      if (loaded.entries !== null) {
        setEntries(loaded.entries)
        setListed(true)
      }
      const choice = loaded.choice
      if (choice === null) return
      setCurrent(choice)
      // 「切换」 commits this choice: the page names where it sends now (lib/data-flow.ts).
      const target = loaded.entries?.find((entry) => entry.id === choice.providerId)?.endpoint
      setView({ kind: 'confirm', host: heldConfirmHost(held.host, target), choice })
      setOpen(true)
    })
  }, [heldSeq, sessionId, store])

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
   * Read at the moment of choosing: where this session's history last went (undefined: unread), and
   * the host its own choice ① sends to now, which the user confirmed choosing it (null: a default is
   * in effect, or unread; rrE-1).
   */
  const sentAndConfirmed = async (): Promise<{
    last: ProviderEndpoint | null | undefined
    confirmed: string | null
  }> => {
    const facts = await invokeRoute(window.tenon, sessionFacts, { sessionId })
    if (!facts.ok) return { last: undefined, confirmed: null }
    const chosen = facts.data.chosen
    return {
      last: facts.data.lastEndpoint ?? null,
      confirmed: chosen === undefined ? null : (entryOf(chosen.providerId)?.endpoint.host ?? null),
    }
  }

  /**
   * A choice made — a row, a hand-typed id or a level: the confirmation first when it would send
   * history that went to this machine or a private network to a public host (A9, 验收 34) the
   * session's own choice has not already confirmed (rrE-1); true when that is what it did.
   */
  const commit = async (choice: Choice): Promise<boolean> => {
    const target = entryOf(choice.providerId)?.endpoint
    const { last, confirmed } = await sentAndConfirmed()
    const host = confirmHostFor(last, target, hasHistory, confirmed)
    if (host !== null) {
      setView({ kind: 'confirm', host, choice })
      return true
    }
    await choose(choice)
    return false
  }

  const pick = (entry: ProviderEntryContract, row: { id: string }): Promise<boolean> =>
    commit({ providerId: entry.id, modelId: row.id, effort: null })

  /** An instance by the name the user gave it (M6 01 修补 4); a builtin by its catalogue name. */
  const nameOf = (entry: ProviderEntryContract): string =>
    entry.displayName ?? fromData(entry.nameKey)

  const hostLabel = (entry: ProviderEntryContract): string =>
    entry.endpoint.reach === 'loopback' ? t('model.host.local') : entry.endpoint.host

  const secondLine = (entry: ProviderEntryContract, row: Row): string => {
    const key = markLineKey(row.mark, entry.displayName !== undefined)
    if (key !== 'model.row.line') return t(key, { host: hostLabel(entry) })
    const purpose = row.purposeKey === undefined ? row.id : fromData(row.purposeKey)
    return t(key, { purpose, host: hostLabel(entry) })
  }

  /** A level's name from the catalogue; a vendor level it has no entry for shows as the vendor's. */
  const levelName = (level: string): string => {
    const key = `model.effort.level.${level}`
    const name = t(key as never)
    return name === key ? level : name
  }

  const row = rowOf(current)
  /**
   * 「`defaultEffort` 标「默认」，最高档注明用量代价」 (§模型菜单与输入框「思考强度 ›」): two marks that
   * apply independently — GLM-5.3's default is its highest level, and still carries the cost note.
   */
  const effortLabel = (level: string, highest: boolean): string => {
    const name = levelName(level)
    const isDefault = level === row?.defaultEffort
    if (isDefault && highest) return t('model.effort.defaultHighest', { level: name })
    if (isDefault) return t('model.effort.default', { level: name })
    if (highest) return t('model.effort.highest', { level: name })
    return name
  }
  const effortShown = current?.effort ?? row?.defaultEffort
  // §实例被删或改坏: the session's instance, or its row, is no longer listed.
  const gone = current !== null && listed && customVendorGone(current.providerId, current, entries)
  const triggerText =
    current === null
      ? t('model.trigger.label')
      : gone
        ? t('model.trigger.removed', { model: current.modelId })
        : row?.effortLevels !== undefined && effortShown !== undefined
          ? t('model.trigger.withEffort', {
              model: current.modelId,
              effort: levelName(effortShown),
            })
          : current.modelId
  const configured = entries.filter((entry) => entry.configured)
  // 「手填模型 ID」 is a builtin's only: an instance's rows come from the settings card (§列表与上限).
  const typable = configured.filter((entry) => entry.displayName === undefined)
  const moreRows = configured.flatMap((entry) =>
    entry.models
      .filter((candidate) => candidate.listing === 'more')
      .map((candidate) => ({ entry, candidate })),
  )
  const currentEntry = current === null ? undefined : entryOf(current.providerId)
  // A task whose model holds text conversations only cannot be sent (§表外模型与不发工具): the
  // composer disables 「发送」 and says why. A probed instance row can (M6 Q6). A removed instance
  // row is not held here: the send is refused as a missing key and its card says it was removed.
  const mark = gone
    ? undefined
    : (row?.mark ?? (currentEntry !== undefined ? 'unverified-text-only' : undefined))
  const textOnlyTask = profile === 'cowork' && mark !== undefined && !holdsTools(mark)
  useEffect(() => store.setTextOnlyTask(textOnlyTask), [store, textOnlyTask])
  // An instance has no hand-typed row: a choice its list lacks is a removed row (§实例被删或改坏).
  const handTyped =
    current !== null &&
    row === undefined &&
    currentEntry !== undefined &&
    currentEntry.displayName === undefined
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
        <DropdownMenuContent
          align="end"
          side="top"
          // As wide as its rows, not its trigger: a purpose line never wraps (00 验收 12).
          className="w-max min-w-72 max-w-(--available-width)"
          data-testid="model-menu"
        >
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
                // A group label must sit in a group (Base UI throws otherwise).
                <DropdownMenuGroup>
                  {/* Base UI hides a group label from assistive tech (it only names its group);
                      this one is a note the menu is read with. */}
                  <DropdownMenuLabel aria-hidden={false} data-testid="model-next-message">
                    {t('model.nextMessage')}
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
              ) : null}
              {entries.map((entry) =>
                entry.configured ? (
                  <DropdownMenuGroup key={entry.id} data-testid={`model-group-${entry.id}`}>
                    <DropdownMenuLabel>{nameOf(entry)}</DropdownMenuLabel>
                    {[
                      ...entry.models.filter((candidate) => candidate.listing === 'main'),
                      ...(handTyped?.providerId === entry.id
                        ? [HAND_TYPED(handTyped.modelId)]
                        : []),
                    ].map((candidate) => {
                      const blocked = profile === 'cowork' && !holdsTools(candidate.mark)
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
                    {t('model.notConfigured', { provider: nameOf(entry) })}
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
                        <DropdownMenuGroup>
                          <DropdownMenuLabel
                            aria-hidden={false}
                            data-testid="model-next-message-cache"
                            className="max-w-64 whitespace-normal"
                          >
                            {t('model.nextMessageCache')}
                          </DropdownMenuLabel>
                        </DropdownMenuGroup>
                      ) : null}
                      {row.effortLevels.map((level, i, all) => (
                        <DropdownMenuItem
                          key={level}
                          data-testid={`model-effort-${level}`}
                          // Open until `commit` decides: it may turn the menu into the confirmation.
                          closeOnClick={false}
                          onClick={() =>
                            void commit({
                              providerId: current.providerId,
                              modelId: current.modelId,
                              effort: level,
                            })
                          }
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            {effortShown === level ? <CheckIcon /> : null}
                          </span>
                          {effortLabel(level, i === all.length - 1)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              ) : null}
              <DropdownMenuSeparator />
              {moreRows.length === 0 && typable.length === 0 ? null : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="model-more">
                    {t('model.more')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {moreRows.map(({ entry, candidate }) => (
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
                    ))}
                    {typable.map((entry) => (
                      <DropdownMenuItem
                        key={`${entry.id}-type`}
                        data-testid={`model-type-${entry.id}`}
                        onClick={() => setTyping(entry)}
                      >
                        {t('model.typeModelFor', { provider: nameOf(entry) })}
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
      <SettingsModal
        open={settingsOpen}
        onOpenChange={(next) => {
          setSettingsOpen(next)
          if (!next) void reload()
        }}
      />
      <TypeModelDialog
        key={typing?.id ?? 'closed'}
        entry={typing}
        providerName={typing === null ? '' : nameOf(typing)}
        onClose={() => setTyping(null)}
        onUse={(modelId) => {
          if (typing === null) return
          const entry = typing
          setTyping(null)
          // The menu closed when the dialog opened: the confirmation needs it open again.
          void pick(entry, { id: modelId }).then((asked) => {
            if (asked) setOpen(true)
          })
        }}
      />
    </>
  )
}
