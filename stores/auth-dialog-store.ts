import { create } from 'zustand'

export type AuthMode = 'sign-in' | 'sign-up'

interface AuthDialogState {
  mode: AuthMode | null
  open: (mode: AuthMode) => void
  close: () => void
}

// Один стор на всё приложение: диалог открывают из шапки, из «Нет аккаунта? →»
// внутри самой формы и из ?auth= в адресе, а живёт он в одном месте.
export const useAuthDialog = create<AuthDialogState>((set) => ({
  mode: null,
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),
}))
