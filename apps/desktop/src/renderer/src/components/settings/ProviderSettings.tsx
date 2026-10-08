import {
  configGet,
  invokeRoute,
  providerConfigure,
  providerList,
  providerSelect,
} from '@tenon-app/contracts'
import type {
  ProviderConfigKeyContract,
  ProviderEntryContract,
  ProviderSelection,
  ProviderWriteErrorCode,
} from '@tenon-app/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, JSX, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PROVIDER_WRITE_ERROR_KEY, REFUSAL_KEY } from '@/lib/provider-copy'
import { CustomVendorSection } from './CustomVendorSection'
import { Chooser, Field } from './fields'

/**
 * Models and keys (spec 01 §desktop 接线, 验收 6): the provider to use, one field per declared
 * `ConfigKey`, and which model.
 *
 * The whole card is rendered from `provider.list`'s DATA — the loop below never names a provider,
 * a key or a model. Adding a provider is adding a definition in the kernel and its entries in the
 * two locale catalogues; this file does not change, and a unit test walking the registry keeps
 * those catalogue entries honest.
 *
 * What a secret field shows is whether one is STORED, never the value: `provider.list` has no
 * field a value could arrive in. A secret input therefore starts empty even when configured, and
 * only a field the user actually edited is sent — so saving the form does not silently rewrite a
 * key that was left alone. Clearing one deliberately is what deletes it, and the field says so
 * before the save rather than after.
 *
 * Custom vendor instances (M6) are not rendered by that loop: the generic form skips every entry
 * that carries a `displayName` — only an instance's does (§IPC) — and the instance section below it
 * shows an instance's key, its read-only address and its model rows (CustomVendorSection.tsx). A
 * builtin whose stored address is refused reads as not configured and says why (§点名 (b)); an
 * address off the official origin also offers 「新建自定义厂商」, a subscription path does not.
 */
export interface ProviderSettingsProps {
  open: boolean
  embedded?: boolean
  onBusyChange?: (busy: boolean) => void
  onOpenChange: (open: boolean) => void
  /** Where focus goes when the card closes — the row the account menu opened it from. */
  finalFocus?: RefObject<HTMLElement | null>
}

/** The write codes plus the two this side can produce. */
type CardErrorCode = ProviderWriteErrorCode | 'unavailable' | 'no-model'

interface CardError {
  readonly code: CardErrorCode
  readonly configKey: string | null
}

interface Draft {
  readonly providerId: string
  readonly modelId: string
  /** A hand-typed model id; used instead of `modelId` when not blank (M6). */
  readonly customModel: string
  /**
   * Whether the user touched the model: only then does a save write the default model (spec 02
   * §模型选择「设置卡」) — a save that only changed a key must not move the default of new chats.
   */
  readonly modelEdited: boolean
  /** Current field contents, keyed by `ConfigKey.name`. Secrets start empty. */
  readonly values: Readonly<Record<string, string>>
  /** The fields the user typed in: the only ones a save sends. */
  readonly edited: readonly string[]
  /** Which of them are credentials — what a closed card must not still be holding. */
  readonly secretKeys: readonly string[]
}

/** Everything the card draws from, in one round trip. */
interface Loaded {
  readonly entries: readonly ProviderEntryContract[]
  readonly settings: Readonly<Record<string, Record<string, string>>>
  readonly saved: ProviderSelection | null
}

/** Module scope on purpose: an effect that depends on it must not re-run every render. */
async function read(): Promise<Loaded | null> {
  const [list, config] = await Promise.all([
    invokeRoute(window.tenon, providerList, {}),
    invokeRoute(window.tenon, configGet, {}),
  ])
  if (!list.ok || !config.ok) return null
  return {
    // M6 §IPC: the instance section shows the instances; this form, the builtins.
    entries: list.data.filter((entry) => entry.displayName === undefined),
    settings: config.data.providerConfig,
    saved: config.data.provider,
  }
}

export function ProviderSettings(props: ProviderSettingsProps): JSX.Element {
  const { open, onOpenChange, finalFocus } = props
  const { t } = useTranslation()
  /**
   * A catalogue key that arrives as DATA — a definition's `nameKey` / `labelKey` — rather than as
   * a literal `t` can be type-checked against. The unit test that walks the registry against both
   * catalogues stands in for the compiler here.
   */
  const fromData = (key: string): string => t(key as never)
  const fieldId = useId()
  const [entries, setEntries] = useState<readonly ProviderEntryContract[] | null>(null)
  const [settings, setSettings] = useState<Readonly<Record<string, Record<string, string>>>>({})
  const [saved, setSaved] = useState<ProviderSelection | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<CardError | null>(null)
  const [saving, setSaving] = useState(false)
  /** The instance section's create form is open (M6; §点名 (b)'s button opens it too). */
  const [creating, setCreating] = useState(false)
  /** One of the instance section's writes is in flight: the card stays open, as for `saving`. */
  const [sectionBusy, setSectionBusy] = useState(false)
  const { onBusyChange } = props
  useEffect(() => {
    onBusyChange?.(saving || sectionBusy)
  }, [saving, sectionBusy, onBusyChange])
  const chooser = useRef<HTMLSelectElement | null>(null)
  /** One shot per opening: the fields do not exist yet when the dialog takes initial focus. */
  const wantsFocus = useRef(false)

  /**
   * Every opening starts from what is stored: a card left half-filled and closed must not come
   * back with the text still in it. The whole reset happens in one update AFTER the reads resolve
   * — clearing up front would also blank the card during its own closing animation.
   */
  useEffect(() => {
    if (!open) return
    wantsFocus.current = true
    void read().then((loaded) => {
      if (loaded === null) {
        setError({ code: 'unavailable', configKey: null })
        return
      }
      const chosen = loaded.entries.find((item) => item.id === loaded.saved?.id)
      const selected = chosen ?? loaded.entries[0] ?? null
      setEntries(loaded.entries)
      setSettings(loaded.settings)
      setSaved(loaded.saved)
      setError(null)
      setSaving(false)
      setCreating(false)
      setDraft(selected === null ? null : newDraft(selected, loaded.settings, loaded.saved))
    })
  }, [open])

  /**
   * A typed credential lives no longer than the card. The component never unmounts (the account
   * menu renders it next to itself), so without this the plaintext would sit in renderer state
   * until the next opening. Only the secret fields are blanked: the rest are re-read from
   * `config.json` anyway, and clearing them too would empty the card mid closing-animation.
   *
   * Every way out goes through here — Escape, the backdrop, the close button, Cancel and a
   * finished save.
   */
  const close = (): void => {
    setDraft((current) => (current === null ? current : withoutSecrets(current)))
    onOpenChange(false)
  }

  const entry = entries?.find((candidate) => candidate.id === draft?.providerId) ?? null

  /**
   * Initial focus belongs on the first field, but the card mounts while `provider.list` is still
   * in flight, so at open time the only focusable things are the footer buttons. Once the fields
   * exist, focus moves to the chooser — once per opening, so a later provider switch or a reload
   * after a failed save never takes focus away from where the user put it.
   */
  useEffect(() => {
    if (!open || entry === null || !wantsFocus.current) return
    wantsFocus.current = false
    chooser.current?.focus()
  }, [open, entry])

  const chooseProvider = (next: ProviderEntryContract): void => {
    setError(null)
    setDraft(newDraft(next, settings, saved))
  }

  const edit = (name: string, value: string): void => {
    setError(null)
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            values: { ...current.values, [name]: value },
            edited: current.edited.includes(name) ? current.edited : [...current.edited, name],
          },
    )
  }

  const save = async (): Promise<void> => {
    if (draft === null) return
    const modelId = draft.customModel.trim() === '' ? draft.modelId : draft.customModel.trim()
    // A definition that ships no model cannot be selected without a typed id (`provider.select`
    // requires one), so a save that would write nothing says why instead of closing as if it took.
    if (draft.modelEdited && modelId === '') {
      setError({ code: 'no-model', configKey: null })
      return
    }
    setSaving(true)
    setError(null)
    /** A card that stays open must describe the keychain as it is NOW, not as it opened. */
    const fail = async (problem: CardError, wrote: boolean): Promise<void> => {
      if (wrote) {
        const loaded = await read()
        if (loaded !== null) {
          setEntries(loaded.entries)
          setSettings(loaded.settings)
          setSaved(loaded.saved)
        }
      }
      setError(problem)
    }
    try {
      const values = Object.fromEntries(
        draft.edited.map((name) => [name, draft.values[name] ?? '']),
      )
      const wrote = Object.keys(values).length > 0
      if (wrote) {
        const written = await invokeRoute(window.tenon, providerConfigure, {
          id: draft.providerId,
          values,
        })
        // Nothing was written when configure itself refused, so the statuses still hold.
        if (!written.ok) return await fail({ code: 'unavailable', configKey: null }, false)
        if (!written.data.ok) return await fail(written.data, false)
      }
      if (draft.modelEdited) {
        const chosen = await invokeRoute(window.tenon, providerSelect, {
          providerId: draft.providerId,
          modelId,
        })
        if (!chosen.ok) return await fail({ code: 'unavailable', configKey: null }, wrote)
        if (!chosen.data.ok) return await fail(chosen.data, wrote)
      }
      props.onBusyChange?.(false)
      close()
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void save()
  }

  const content = (
    <>
      <DialogHeader>
        <DialogTitle>{t('settings.providers.title')}</DialogTitle>
        <DialogDescription>{t('settings.providers.description')}</DialogDescription>
      </DialogHeader>
      {/* `min-w-0`: this is a grid item of the popup, and its automatic minimum would be the
            instance cards' unwrapped one-line summaries (wire · address); the popup's column would
            grow to fit them and push the cards and Save past its edge. At 0 the column keeps the
            popup's width and those lines truncate. */}
      <div className="flex min-w-0 flex-col gap-4">
        {/* The fields scroll, the footer does not: a definition may declare more keys than fit
              on a short screen, and a Save button below the fold is a Save button nobody finds.
              The inset margin keeps the focus ring off the scroll container's edge. The instance
              section scrolls with the form but is not in it: its buttons write on their own, and
              Enter in one of its fields must not save the form above. */}
        <div className="-mx-1 flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-1">
          {entries === null || entry === null || draft === null ? (
            <p className="font-sans text-ui-sm text-text-muted" data-testid="provider-loading">
              {t('settings.providers.loading')}
            </p>
          ) : (
            <form
              id={`${fieldId}-form`}
              className="flex flex-col gap-4"
              aria-busy={saving}
              onSubmit={onSubmit}
            >
              <Field label={t('settings.providers.provider')} htmlFor={`${fieldId}-provider`}>
                <Chooser
                  id={`${fieldId}-provider`}
                  testId="provider-select"
                  inputRef={chooser}
                  value={entry.id}
                  options={entries.map((candidate) => ({
                    value: candidate.id,
                    label: fromData(candidate.nameKey),
                  }))}
                  onChange={(id) => {
                    const next = entries.find((candidate) => candidate.id === id)
                    if (next !== undefined) chooseProvider(next)
                  }}
                />
              </Field>

              {entry.refused === undefined ? null : (
                <div
                  data-testid="provider-refused"
                  data-refusal-code={entry.refused.code}
                  className="flex flex-col items-start gap-2 rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
                >
                  <p>{t(REFUSAL_KEY[entry.refused.code])}</p>
                  {entry.refused.code === 'official-host-only' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      data-testid="provider-refused-new-custom"
                      onClick={() => setCreating(true)}
                    >
                      {t('customVendor.create.open')}
                    </Button>
                  ) : null}
                </div>
              )}

              {orderedKeys(entry.configKeys).map((key) => (
                <Field
                  key={key.name}
                  label={fromData(key.labelKey)}
                  htmlFor={`${fieldId}-${key.name}`}
                >
                  <Input
                    id={`${fieldId}-${key.name}`}
                    data-testid={`provider-config-${key.name}`}
                    type={key.secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    required={key.required && !key.secret}
                    aria-invalid={error?.configKey === key.name}
                    {...(key.secret ? { 'aria-describedby': `${fieldId}-${key.name}-status` } : {})}
                    value={draft.values[key.name] ?? ''}
                    onChange={(event) => edit(key.name, event.target.value)}
                  />
                  {key.secret ? (
                    <span
                      id={`${fieldId}-${key.name}-status`}
                      data-testid={`provider-status-${key.name}`}
                      className={
                        clearing(key, draft)
                          ? 'font-sans text-micro text-text-danger'
                          : 'font-sans text-micro text-text-muted'
                      }
                    >
                      {t(secretStatusKey(key, draft))}
                    </span>
                  ) : null}
                </Field>
              ))}

              {entry.models.length === 0 ? null : (
                <Field label={t('settings.providers.model')} htmlFor={`${fieldId}-model`}>
                  <Chooser
                    id={`${fieldId}-model`}
                    testId="model-select"
                    value={draft.modelId}
                    options={entry.models.map((model) => ({ value: model.id, label: model.id }))}
                    onChange={(modelId) =>
                      setDraft((current) =>
                        current === null
                          ? current
                          : { ...current, modelId, customModel: '', modelEdited: true },
                      )
                    }
                  />
                </Field>
              )}
              <Field
                label={t('settings.providers.customModel')}
                htmlFor={`${fieldId}-custom-model`}
              >
                <Input
                  id={`${fieldId}-custom-model`}
                  data-testid="model-custom"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${fieldId}-custom-model-hint`}
                  value={draft.customModel}
                  onChange={(event) => {
                    const customModel = event.target.value
                    setError(null)
                    setDraft((current) =>
                      current === null ? current : { ...current, customModel, modelEdited: true },
                    )
                  }}
                />
                <span
                  id={`${fieldId}-custom-model-hint`}
                  className="font-sans text-micro text-text-muted"
                >
                  {t('settings.providers.customModelHint')}
                </span>
              </Field>
            </form>
          )}
          {entries === null ? null : (
            <CustomVendorSection
              open={open}
              creating={creating}
              onCreatingChange={setCreating}
              onBusyChange={setSectionBusy}
            />
          )}
        </div>

        {error === null ? null : (
          <p
            role="alert"
            data-testid="provider-error"
            data-error-code={error.code}
            className="rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
          >
            {t(ERROR_KEY[error.code])}
          </p>
        )}

        <DialogFooter>
          <DialogClose
            render={
              <Button
                variant="outline"
                data-testid="provider-cancel"
                disabled={saving || sectionBusy}
              />
            }
          >
            {t('settings.providers.cancel')}
          </DialogClose>
          <Button
            type="submit"
            form={`${fieldId}-form`}
            data-testid="provider-save"
            disabled={saving || draft === null}
          >
            {t(saving ? 'settings.providers.saving' : 'settings.providers.save')}
          </Button>
        </DialogFooter>
      </div>
    </>
  )
  if (props.embedded) return content
  return (
    <Dialog
      open={open}
      // Not while a write is in flight: on an unsigned dev build the keychain raises an OS prompt,
      // and an Escape taken during it would discard the typed key with the save half done.
      onOpenChange={(next) => {
        if (saving || sectionBusy) return
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent
        data-testid="provider-settings"
        closeLabel={t('settings.providers.close')}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        {content}
      </DialogContent>
    </Dialog>
  )
}

/** Spec「国际化」: every code maps to a catalogue key, never to a sentence built here. */
const ERROR_KEY = {
  ...PROVIDER_WRITE_ERROR_KEY,
  'no-model': 'settings.providers.error.noModel',
  unavailable: 'settings.providers.error.unavailable',
} as const satisfies Record<CardErrorCode, string>

/** The credential to ask for first where a definition marks one; declaration order otherwise. */
function orderedKeys(
  keys: readonly ProviderConfigKeyContract[],
): readonly ProviderConfigKeyContract[] {
  return keys.toSorted((a, b) => Number(b.primary) - Number(a.primary))
}

/** A stored key the user has emptied: saving deletes it, so the field has to say so first. */
function clearing(key: ProviderConfigKeyContract, draft: Draft): boolean {
  return key.configured && draft.edited.includes(key.name) && (draft.values[key.name] ?? '') === ''
}

const SECRET_STATUS = {
  clearing: 'settings.providers.willRemove',
  stored: 'settings.providers.stored',
  none: 'settings.providers.notStored',
} as const

function secretStatusKey(
  key: ProviderConfigKeyContract,
  draft: Draft,
): (typeof SECRET_STATUS)[keyof typeof SECRET_STATUS] {
  if (clearing(key, draft)) return SECRET_STATUS.clearing
  return key.configured ? SECRET_STATUS.stored : SECRET_STATUS.none
}

/**
 * A card opened on a provider: the stored non-secret values or their declared defaults, secrets
 * empty, and the model `config.json` names for THIS provider — so looking at another provider and
 * coming back does not quietly rewrite the saved choice to whatever the table lists first. A saved
 * model the definition no longer offers falls back to the first row rather than showing one model
 * and saving another.
 */
function newDraft(
  entry: ProviderEntryContract,
  settings: Readonly<Record<string, Record<string, string>>>,
  saved: ProviderSelection | null,
): Draft {
  const stored = settings[entry.id] ?? {}
  const values: Record<string, string> = {}
  for (const key of entry.configKeys) {
    values[key.name] = key.secret ? '' : (stored[key.name] ?? key.default ?? '')
  }
  const named = saved?.id === entry.id ? saved.modelId : null
  const builtin = named !== null && entry.models.some((model) => model.id === named)
  const modelId = builtin ? named : (entry.models[0]?.id ?? '')
  return {
    providerId: entry.id,
    modelId,
    // A saved hand-typed id shows where it was typed.
    customModel: saved?.id === entry.id && saved.source === 'user' ? saved.modelId : '',
    modelEdited: false,
    values,
    edited: [],
    secretKeys: entry.configKeys.filter((key) => key.secret).map((key) => key.name),
  }
}

function withoutSecrets(draft: Draft): Draft {
  return {
    ...draft,
    values: Object.fromEntries(
      Object.entries(draft.values).map(([name, value]) => [
        name,
        draft.secretKeys.includes(name) ? '' : value,
      ]),
    ),
    edited: draft.edited.filter((name) => !draft.secretKeys.includes(name)),
  }
}
