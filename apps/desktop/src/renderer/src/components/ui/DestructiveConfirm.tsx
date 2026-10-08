import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './alert-dialog'
export function DestructiveConfirm(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  busy: boolean
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('mcp.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('mcp.deleteNote', { name: props.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.busy}>{t('mcp.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="connector-delete-confirm"
            variant="destructive"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {t('mcp.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
