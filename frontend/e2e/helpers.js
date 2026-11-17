/* Shared helpers for the browser tests. Data is set up through the API (fast); the tests then
 * drive the real interface in Chromium. Everything runs against a throwaway database (serve.sh). */
import { expect } from '@playwright/test'

let counter = 0
export const unique = (prefix = 'u') => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

export async function call(request, token, method, path, data) {
  const response = await request.fetch(path, {
    method,
    data,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()}: ${text}`)
  return body
}

/** A new workspace on the free trial. Returns its admin's token and details. */
export async function signUp(request, company = unique('Company ')) {
  const username = unique('adm')
  const password = 'Admin#Pass123'
  const session = await call(request, null, 'POST', '/api/auth/register', {
    company, full_name: `Admin ${username}`, email: `${username}@example.com`, username, password, accept_terms: true,
  })
  return { token: session.access_token, user: session.user, username, password, company }
}

/** Someone in the workspace, with their first password change done. */
export async function addPerson(request, adminToken, { role = 'member', fullName } = {}) {
  const username = unique('p')
  const created = await call(request, adminToken, 'POST', '/api/users', {
    username, full_name: fullName || username, email: `${username}@example.com`, role, password: 'Temp#Pass123',
  })
  const first = await call(request, null, 'POST', '/api/auth/login', { username, password: 'Temp#Pass123' })
  const changed = await call(request, first.access_token, 'POST', '/api/auth/change-password', {
    current_password: 'Temp#Pass123', new_password: 'Member#Pass123',
  })
  return { token: changed.access_token, user: created.user, username }
}

const OWNER_PASSWORD = 'Owner#Pass123'

/** The platform owner (first administrator), with the forced password change done once. */
export async function ownerToken(request) {
  try {
    return (await call(request, null, 'POST', '/api/auth/login', { username: 'admin', password: OWNER_PASSWORD })).access_token
  } catch {
    const first = await call(request, null, 'POST', '/api/auth/login', { username: 'admin', password: 'Admin@123' })
    return (await call(request, first.access_token, 'POST', '/api/auth/change-password', {
      current_password: 'Admin@123', new_password: OWNER_PASSWORD,
    })).access_token
  }
}

/** Open the app in this page as an already signed-in person. */
export async function signInAs(page, token) {
  await page.addInitScript((t) => window.localStorage.setItem('pm_token', t), token)
}

/** Fail the test if the page throws a JavaScript error. */
export function watchErrors(page) {
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  return {
    check: () => expect(errors, `JavaScript errors on the page:\n${errors.join('\n')}`).toEqual([]),
  }
}
