/**
 * Proxy resolution tests.
 *
 * The interesting cases are the fallback chain (explicit URL, environment,
 * Windows registry) and that a wrongly-shaped value never breaks a request.
 *
 *   node --test test/proxy.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { clearProxyCache, proxyOf } from '../lib/api.js'
import { readConfig } from '../lib/config.js'

const PLUGIN_DIR = 'E:/tmp/github-proxy-test'

function configFor(overrides = {}) {
  return readConfig({ ...overrides }, { pluginDir: PLUGIN_DIR, profileDir: '', home: '' })
}

function withoutProxyEnv(fn) {
  return async () => {
    const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    const saved = {}
    for (const name of names) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    clearProxyCache()
    try {
      await fn()
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value
      clearProxyCache()
    }
  }
}

test('an explicit proxyUrl wins over everything', withoutProxyEnv(async () => {
  process.env.HTTPS_PROXY = 'http://env-proxy:1111'
  const config = configFor({ proxyUrl: 'http://explicit:2222' })
  assert.equal(proxyOf(config), 'http://explicit:2222')
}))

test('the environment proxy is used when no proxyUrl is set', withoutProxyEnv(async () => {
  process.env.HTTPS_PROXY = 'http://env-proxy:1111'
  assert.equal(proxyOf(configFor()), 'http://env-proxy:1111')
}))

test('lower-case environment variables are honoured too', withoutProxyEnv(async () => {
  process.env.https_proxy = 'http://lower:3333'
  assert.equal(proxyOf(configFor()), 'http://lower:3333')
}))

test('the environment is ignored when proxyFromEnv is false', withoutProxyEnv(async () => {
  process.env.HTTPS_PROXY = 'http://env-proxy:1111'
  const config = configFor({ proxyFromEnv: false, proxyFromSystem: false })
  assert.equal(proxyOf(config), '')
}))

test('the system proxy is discovered on this machine without any env var', withoutProxyEnv(async () => {
  const config = configFor()
  const proxy = proxyOf(config)
  if (process.platform !== 'win32') {
    assert.equal(proxy, '', 'only Windows reads the registry')
    return
  }
  // Either the machine has a system proxy configured (this one does) or it
  // does not; both are valid, but the value must be usable as a URL when set.
  if (proxy !== '') {
    assert.match(proxy, /^https?:\/\/[^\s]+:\d+$/, `unexpected proxy shape: ${proxy}`)
  }
}))

test('proxyFromSystem: false skips the registry entirely', withoutProxyEnv(async () => {
  const config = configFor({ proxyFromSystem: false })
  assert.equal(proxyOf(config), '')
}))

test('${env:NAME} inside proxyUrl is expanded, and a missing variable means unset', withoutProxyEnv(async () => {
  process.env.DSH_TEST_PROXY = 'http://from-env:4444'
  assert.equal(proxyOf(configFor({ proxyUrl: '${env:DSH_TEST_PROXY}' })), 'http://from-env:4444')
  delete process.env.DSH_TEST_PROXY
  assert.equal(proxyOf(configFor({ proxyUrl: '${env:DSH_TEST_PROXY}', proxyFromSystem: false })), '')
}))
