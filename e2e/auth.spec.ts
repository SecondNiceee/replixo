import { expect, test } from '@playwright/test'
import { makeTestUser, openAuthDialog, signIn, signUp, type TestUser } from './helpers'

test.describe('Регистрация', () => {
  test('кнопка неактивна, пока не приняты соглашение и согласие', async ({ page }) => {
    const dialog = await signUp(page, makeTestUser('legal'), { acceptLegal: false })
    const submit = dialog.getByRole('button', { name: 'Создать аккаунт' })
    const boxes = dialog.getByRole('checkbox')

    await expect(submit).toBeDisabled()
    await boxes.nth(0).check()
    await expect(submit).toBeDisabled()
    await boxes.nth(1).check()
    await expect(submit).toBeEnabled()
  })

  test('некорректный username показывает ошибку', async ({ page }) => {
    const user = { ...makeTestUser('bad'), username: 'плохой ник' }
    const dialog = await signUp(page, user)
    await dialog.getByRole('button', { name: 'Создать аккаунт' }).click()

    await expect(dialog.getByRole('alert')).toHaveText(
      'Username может содержать только англ. буквы, цифры и _',
    )
    await expect(page).not.toHaveURL(/\/profile/)
  })

  test('новый преподаватель регистрируется и попадает в профиль', async ({ page }) => {
    const dialog = await signUp(page, makeTestUser('t'), { role: 'Преподаватель' })
    await dialog.getByRole('button', { name: 'Создать аккаунт' }).click()

    await expect(page).toHaveURL(/\/profile/)
  })
})

test.describe('Вход', () => {
  test.describe.configure({ mode: 'serial' })

  let user: TestUser

  test.beforeAll(async ({ browser }) => {
    user = makeTestUser('s')
    const page = await browser.newPage()
    const dialog = await signUp(page, user)
    await dialog.getByRole('button', { name: 'Создать аккаунт' }).click()
    await expect(page).toHaveURL(/\/profile/)
    await page.close()
  })

  test('повторная регистрация на ту же почту отклоняется', async ({ page }) => {
    const dialog = await signUp(page, { ...makeTestUser('dup'), email: user.email })
    await dialog.getByRole('button', { name: 'Создать аккаунт' }).click()

    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(page).not.toHaveURL(/\/profile/)
  })

  test('вход с неверным паролем показывает ошибку', async ({ page }) => {
    const dialog = await signIn(page, user.email, 'wrong-password-000')

    await expect(dialog.getByRole('alert')).toHaveText('Неверная почта или пароль')
    await expect(page).not.toHaveURL(/\/profile/)
  })

  test('вход с верными данными открывает профиль, почта без учёта регистра', async ({ page }) => {
    await signIn(page, user.email.toUpperCase(), user.password)
    await expect(page).toHaveURL(/\/profile/)

    await page.reload()
    await expect(page).toHaveURL(/\/profile/)
  })

  test('авторизованного пользователя /sign-in уводит в профиль', async ({ page }) => {
    await signIn(page, user.email, user.password)
    await expect(page).toHaveURL(/\/profile/)

    await page.goto('/sign-in')
    await expect(page).toHaveURL(/\/profile/)
  })
})

test.describe('Защищённые страницы', () => {
  test('гостя с /profile отправляет на попап входа', async ({ page }) => {
    await page.goto('/profile')
    await expect(page).toHaveURL(/auth=sign-in/)
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('/sign-up открывает попап регистрации', async ({ page }) => {
    await page.goto('/sign-up')
    await expect(page).toHaveURL(/auth=sign-up/)
    await openAuthDialog(page, 'sign-up')
  })
})
