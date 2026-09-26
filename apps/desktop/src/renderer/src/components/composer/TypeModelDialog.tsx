import type { ProviderEntryContract } from '@tenon-app/contracts'
import { useId, useState } from 'react'
import type { FormEvent, JSX } from 'react'
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

/**
 * 「手填模型 ID」 under 更多模型 › (spec 02 §表外模型与不发工具; M6, A15): a model the provider's table
 * does not list. It is recorded as the user's, its capabilities the conservative synthesis — so it
 * only ever holds a text conversation, which the dialog says before it is used.
 */
export function TypeModelDialog(props: {
  readonly entry: ProviderEntryContract | null
  readonly providerName: string
  readonly onClose: () => void
  readonly onUse: (modelId: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  // Starts empty each time: the menu remounts it per provider (its `key`).
  const [value, setValue] = useState('')
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const modelId = value.trim()
    if (modelId !== '') props.onUse(modelId)
  }
  return (
    <Dialog
      open={props.entry !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <DialogContent data-testid="type-model" closeLabel={t('model.typeDialog.close')}>
        <DialogHeader>
          <DialogTitle>{t('model.typeDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('model.typeDialog.description', { provider: props.providerName })}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`${id}-model`}
              className="font-sans text-ui-sm font-medium text-text-secondary"
            >
              {t('model.typeDialog.label')}
            </label>
            <Input
              id={`${id}-model`}
              data-testid="type-model-input"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" data-testid="type-model-cancel" />}>
              {t('model.typeDialog.cancel')}
            </DialogClose>
            <Button type="submit" data-testid="type-model-use" disabled={value.trim() === ''}>
              {t('model.typeDialog.use')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
