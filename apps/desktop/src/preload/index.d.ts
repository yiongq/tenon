import type { TenonBridge } from './index'

declare global {
  interface Window {
    tenon: TenonBridge
  }
}

export {}
