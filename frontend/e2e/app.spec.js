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
    await expect(page.getByText(/Your workspace ID is \d{4}-\d{4}/)).toBeVisible()
    errors.check()
  })

  test('signing in with a wrong and then the right password', async ({ page, request }) => {
    const ws = await signUp(request)
    await page.goto('/login')
    await page.getByLabel('Workspace ID').fill(ws.workspace)
    await page.getByLabel('Username or email').fill(ws.username)
    const password = page.locator('input[autocomplete="current-password"]')
    await password.fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Incorrect workspace ID, username or password')).toBeVisible()
    await password.fill(ws.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/(login|welcome)$/)
    // This device remembers the workspace: next time only the username and password are asked.
    await page.goto('/login')
    await expect(page.getByRole('group', { name: 'Workspace ID' })).toContainText(ws.workspace)
    await expect(page.getByRole('textbox', { name: 'Workspace ID' })).toHaveCount(0) // a card, not a text box
  })

  test('the same username in two workspaces, and finding a forgotten workspace ID', async ({ page, request }) => {
    const errors = watchErrors(page)
    const first = await signUp(request, 'Northwind')
    const second = await signUp(request, 'Southwind')
    const name = unique('shared')
    for (const ws of [first, second]) {
      await call(request, ws.token, 'POST', '/api/users', { username: name, full_name: 'Shared Person', email: `${name}@example.com`, password: 'Temp#Pass123' })
    }
    await page.goto('/login')
    await page.getByRole('link', { name: 'Forgot your workspace ID?' }).click()
    await page.getByLabel('Email').fill(`${name}@example.com`)
    await page.locator('input[autocomplete="current-password"]').fill('Temp#Pass123')
    await page.getByRole('button', { name: 'Find my workspace' }).click()
    await expect(page.getByRole('button', { name: /Northwind/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Southwind/ })).toContainText(second.workspace)
    await page.getByRole('button', { name: /Southwind/ }).click()
    await expect(page.getByLabel('Workspace ID')).toHaveValue(second.workspace)
    await expect(page.getByLabel('Username or email')).toHaveValue(name)
    await page.locator('input[autocomplete="current-password"]').fill('Temp#Pass123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
    const me = await page.evaluate(() => fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('pm_token')}` } }).then((r) => r.json()))
    expect(me.org.name).toBe('Southwind')
    errors.check()
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

test('a customer adds an add-on to their plan and gets the feature once it is activated', async ({ browser, request }) => {
  const ws = await signUp(request)
  const owner = await ownerToken(request)
  // Put the workspace on Starter, which has no test management.
  const plans = Object.fromEntries((await call(request, null, 'GET', '/api/public/plans')).plans.map((p) => [p.key, p]))
  const first = await call(request, ws.token, 'POST', '/api/billing/requests', { plan_id: plans.starter.id, seats: 5, period: 'monthly' })
  await call(request, owner, 'POST', `/api/platform/requests/${first.id}/approve`, { note: '' })
  const projectId = (await call(request, ws.token, 'GET', '/api/projects'))[0].id
  await call(request, ws.token, 'PUT', '/api/admin/modules', { modules: { tests: true } }) // new workspaces hide it

  const page = await (await browser.newContext()).newPage()
  const errors = watchErrors(page)
  await signInAs(page, ws.token)
  await page.goto(`/projects/${projectId}?tab=tests`)
  await expect(page.getByText('Test management is not part of your plan')).toBeVisible()
  await page.getByRole('link', { name: 'See add-ons' }).click()

  const card = page.locator('.addon-card', { hasText: 'Test management' })
  await card.getByRole('button', { name: 'Add' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('checkbox', { name: /Test management/ })).toBeChecked()
  await dialog.getByRole('button', { name: 'Monthly' }).click()
  await expect(dialog.locator('.quote-lines')).toContainText('Test management')
  await expect(dialog.locator('.quote b')).toContainText('40') // (6 + 2) × 5 users
  await dialog.getByRole('button', { name: 'Send request' }).click()
  await expect(page.getByText('+ Test management').first()).toBeVisible()

  const pending = (await call(request, owner, 'GET', '/api/platform/requests?status=pending')).find((r) => r.org_id === ws.user.org.id)
  expect(pending.addons).toEqual(['test_management'])
  await call(request, owner, 'POST', `/api/platform/requests/${pending.id}/approve`, { note: '' })
  await page.goto('/billing')
  await expect(page.locator('.addon-card', { hasText: 'Test management' }).getByText('Active')).toBeVisible()
  await page.goto(`/projects/${projectId}?tab=tests`)
  await expect(page.getByText('Test management is not part of your plan')).toHaveCount(0)
  errors.check()
})

test('changing the currency shows the converted prices before saving', async ({ page, request }) => {
  const errors = watchErrors(page)
  await signInAs(page, await ownerToken(request))
  await page.goto('/platform?tab=settings')
  const currency = page.getByLabel('Currency')
  await currency.fill('INR')
  await expect(page.getByText('Changing the currency from USD to INR')).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Exchange rate' })).toHaveValue('84')
  const starter = page.locator('.currency-change tr', { hasText: 'Starter' })
  await expect(starter).toContainText('₹499')
  await expect(starter).toContainText('₹4,990')
  await page.getByRole('checkbox', { name: /friendly prices/ }).uncheck()
  await expect(starter).toContainText('₹504')
  await currency.fill('USD') // nothing saved
  await expect(page.getByText('Changing the currency from')).toHaveCount(0)
  errors.check()
})

test('time logged on a feature shows on the feature and in the budget by feature', async ({ page, request }) => {
  const errors = watchErrors(page)
  const ws = await signUp(request)
  await call(request, ws.token, 'PUT', '/api/admin/modules', { modules: { time: true, budgets: true } })
  await call(request, ws.token, 'PATCH', `/api/users/${ws.user.id}`, { hourly_rate: 1000 })
  const project = await call(request, ws.token, 'POST', '/api/projects', { name: 'Costed', key: 'CST' })
  await call(request, ws.token, 'PATCH', `/api/projects/${project.id}`, { budget: 50000, currency: 'INR' })
  await call(request, ws.token, 'POST', `/api/projects/${project.id}/features`, { title: 'Loyalty points', stage: 'proposed' })

  await signInAs(page, ws.token)
  await page.goto(`/projects/${project.id}?tab=features`)
  await page.getByRole('button', { name: 'Loyalty points' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Log time on this feature' }).click()
  await dialog.getByLabel('Hours').fill('3')
  await dialog.getByLabel('Note').fill('Design review')
  await dialog.getByRole('button', { name: 'Save time' }).click()
  const totals = dialog.locator('.feature-time-sum')
  await expect(totals).toContainText('3h')
  await expect(totals).toContainText('₹3,000')
  await expect(dialog.getByText('Design review')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.goto(`/projects/${project.id}?tab=overview`)
  const budget = page.locator('.card', { has: page.getByRole('heading', { name: 'Budget', exact: true }) })
  await expect(budget.getByText('By feature')).toBeVisible()
  await expect(budget.locator('.time-row', { hasText: 'Loyalty points' })).toContainText('₹3,000')
  errors.check()
})

test('a module groups features and signing it off moves its features too', async ({ page, request }) => {
  const errors = watchErrors(page)
  const ws = await signUp(request)
  const project = await call(request, ws.token, 'POST', '/api/projects', { name: 'Shop app', key: 'SHP' })
  const beta = await call(request, ws.token, 'POST', `/api/projects/${project.id}/milestones`, { name: 'Beta' })
  const card = await call(request, ws.token, 'POST', `/api/projects/${project.id}/features`, { title: 'Card payments', stage: 'proposed' })
  const upi = await call(request, ws.token, 'POST', `/api/projects/${project.id}/features`, { title: 'UPI payments', stage: 'proposed' })

  await signInAs(page, ws.token)
  await page.goto(`/projects/${project.id}?tab=modules`)
  await page.getByRole('button', { name: 'New module' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Module name').fill('Payments')
  await dialog.getByLabel('Milestone').selectOption({ label: 'Beta' })
  await dialog.getByRole('checkbox', { name: /Card payments/ }).check()
  await dialog.getByRole('checkbox', { name: /UPI payments/ }).check()
  await dialog.getByRole('button', { name: 'Add module' }).click()

  const moduleCard = page.locator('.module-card', { hasText: 'Payments' })
  await expect(moduleCard.getByText('Card payments · Proposed')).toBeVisible()
  await moduleCard.getByRole('button', { name: 'Sign off Proposed' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Sign off' }).click()
  await expect(moduleCard.getByText('UPI payments · Planned')).toBeVisible()
  await expect(moduleCard.getByRole('button', { name: 'Sign off Planned' })).toBeVisible()
  for (const f of [card, upi]) {
    expect((await call(request, ws.token, 'GET', `/api/features/${f.id}`)).milestone_id).toBe(beta.id)
  }
  await page.goto(`/projects/${project.id}?tab=milestones`)
  await expect(page.locator('.module-tag', { hasText: 'Payments · Planned' })).toBeVisible()
  errors.check()
})
