import { expect, type Page } from '@playwright/test'

// Все тестовые аккаунты живут на этом домене — global-teardown удаляет их после прогона.
export const E2E_EMAIL_DOMAIN = 'replixo.test'
export const E2E_PASSWORD = 'e2e-Password-123'

export function makeTestUser(tag = 'u') {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return {
    username: `e2e_${tag}_${id}`.slice(0, 20),
    email: `e2e-${tag}-${id}@${E2E_EMAIL_DOMAIN}`,
    password: E2E_PASSWORD,
  }
}

export type TestUser = ReturnType<typeof makeTestUser>

export async function openAuthDialog(page: Page, mode: 'sign-in' | 'sign-up') {
  await page.goto(`/?auth=${mode}`)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('heading', { name: mode === 'sign-up' ? 'Создать аккаунт' : 'Добро пожаловать' }),
  ).toBeVisible()
  return dialog
}

export async function signUp(
  page: Page,
  user: TestUser,
  options: { role?: 'Ученик' | 'Преподаватель'; acceptLegal?: boolean } = {},
) {
  const { role = 'Ученик', acceptLegal = true } = options
  const dialog = await openAuthDialog(page, 'sign-up')

  await dialog.getByRole('radio', { name: role }).click()
  await dialog.getByLabel('Username').fill(user.username)
  await dialog.getByLabel('Почта').fill(user.email)
  await dialog.getByLabel('Пароль').fill(user.password)

  if (acceptLegal) {
    const boxes = dialog.getByRole('checkbox')
    await boxes.nth(0).check()
    await boxes.nth(1).check()
  }

  return dialog
}

export async function signIn(page: Page, email: string, password: string) {
  const dialog = await openAuthDialog(page, 'sign-in')
  await dialog.getByLabel('Почта').fill(email)
  await dialog.getByLabel('Пароль').fill(password)
  await dialog.getByRole('button', { name: 'Войти', exact: true }).click()
  return dialog
}
