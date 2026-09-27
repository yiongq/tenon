import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

/**
 * Leaving a session while its Run is in progress (spec 02 §离开会话 第 1 条; B18): 「停止任务」 sends
 * `chat.stop` and then moves on; 「留在这里」 changes nothing and the task runs to its end. The four
 * entries that ask are the sidebar's new chat, the menu's New Chat, the banner's 「回去」 and the model
 * menu's 「用新模型开新会话」; a paused or idle session is left without asking.
 */
export function LeaveRunDialog(props: {
  readonly open: boolean
  readonly onStop: () => void
  readonly onStay: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onStay()
      }}
    >
      <AlertDialogContent data-testid="leave-run">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('leave.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('leave.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="leave-stay">{t('leave.stay')}</AlertDialogCancel>
          <Button variant="destructive" data-testid="leave-stop" onClick={props.onStop}>
            {t('leave.stop')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
