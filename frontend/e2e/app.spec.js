import { expect, test } from '@playwright/test'
import { addPerson, call, ownerToken, signInAs, signUp, unique, watchErrors } from './helpers'

test.describe('signing up and in', () => {
  test('a new company signs up and lands on its dashboard', async ({ page }) => {
    const errors = watchErrors(page)
    const username = unique('new')
    await page.goto('/')
    await expect(page).toHaveURL(/\/welcome$/)
    await page.getByRole('link', { name: 'Start free trial' }).first().click()
    await page.getByLabel('Company or team name').fill('Playwright Ltd')
    await page.getByLabel('Your name').fill('Pat Wright')
    await page.getByLabel('Work email').fill(`${username}@example.com`)
    await page.getByLabel('Username').fill(username)
    await page.locator('input[autocomplete="new-password"]').fill('Secret#123')
    const start = page.getByRole('button', { name: 'Start free trial' })
    await page.getByRole('checkbox').check()
    await start.click()
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Pat/ })).toBeVisible()
    await expect(page.getByText('Get started')).toBeVisible()
    await expect(page.getByText('Your free trial ends in 14 days.')).toBeVisible()
    errors.check()
  })

  test('signing in with a wrong and then the right password', async ({ page, request }) => {
    const ws = await signUp(request)
    await page.goto('/login')
    await page.getByLabel('Username or email').fill(ws.username)
    const password = page.locator('input[autocomplete="current-password"]')
    await password.fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Incorrect username or password')).toBeVisible()
    await password.fill(ws.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/(login|welcome)$/)
  })
})

test.describe('stage sign-off', () => {
  test('simple mode: the owner signs a stage off in one click', async ({ page, request }) => {
    const errors = watchErrors(page)
    const ws = await signUp(request)
    await signInAs(page, ws.token)
    await page.goto('/projects')
    await page.getByRole('button', { name: 'New project' }).first().click()
    await page.getByLabel('Name', { exact: true }).fill('Website')
    await expect(page.getByRole('radio', { name: /Simple \(recommended\)/ })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/projects\/\d+/)
    await expect(page.getByRole('heading', { name: 'Website' })).toBeVisible()
    const projectId = page.url().match(/projects\/(\d+)/)[1]
    await call(request, ws.token, 'POST', `/api/projects/${projectId}/features`, { title: 'Checkout', stage: 'proposed' })

    await page.goto(`/projects/${projectId}?tab=features`)
    await page.getByRole('button', { name: 'Sign off Proposed' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Sign off' }).click()
    await expect(page.getByRole('button', { name: 'Sign off Planned' })).toBeVisible()
    errors.check()
  })

  test('strict mode: a contributor asks and the owner approves in the Approvals tab', async ({ browser, request }) => {
    const ws = await signUp(request)
    const dev = await addPerson(request, ws.token, { fullName: 'Dana Dev' })
    const project = await call(request, ws.token, 'POST', '/api/projects', { name: 'Strict project', key: 'STR', signoff_mode: 'strict' })
    await call(request, ws.token, 'POST', `/api/projects/${project.id}/members`, { user_id: dev.user.id, role: 'contributor' })
    const feature = await call(request, dev.token, 'POST', `/api/projects/${project.id}/features`, { title: 'Payments', stage: 'proposed' })

    const devPage = await (await browser.newContext()).newPage()
    await signInAs(devPage, dev.token)
    await devPage.goto(`/projects/${project.id}?tab=features`)
    await devPage.getByRole('button', { name: 'Request sign-off for Proposed' }).click()
    await devPage.getByRole('dialog').getByRole('button', { name: 'Send request' }).click()
    await expect(devPage.getByText('waiting for the owner or a manager')).toBeVisible()

    const ownerPage = await (await browser.newContext()).newPage()
    const errors = watchErrors(ownerPage)
    await signInAs(ownerPage, ws.token)
    await ownerPage.goto(`/projects/${project.id}?tab=approvals`)
    const waiting = ownerPage.locator('.card', { has: ownerPage.getByRole('heading', { name: 'Waiting for you' }) })
    await expect(waiting.getByText('Stage sign-off')).toBeVisible()
    await waiting.getByRole('button', { name: 'Sign off' }).click()
    await ownerPage.getByRole('dialog').getByRole('button', { name: 'Approve' }).click()
    await expect(ownerPage.getByRole('heading', { name: 'Decided' })).toBeVisible()
    await expect.poll(async () => (await call(request, ws.token, 'GET', `/api/features/${feature.id}`)).stage).toBe('planned')
    errors.check()
  })
})

test('switching a module off hides it for everyone', async ({ page, request }) => {
  const errors = watchErrors(page)
  const ws = await signUp(request)
  await signInAs(page, ws.token)
  await page.goto('/settings')
  const sidebar = page.locator('aside.sidebar')
  await expect(sidebar.getByRole('link', { name: 'Chat' })).toBeVisible()
  await page.getByRole('checkbox', { name: /^Chat: on/ }).click()
  await expect(sidebar.getByRole('link', { name: 'Chat' })).toHaveCount(0)
  await page.getByRole('checkbox', { name: /^Time tracking and timesheets: off/ }).click()
  await expect(sidebar.getByRole('link', { name: 'Timesheet' })).toBeVisible()
  errors.check()
})

test('a licence is requested on Billing and activated by the platform owner', async ({ browser, request }) => {
  const ws = await signUp(request)
  const admin = await (await browser.newContext()).newPage()
  const errors = watchErrors(admin)
  await signInAs(admin, ws.token)
  await admin.goto('/billing')
  await admin.getByRole('button', { name: 'Request Starter' }).click()
  await admin.getByRole('dialog').getByRole('button', { name: 'Send request' }).click()
  await expect(admin.getByText('Waiting for activation').first()).toBeVisible()

  const owner = await (await browser.newContext()).newPage()
  await signInAs(owner, await ownerToken(request))
  await owner.goto('/platform?tab=requests')
  const row = owner.locator('.list-row', { hasText: ws.company })
  await row.getByRole('button', { name: 'Activate' }).click()
  await owner.getByRole('dialog').getByRole('button', { name: 'Payment received, activate' }).click()
  await expect(row).toHaveCount(0)

  await admin.reload()
  await expect(admin.getByText('Active', { exact: true }).first()).toBeVisible()
  await expect(admin.getByText(/^TRK-/)).toBeVisible()
  errors.check()
})

test('every project tab and main page opens without errors', async ({ page, request }) => {
  const errors = watchErrors(page)
  const ws = await signUp(request)
  // Show every module so every tab is visited.
  const all = Object.fromEntries((await call(request, ws.token, 'GET', '/api/admin/modules')).map((m) => [m.key, true]))
  await call(request, ws.token, 'PUT', '/api/admin/modules', { modules: all })
  const projectId = (await call(request, ws.token, 'GET', '/api/projects'))[0].id
  await signInAs(page, ws.token)
  const tabs = ['overview', 'features', 'milestones', 'timeline', 'board', 'list', 'sprints', 'tests', 'docs', 'releases', 'approvals', 'risks', 'reports', 'members', 'activity', 'settings']
  for (const tab of tabs) {
    await page.goto(`/projects/${projectId}?tab=${tab}`)
    await expect(page.getByRole('heading', { name: 'Website launch (example)' })).toBeVisible()
    await expect(page.locator('.tab.active')).toBeVisible()
  }
  for (const path of ['/', '/projects', '/roadmap', '/calendar', '/my-issues', '/timesheet', '/portfolio', '/workload', '/chat', '/users', '/settings', '/billing', '/support', '/profile', '/trash']) {
    await page.goto(path)
    await expect(page.locator('.page, .chat').first()).toBeVisible()
  }
  errors.check()
})
