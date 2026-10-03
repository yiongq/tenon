import {
  customVendorCancelProbe,
  customVendorCreate,
  customVendorDelete,
  customVendorFetchModels,
  customVendorList,
  customVendorProbe,
  customVendorUpdate,
  invokeRoute,
  providerConfigure,
  providerList,
} from '@tenon-app/contracts'
import type {
  CustomVendorContract,
  ProviderEntryContract,
  RouteResponse,
} from '@tenon-app/contracts'
import { ChevronDownIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  FETCH_MODELS_KEY,
  KEY_REMINDER_KEY,
  PROBE_REFUSED_KEY,
  VENDOR_ERROR_KEY,
  draftOf,
  keyReminderOf,
  probeLineOf,
  rowOf,
  withRow,
  withoutRow,
} from '@/lib/custom-vendor'
import type { FetchedModel, RowDraft } from '@/lib/custom-vendor'
import { PROVIDER_WRITE_ERROR_KEY, REFUSAL_KEY } from '@/lib/provider-copy'
import { tx } from '@/lib/tx'
import { Chooser, Field } from './fields'

/**
 * The settings card's instance section (M6 §预设, §地址校验, §key, §列表与上限, §探测, §运行时「搜索」):
 * the custom vendor instances and the form that creates one.
 *
 *   - Creating: a preset — its region and wire chosen, its address shown read-only (推出的读法 6) — or
 *     「其他兼容端点」 with an address and a wire typed. Main looks a preset's address up by its ids
 *     (§IPC), so nothing here can hand in an address of its own. A host whose address is shared with
 *     a subscription carries its pay-as-you-go reminder under the key (Q13; 验收 7).
 *   - An instance: its name, its address and wire (fixed: T2), its key — saved through
 *     `provider.configure`, which clears every probe of it (T3) — and its model rows. A row is typed
 *     or picked from 「获取模型列表」, which only prefills (T6, T7); both limits are required. Each row
 *     of a public instance has 「探测」 with the request count beside it (T4) and, while it runs,
 *     「取消」 (`customVendor.cancelProbe`); a loopback or private one has none (Q7).
 *   - The section says once that a custom vendor has no web search (Q10).
 *
 * Every write here is its own route and takes effect at once; the card's Save button belongs to the
 * builtin form above. A typed key lives no longer than the card: every opening and closing remounts
 * the forms empty.
 */

type Listing = RouteResponse<typeof customVendorList>
type Preset = Listing['presets'][number]
type Instance = Listing['instances'][number]
type Wire = CustomVendorContract['wire']
type Row = CustomVendorContract['models'][number]

const WIRES: readonly Wire[] = ['openai-chat', 'anthropic-messages']

const WIRE_KEY = {
  'openai-chat': 'customVendor.wire.openai-chat',
  'anthropic-messages': 'customVendor.wire.anthropic-messages',
} as const satisfies Record<Wire, string>

/** The source chooser's 「其他兼容端点」: no preset id is empty. */
const OTHER = ''

/** A line under a control: a catalogue key that arrives as data, with its slots. */
interface Note {
  readonly key: string
  readonly values?: Readonly<Record<string, string>>
}

const UNAVAILABLE: Note = { key: 'customVendor.error.unavailable' }

/** Module scope on purpose: an effect that depends on it must not re-run every render. */
async function readSection(): Promise<{
  listing: Listing
  entries: readonly ProviderEntryContract[]
} | null> {
  const [listing, providers] = await Promise.all([
    invokeRoute(window.tenon, customVendorList, {}),
    invokeRoute(window.tenon, providerList, {}),
  ])
  if (!listing.ok || !providers.ok) return null
  return {
    listing: listing.data,
    entries: providers.data.filter((entry) => entry.displayName !== undefined),
  }
}

export function CustomVendorSection(props: {
  /** The card is open: every opening reads the instances afresh. */
  readonly open: boolean
  /** The create form shows; the builtin's 「新建自定义厂商」 opens it too (§点名 (b)). */
  readonly creating: boolean
  readonly onCreatingChange: (creating: boolean) => void
  /** A write is in flight: on an unsigned build the keychain may be asking, so the card stays. */
  readonly onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const { open, creating, onCreatingChange, onBusyChange } = props
  const { t } = useTranslation()
  const headingId = useId()
  const [listing, setListing] = useState<Listing | null>(null)
  const [entries, setEntries] = useState<readonly ProviderEntryContract[]>([])
  const [failed, setFailed] = useState(false)
  // Bumped on every opening and closing, while rendering (React's「adjusting state when a prop
  // changes」): the forms remount empty, so a typed key lives no longer than the card.
  const [generation, setGeneration] = useState(0)
  const [shownOpen, setShownOpen] = useState(open)
  if (shownOpen !== open) {
    setShownOpen(open)
    setGeneration((value) => value + 1)
  }
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [writes, setWrites] = useState(0)

  useEffect(() => {
    if (!open) return
    void readSection().then((read) => {
      if (read === null) {
        setFailed(true)
        return
      }
      setFailed(false)
      setListing(read.listing)
      setEntries(read.entries)
      // One instance opens expanded; several start folded, each a line of its own.
      setExpanded(read.listing.instances.length === 1 ? [read.listing.instances[0]?.id ?? ''] : [])
    })
  }, [open])

  useEffect(() => onBusyChange(writes > 0), [writes, onBusyChange])

  const reload = async (): Promise<void> => {
    const read = await readSection()
    if (read === null) {
      setFailed(true)
      return
    }
    setFailed(false)
    setListing(read.listing)
    setEntries(read.entries)
  }

  const busyWhile = async <T,>(work: () => Promise<T>): Promise<T> => {
    setWrites((value) => value + 1)
    try {
      return await work()
    } finally {
      setWrites((value) => value - 1)
    }
  }

  const toggle = (id: string): void =>
    setExpanded((was) => (was.includes(id) ? was.filter((other) => other !== id) : [...was, id]))

  return (
    <section
      aria-labelledby={headingId}
      data-testid="custom-vendors"
      className="flex flex-col gap-3 border-t border-border-subtle pt-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="font-sans text-ui font-medium text-text-primary">
          {t('customVendor.section.title')}
        </h3>
        <p data-testid="custom-vendors-no-search" className="font-sans text-micro text-text-muted">
          {t('customVendor.section.noSearch')}
        </p>
      </div>
      {failed ? (
        <p
          role="alert"
          data-testid="custom-vendors-error"
          className="rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
        >
          {t('customVendor.error.unavailable')}
        </p>
      ) : null}
      {listing?.instances.map((instance) => (
        <InstanceCard
          key={`${instance.id}-${generation}`}
          instance={instance}
          entry={entries.find((entry) => entry.id === instance.id)}
          presets={listing.presets}
          expanded={expanded.includes(instance.id)}
          onToggle={() => toggle(instance.id)}
          onChanged={reload}
          busyWhile={busyWhile}
        />
      ))}
      {creating && listing !== null ? (
        <CreateForm
          key={`create-${generation}`}
          presets={listing.presets}
          busyWhile={busyWhile}
          onCancel={() => onCreatingChange(false)}
          onCreated={async (id) => {
            onCreatingChange(false)
            setExpanded((was) => [...was, id])
            await reload()
          }}
        />
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="custom-vendor-new"
            disabled={listing === null}
            onClick={() => onCreatingChange(true)}
          >
            {t('customVendor.create.open')}
          </Button>
        </div>
      )}
    </section>
  )
}

type BusyWhile = <T>(work: () => Promise<T>) => Promise<T>

/** 「新建自定义厂商」 (§IPC `customVendor.create`): a preset's region and wire, or an address typed. */
function CreateForm(props: {
  readonly presets: readonly Preset[]
  readonly busyWhile: BusyWhile
  readonly onCancel: () => void
  readonly onCreated: (id: string) => Promise<void>
}): JSX.Element {
  const { presets, busyWhile } = props
  const { t } = useTranslation()
  const fromData = (key: string): string => t(key as never)
  const id = useId()
  const first = presets[0]
  const [source, setSource] = useState(first?.id ?? OTHER)
  const [regionId, setRegionId] = useState(first?.regions[0]?.id ?? '')
  const [wire, setWire] = useState<Wire>(first?.defaultWire ?? 'openai-chat')
  const [baseURL, setBaseURL] = useState('')
  const [name, setName] = useState(first === undefined ? '' : fromData(first.nameKey))
  const [named, setNamed] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<Note | null>(null)
  const [pending, setPending] = useState(false)
  const sourceRef = useRef<HTMLSelectElement | null>(null)

  // Opened from the builtin's refusal too: the form is below the fold then, and focus brings it in.
  useEffect(() => sourceRef.current?.focus(), [])

  const preset = presets.find((candidate) => candidate.id === source)
  const region =
    preset?.regions.find((candidate) => candidate.id === regionId) ?? preset?.regions[0]
  const wires =
    preset === undefined ? WIRES : WIRES.filter((w) => region?.endpoints[w] !== undefined)
  const chosenWire = wires.includes(wire) ? wire : (wires[0] ?? wire)
  const address = preset === undefined ? baseURL : (region?.endpoints[chosenWire] ?? '')

  const chooseSource = (next: string): void => {
    const nextPreset = presets.find((candidate) => candidate.id === next)
    setSource(next)
    setRegionId(nextPreset?.regions[0]?.id ?? '')
    setWire(nextPreset?.defaultWire ?? 'openai-chat')
    if (!named) setName(nextPreset === undefined ? '' : fromData(nextPreset.nameKey))
    setError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const displayName = name.trim()
    if (displayName === '') return setError({ key: 'customVendor.error.name' })
    if (preset === undefined && baseURL.trim() === '') {
      return setError({ key: VENDOR_ERROR_KEY['invalid-address'] })
    }
    setPending(true)
    setError(null)
    try {
      const created = await busyWhile(() =>
        invokeRoute(window.tenon, customVendorCreate, {
          displayName,
          wire: chosenWire,
          source:
            preset === undefined
              ? { kind: 'custom', baseURL: baseURL.trim() }
              : { kind: 'preset', presetId: preset.id, regionId: region?.id ?? '' },
          apiKey,
        }),
      )
      if (!created.ok) return setError(UNAVAILABLE)
      if (!created.data.ok) return setError({ key: VENDOR_ERROR_KEY[created.data.code] })
      setApiKey('')
      await props.onCreated(created.data.id)
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      data-testid="custom-vendor-create"
      aria-busy={pending}
      className="flex flex-col gap-3 rounded-lg border border-border-subtle p-3"
      onSubmit={(event) => void submit(event)}
    >
      <Field label={t('customVendor.field.source')} htmlFor={`${id}-source`}>
        <Chooser
          id={`${id}-source`}
          testId="custom-vendor-new-source"
          inputRef={sourceRef}
          value={source}
          options={[
            ...presets.map((candidate) => ({
              value: candidate.id,
              label: fromData(candidate.nameKey),
            })),
            { value: OTHER, label: t('customVendor.create.other') },
          ]}
          onChange={chooseSource}
        />
      </Field>
      {preset === undefined ? null : (
        <Field label={t('customVendor.field.region')} htmlFor={`${id}-region`}>
          <Chooser
            id={`${id}-region`}
            testId="custom-vendor-new-region"
            value={region?.id ?? ''}
            options={preset.regions.map((candidate) => ({
              value: candidate.id,
              label: fromData(candidate.labelKey),
            }))}
            onChange={(next) => {
              setRegionId(next)
              setError(null)
            }}
          />
        </Field>
      )}
      <Field label={t('customVendor.field.wire')} htmlFor={`${id}-wire`}>
        <Chooser
          id={`${id}-wire`}
          testId="custom-vendor-new-wire"
          value={chosenWire}
          options={wires.map((candidate) => ({ value: candidate, label: t(WIRE_KEY[candidate]) }))}
          onChange={(next) => {
            const picked = WIRES.find((candidate) => candidate === next)
            if (picked !== undefined) setWire(picked)
            setError(null)
          }}
        />
      </Field>
      {preset === undefined ? (
        <Field label={t('customVendor.field.address')} htmlFor={`${id}-address`}>
          <Input
            id={`${id}-address`}
            data-testid="custom-vendor-new-baseurl"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            value={baseURL}
            onChange={(event) => {
              setBaseURL(event.target.value)
              setError(null)
            }}
          />
          <span className="font-sans text-micro text-text-muted">
            {t('customVendor.create.fixed')}
          </span>
        </Field>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-ui-sm font-medium text-text-secondary">
            {t('customVendor.field.address')}
          </span>
          <p
            data-testid="custom-vendor-new-address"
            className="font-sans text-ui-sm break-all text-text-primary"
          >
            {address}
          </p>
          <span className="font-sans text-micro text-text-muted">
            {t('customVendor.create.presetAddress')}
          </span>
        </div>
      )}
      <Field label={t('customVendor.field.name')} htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          data-testid="custom-vendor-new-name"
          autoComplete="off"
          maxLength={64}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setNamed(true)
            setError(null)
          }}
        />
      </Field>
      <Field label={t('customVendor.field.key')} htmlFor={`${id}-key`}>
        <Input
          id={`${id}-key`}
          data-testid="custom-vendor-new-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value)
            setError(null)
          }}
        />
        <KeyReminder address={address} testId="custom-vendor-new-reminder" />
        {region?.keyPageURL == null ? null : (
          <a
            href={region.keyPageURL}
            target="_blank"
            rel="noreferrer"
            data-testid="custom-vendor-new-key-page"
            className="self-start font-sans text-micro text-text-accent underline-offset-4 hover:underline"
          >
            {t('customVendor.create.keyPage')}
          </a>
        )}
      </Field>
      {error === null ? null : (
        <p
          role="alert"
          data-testid="custom-vendor-new-error"
          data-message={error.key}
          className="rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
        >
          {tx(t, error.key, error.values)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="custom-vendor-new-cancel"
          disabled={pending}
          onClick={props.onCancel}
        >
          {t('customVendor.create.cancel')}
        </Button>
        <Button type="submit" size="sm" data-testid="custom-vendor-new-submit" disabled={pending}>
          {t(pending ? 'customVendor.create.creating' : 'customVendor.create.submit')}
        </Button>
      </div>
    </form>
  )
}

/** Q13's pay-as-you-go reminder under a key field, for the hosts §地址校验 names (验收 7). */
function KeyReminder(props: {
  readonly address: string
  readonly testId: string
}): JSX.Element | null {
  const { t } = useTranslation()
  const reminder = keyReminderOf(props.address)
  if (reminder === null) return null
  return (
    <span
      data-testid={props.testId}
      data-reminder={reminder}
      className="font-sans text-micro text-text-warning"
    >
      {t(KEY_REMINDER_KEY[reminder])}
    </span>
  )
}

const OUTCOME_CLASS = {
  passed: 'text-text-success',
  'not-detected': 'text-text-warning',
  failed: 'text-text-danger',
  none: 'text-text-muted',
} as const

const EMPTY_ROW: RowDraft = { id: '', contextLimit: '', maxOutputTokens: '' }

function without(notes: Readonly<Record<string, Note>>, modelId: string): Record<string, Note> {
  return Object.fromEntries(Object.entries(notes).filter(([id]) => id !== modelId))
}

/** One instance: its name, fixed address, key, model rows and their probes, and 「删除」. */
function InstanceCard(props: {
  readonly instance: Instance
  /** Its `provider.list` entry: whether a key is stored, and where the address points. */
  readonly entry: ProviderEntryContract | undefined
  readonly presets: readonly Preset[]
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onChanged: () => Promise<void>
  readonly busyWhile: BusyWhile
}): JSX.Element {
  const { instance, entry, expanded, busyWhile, onChanged } = props
  const { t } = useTranslation()
  const fromData = (key: string): string => t(key as never)
  const id = useId()
  const vendor = instance.id
  const [name, setName] = useState(instance.displayName)
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [draft, setDraft] = useState<RowDraft>(EMPTY_ROW)
  const [fetched, setFetched] = useState<readonly FetchedModel[] | null>(null)
  const [fetching, setFetching] = useState(false)
  /** The row being probed; one per instance at a time (§何时、走哪条路). */
  const [running, setRunning] = useState<string | null>(null)
  /**
   * The row whose 「探测」 answered `busy`: a probe this card did not start — the card can close while
   * one runs (only writes hold it open), and reopening it forgets that probe. It still runs in main
   * with no time limit, so §何时、走哪条路's 「取消」 shows on this row; `customVendor.cancelProbe`
   * needs only the instance.
   */
  const [stray, setStray] = useState<string | null>(null)
  /** What a probe answered that the stored snapshot does not show: a refusal, a result not saved. */
  const [notes, setNotes] = useState<Readonly<Record<string, Note>>>({})
  const [message, setMessage] = useState<Note | null>(null)
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // Q7: a loopback or private instance is never probed. Unknown until `provider.list` answers;
  // main refuses such a probe with `local-endpoint` anyway.
  const local = entry !== undefined && entry.endpoint.reach !== 'public'
  const keyStored = entry?.configKeys.find((candidate) => candidate.secret)?.configured === true
  const clearing = keyEdited && key === '' && keyStored
  const preset = props.presets.find((candidate) => candidate.id === instance.presetId)

  /** A write, with the card held open while it lasts; its refusal lands in `message`. */
  const write = async (work: () => Promise<Note | null>): Promise<boolean> => {
    setPending(true)
    setMessage(null)
    try {
      const problem = await busyWhile(work)
      setMessage(problem)
      if (problem === null) await onChanged()
      return problem === null
    } finally {
      setPending(false)
    }
  }

  const sendRows = (models: ReturnType<typeof withRow>): Promise<Note | null> =>
    invokeRoute(window.tenon, customVendorUpdate, { id: vendor, models }).then((answer) =>
      !answer.ok
        ? UNAVAILABLE
        : answer.data.ok
          ? null
          : { key: VENDOR_ERROR_KEY[answer.data.code] },
    )

  const rename = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const displayName = name.trim()
    if (displayName === '') return setMessage({ key: 'customVendor.error.name' })
    await write(() =>
      invokeRoute(window.tenon, customVendorUpdate, { id: vendor, displayName }).then((answer) =>
        !answer.ok
          ? UNAVAILABLE
          : answer.data.ok
            ? null
            : { key: VENDOR_ERROR_KEY[answer.data.code] },
      ),
    )
  }

  /** §key: through `provider.configure`, which clears every probe of the instance first (T3). */
  const saveKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!keyEdited) return
    const saved = await write(() =>
      invokeRoute(window.tenon, providerConfigure, {
        id: vendor,
        values: { apiKey: key },
      }).then((answer) =>
        !answer.ok
          ? UNAVAILABLE
          : answer.data.ok
            ? null
            : { key: PROVIDER_WRITE_ERROR_KEY[answer.data.code] },
      ),
    )
    if (saved) {
      setKey('')
      setKeyEdited(false)
      setNotes({})
      // Saving the key aborts any probe of the instance, a stray one too (§何时、走哪条路).
      setStray(null)
    }
  }

  /** T7: the only request to /models, and only now; what it finds only prefills (T6). */
  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    setMessage(null)
    try {
      const answer = await invokeRoute(window.tenon, customVendorFetchModels, { id: vendor })
      if (!answer.ok) return setMessage(UNAVAILABLE)
      if (!answer.data.ok) return setMessage({ key: FETCH_MODELS_KEY[answer.data.code] })
      if (answer.data.models.length === 0) {
        setFetched(null)
        return setMessage({ key: 'customVendor.models.fetchEmpty' })
      }
      setFetched(answer.data.models)
    } finally {
      setFetching(false)
    }
  }

  const saveRow = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const checked = rowOf(draft)
    if (!checked.ok) {
      return setMessage({
        key:
          checked.problem === 'id'
            ? 'customVendor.models.invalid.id'
            : 'customVendor.models.invalid.limits',
      })
    }
    if (await write(() => sendRows(withRow(instance.models, checked.row)))) setDraft(EMPTY_ROW)
  }

  const removeRow = (modelId: string): Promise<boolean> =>
    write(() => sendRows(withoutRow(instance.models, modelId)))

  const probe = async (modelId: string): Promise<void> => {
    setRunning(modelId)
    setNotes((was) => without(was, modelId))
    try {
      const answer = await invokeRoute(window.tenon, customVendorProbe, { id: vendor, modelId })
      // A result stored shows as the row's snapshot once the listing is read again; what else the
      // probe answered — a refusal, `aborted`, a result main could not keep — shows beside it.
      const note: Note | null = !answer.ok
        ? UNAVAILABLE
        : answer.data.status === 'refused'
          ? { key: PROBE_REFUSED_KEY[answer.data.code] }
          : answer.data.saved
            ? null
            : { key: 'customVendor.probe.notSaved' }
      if (note !== null) setNotes((was) => ({ ...was, [modelId]: note }))
      if (answer.ok && answer.data.status === 'refused' && answer.data.code === 'busy') {
        setStray(modelId)
      }
      await onChanged()
    } finally {
      setRunning(null)
    }
  }

  const cancelProbe = async (): Promise<void> => {
    if (stray === null) {
      // This card's own probe: its answer reports what happened — `aborted`, or its result when
      // it was already being stored (`cancelled: false`).
      void invokeRoute(window.tenon, customVendorCancelProbe, { id: vendor })
      return
    }
    // A stray probe's answer goes to nobody here, so the cancel's own answer tells: stopped and
    // not saved, or already over — its result, if kept, shows once the listing is read again.
    const modelId = stray
    const answer = await invokeRoute(window.tenon, customVendorCancelProbe, { id: vendor })
    if (!answer.ok) return setNotes((was) => ({ ...was, [modelId]: UNAVAILABLE }))
    setStray(null)
    setNotes((was) =>
      answer.data.cancelled
        ? { ...was, [modelId]: { key: PROBE_REFUSED_KEY.aborted } }
        : without(was, modelId),
    )
    await onChanged()
  }

  const remove = async (): Promise<void> => {
    setConfirming(false)
    await write(() =>
      invokeRoute(window.tenon, customVendorDelete, { id: vendor }).then((answer) =>
        !answer.ok
          ? UNAVAILABLE
          : answer.data.ok
            ? null
            : { key: VENDOR_ERROR_KEY[answer.data.code] },
      ),
    )
  }

  return (
    <div
      data-testid={`custom-vendor-${vendor}`}
      className="flex flex-col gap-3 rounded-lg border border-border-subtle p-3"
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-testid={`custom-vendor-toggle-${vendor}`}
        onClick={props.onToggle}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-sans text-ui font-medium text-text-primary">
            {instance.displayName}
          </span>
          <span className="truncate font-sans text-micro text-text-muted">
            {t('customVendor.instance.summary', {
              wire: t(WIRE_KEY[instance.wire]),
              address: instance.baseURL,
            })}
          </span>
        </span>
        <ChevronDownIcon
          className={`mt-0.5 size-4 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {instance.refused === undefined ? null : (
        <p
          data-testid={`custom-vendor-refused-${vendor}`}
          data-refusal-code={instance.refused.code}
          className="rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
        >
          {t(REFUSAL_KEY[instance.refused.code])}
        </p>
      )}

      {expanded ? (
        <>
          <form className="flex flex-col gap-1.5" onSubmit={(event) => void rename(event)}>
            <Field label={t('customVendor.field.name')} htmlFor={`${id}-name`}>
              <div className="flex gap-2">
                <Input
                  id={`${id}-name`}
                  data-testid={`custom-vendor-name-${vendor}`}
                  autoComplete="off"
                  maxLength={64}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                {name.trim() === instance.displayName ? null : (
                  <Button
                    type="submit"
                    variant="outline"
                    data-testid={`custom-vendor-rename-${vendor}`}
                    disabled={pending}
                  >
                    {t('customVendor.instance.rename')}
                  </Button>
                )}
              </div>
            </Field>
          </form>

          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-ui-sm font-medium text-text-secondary">
              {t('customVendor.field.address')}
            </span>
            <p
              data-testid={`custom-vendor-address-${vendor}`}
              className="font-sans text-ui-sm break-all text-text-primary"
            >
              {instance.baseURL}
            </p>
            <span className="font-sans text-micro text-text-muted">
              {preset === undefined
                ? t('customVendor.instance.addressFixed')
                : t('customVendor.instance.fromPreset', { preset: fromData(preset.nameKey) })}
            </span>
          </div>

          <form className="flex flex-col gap-1.5" onSubmit={(event) => void saveKey(event)}>
            <Field label={t('customVendor.field.key')} htmlFor={`${id}-key`}>
              <div className="flex gap-2">
                <Input
                  id={`${id}-key`}
                  data-testid={`custom-vendor-key-${vendor}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${id}-key-status`}
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value)
                    setKeyEdited(true)
                  }}
                />
                <Button
                  type="submit"
                  variant="outline"
                  data-testid={`custom-vendor-key-save-${vendor}`}
                  disabled={pending || !keyEdited || (key === '' && !keyStored)}
                >
                  {t('customVendor.key.save')}
                </Button>
              </div>
              <span
                id={`${id}-key-status`}
                data-testid={`custom-vendor-key-status-${vendor}`}
                className={
                  clearing
                    ? 'font-sans text-micro text-text-danger'
                    : 'font-sans text-micro text-text-muted'
                }
              >
                {t(
                  clearing
                    ? 'settings.providers.willRemove'
                    : keyStored
                      ? 'settings.providers.stored'
                      : 'settings.providers.notStored',
                )}
              </span>
              <KeyReminder address={instance.baseURL} testId={`custom-vendor-reminder-${vendor}`} />
              <span className="font-sans text-micro text-text-muted">
                {t('customVendor.key.clearsProbes')}
              </span>
            </Field>
          </form>

          <div className="flex flex-col gap-2">
            <span className="font-sans text-ui-sm font-medium text-text-secondary">
              {t('customVendor.field.models')}
            </span>
            <p
              id={`${id}-probe-cost`}
              data-testid={`custom-vendor-probe-note-${vendor}`}
              className="font-sans text-micro text-text-muted"
            >
              {t(local ? 'customVendor.probe.local' : 'customVendor.probe.cost')}
            </p>
            {instance.models.length === 0 ? (
              <p className="font-sans text-ui-sm text-text-muted">
                {t('customVendor.models.none')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {instance.models.map((row) => (
                  <ModelRow
                    key={row.id}
                    vendor={vendor}
                    row={row}
                    local={local}
                    running={running}
                    stray={stray}
                    pending={pending}
                    note={notes[row.id]}
                    costId={`${id}-probe-cost`}
                    onProbe={() => void probe(row.id)}
                    onCancel={() => void cancelProbe()}
                    onEdit={() =>
                      setDraft({
                        id: row.id,
                        contextLimit: String(row.contextLimit),
                        maxOutputTokens: String(row.maxOutputTokens),
                      })
                    }
                    onRemove={() => void removeRow(row.id)}
                  />
                ))}
              </ul>
            )}
          </div>

          <form
            data-testid={`custom-vendor-row-form-${vendor}`}
            className="flex flex-col gap-2 rounded-sm border border-border-subtle p-2"
            onSubmit={(event) => void saveRow(event)}
          >
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`custom-vendor-fetch-${vendor}`}
                disabled={fetching || pending}
                onClick={() => void fetchModels()}
              >
                {t(fetching ? 'customVendor.models.fetching' : 'customVendor.models.fetch')}
              </Button>
            </div>
            {fetched === null ? null : (
              <Field label={t('customVendor.models.fromList')} htmlFor={`${id}-fetched`}>
                <Chooser
                  id={`${id}-fetched`}
                  testId={`custom-vendor-fetched-${vendor}`}
                  value={fetched.some((model) => model.id === draft.id) ? draft.id : ''}
                  options={[
                    { value: '', label: t('customVendor.models.pick') },
                    ...fetched.map((model) => ({ value: model.id, label: model.id })),
                  ]}
                  onChange={(next) => {
                    const model = fetched.find((candidate) => candidate.id === next)
                    if (model !== undefined) setDraft(draftOf(model))
                  }}
                />
              </Field>
            )}
            <Field label={t('customVendor.models.id')} htmlFor={`${id}-row-id`}>
              <Input
                id={`${id}-row-id`}
                data-testid={`custom-vendor-row-id-${vendor}`}
                autoComplete="off"
                spellCheck={false}
                value={draft.id}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('customVendor.models.contextLimit')} htmlFor={`${id}-row-context`}>
                <Input
                  id={`${id}-row-context`}
                  data-testid={`custom-vendor-row-context-${vendor}`}
                  autoComplete="off"
                  inputMode="numeric"
                  value={draft.contextLimit}
                  onChange={(event) => setDraft({ ...draft, contextLimit: event.target.value })}
                />
              </Field>
              <Field label={t('customVendor.models.maxOutputTokens')} htmlFor={`${id}-row-output`}>
                <Input
                  id={`${id}-row-output`}
                  data-testid={`custom-vendor-row-output-${vendor}`}
                  autoComplete="off"
                  inputMode="numeric"
                  value={draft.maxOutputTokens}
                  onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value })}
                />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans text-micro text-text-muted">
                {t('customVendor.models.limitsHint')}
              </span>
              <Button
                type="submit"
                size="sm"
                data-testid={`custom-vendor-row-save-${vendor}`}
                disabled={pending}
              >
                {t('customVendor.models.save')}
              </Button>
            </div>
          </form>

          {message === null ? null : (
            <p
              role="alert"
              data-testid={`custom-vendor-message-${vendor}`}
              data-message={message.key}
              className="rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
            >
              {tx(t, message.key, message.values)}
            </p>
          )}

          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans text-micro text-text-danger">
                {t('customVendor.instance.deleteWarning')}
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid={`custom-vendor-delete-confirm-${vendor}`}
                disabled={pending}
                onClick={() => void remove()}
              >
                {t('customVendor.instance.deleteConfirm')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`custom-vendor-delete-keep-${vendor}`}
                onClick={() => setConfirming(false)}
              >
                {t('customVendor.instance.keep')}
              </Button>
            </div>
          ) : (
            <div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid={`custom-vendor-delete-${vendor}`}
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                {t('customVendor.instance.delete')}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}

/** One model row: its limits, its stored probe, and 「探测」 / 「取消」 beside the request count. */
function ModelRow(props: {
  readonly vendor: string
  readonly row: Row
  readonly local: boolean
  readonly running: string | null
  /** The row a stray probe's `busy` answered on: 「取消」 shows here (InstanceCard's `stray`). */
  readonly stray: string | null
  readonly pending: boolean
  readonly note: Note | undefined
  readonly costId: string
  readonly onProbe: () => void
  readonly onCancel: () => void
  readonly onEdit: () => void
  readonly onRemove: () => void
}): JSX.Element {
  const { vendor, row, local, running, stray } = props
  const probing = running === row.id
  const { t, i18n } = useTranslation()
  const line = probeLineOf(row.probe)
  const outcome = row.probe?.outcome ?? 'none'
  const testId = `${vendor}-${row.id}`
  return (
    <li
      data-testid={`custom-vendor-row-${testId}`}
      className="flex flex-col gap-1 rounded-sm border border-border-subtle px-2 py-1.5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-sans text-ui-sm text-text-primary">{row.id}</span>
        <span className="shrink-0 font-sans text-micro text-text-muted">
          {t('customVendor.models.limits', {
            // Not `context`: that is i18next's own option, which picks a key variant.
            contextTokens: row.contextLimit.toLocaleString(i18n.language),
            outputTokens: row.maxOutputTokens.toLocaleString(i18n.language),
          })}
        </span>
      </div>
      {local ? null : (
        <p
          data-testid={`custom-vendor-probe-status-${testId}`}
          data-outcome={outcome}
          className={`font-sans text-micro ${OUTCOME_CLASS[outcome]}`}
        >
          {tx(t, line.key, line.fields === undefined ? undefined : { fields: line.fields })}
        </p>
      )}
      {props.note === undefined ? null : (
        <p
          data-testid={`custom-vendor-probe-answer-${testId}`}
          data-message={props.note.key}
          className="font-sans text-micro text-text-warning"
        >
          {tx(t, props.note.key, props.note.values)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {local ? null : probing || stray === row.id ? (
          <>
            {probing ? (
              <span
                data-testid={`custom-vendor-probing-${testId}`}
                className="font-sans text-micro text-text-muted"
              >
                {t('customVendor.probe.running')}
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`custom-vendor-cancel-${testId}`}
              onClick={props.onCancel}
            >
              {t('customVendor.probe.cancel')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`custom-vendor-probe-${testId}`}
            aria-describedby={props.costId}
            disabled={running !== null || stray !== null || props.pending}
            onClick={props.onProbe}
          >
            {t('customVendor.probe.run')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={`custom-vendor-row-edit-${testId}`}
          disabled={props.pending}
          onClick={props.onEdit}
        >
          {t('customVendor.models.edit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={`custom-vendor-row-remove-${testId}`}
          disabled={props.pending || probing || stray === row.id}
          onClick={props.onRemove}
        >
          {t('customVendor.models.remove')}
        </Button>
      </div>
    </li>
  )
}
