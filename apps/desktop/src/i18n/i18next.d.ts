import 'i18next'
import type { EnResources } from './resources.js'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: EnResources
    returnNull: false
  }
}
