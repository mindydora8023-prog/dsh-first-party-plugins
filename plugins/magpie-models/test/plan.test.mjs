import assert from 'node:assert/strict'
import test from 'node:test'

import { assignModels, mergeProviders, modelEntry, modelsFromBody } from '../lib/plan.js'

const TARGETS = { chatProvider: 'magpie', responsesProvider: 'magpie-responses' }

function record(partial) {
  return {
    id: partial.id,
    magpie_label: partial.label,
    context_window: partial.context ?? 500000,
    max_output_tokens: partial.maxTokens,
    modalities: { input: partial.input ?? ['text', 'image'] },
    native_endpoints: partial.endpoints,
    reasoning_levels: partial.levels,
    supported_reasoning_levels: partial.rich,
  }
}

const LIVE = [
  record({
    id: 'codex/gpt-6.2-sol',
    label: 'GPT-6.2-Sol - Codex',
    endpoints: ['/v1/responses'],
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  }),
  record({
    id: 'codex/gpt-6.1-sol',
    label: 'GPT-6.1-Sol - Codex',
    maxTokens: 128000,
    endpoints: ['/v1/responses'],
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  }),
  record({
    id: 'cursor/grok-4.7@500k',
    label: 'Grok 4.7 @ 500k - Cursor',
    endpoints: ['/v1/chat/completions'],
    levels: ['low', 'medium', 'high', 'xhigh'],
  }),
  record({
    id: 'workbuddy/deepseek-v4.1-flash',
    label: 'DeepSeek-V4.1-Flash - WorkBuddy',
    context: 1000000,
    maxTokens: 128000,
    endpoints: ['/v1/chat/completions'],
    levels: ['none', 'low', 'high', 'max'],
  }),
]

test('reads a data array and ignores anything else', () => {
  assert.equal(modelsFromBody(null).length, 0)
  assert.equal(modelsFromBody({ models: [{ id: 'a' }] }).length, 1)
  assert.equal(modelsFromBody({ data: [{ id: 'a' }, null, 'nope'] }).length, 1)
})

test('splits chat and responses, dropping models with no native endpoint', () => {
  const assigned = assignModels([
    ...LIVE,
    record({ id: 'orphan', label: 'Orphan', endpoints: [] }),
  ], TARGETS)
  assert.deepEqual(assigned.magpie.map((model) => model.id), [
    'cursor/grok-4.7@500k',
    'workbuddy/deepseek-v4.1-flash',
  ])
  assert.deepEqual(assigned['magpie-responses'].map((model) => model.id), [
    'codex/gpt-6.2-sol',
    'codex/gpt-6.1-sol',
  ])
})

test('a model advertised on both endpoints is responses-only', () => {
  const assigned = assignModels([
    record({ id: 'both', label: 'Both', endpoints: ['/v1/chat/completions', '/v1/responses'] }),
  ], TARGETS)
  assert.equal(assigned.magpie.length, 0)
  assert.equal(assigned['magpie-responses'][0].compat.supportsStrictMode, true)
})

test('none stays off with wire spelling none; ultra yields to a real max', () => {
  const flash = modelEntry(LIVE[3], 'chat')
  assert.equal(flash.reasoningEfforts.off, 'none')
  assert.equal(flash.reasoningEfforts.low, 'low')
  assert.equal(flash.reasoningEfforts.max, 'max')
  const sol = modelEntry(LIVE[0], 'responses')
  assert.equal(sol.reasoningEfforts.max, 'max')
  assert.equal(sol.reasoningEfforts.ultra, undefined)
  assert.equal(sol.maxTokens, undefined)
})

test('ultra alone becomes max with the ultra wire spelling', () => {
  const entry = modelEntry(record({
    id: 'only-ultra',
    label: 'Only',
    endpoints: ['/v1/responses'],
    levels: ['ultra'],
  }), 'responses')
  assert.deepEqual(entry.reasoningEfforts, { max: 'ultra' })
})

test('rich effort objects win over the plain list', () => {
  const entry = modelEntry(record({
    id: 'rich',
    label: 'Rich',
    endpoints: ['/v1/chat/completions'],
    levels: ['low'],
    rich: [{ effort: 'high' }],
  }), 'chat')
  assert.deepEqual(entry.reasoningEfforts, { high: 'high' })
})

test('keeps an existing output cap the gateway omitted, and appends new ids', () => {
  const providers = {
    magpie: {
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:3425/v1',
      models: [{
        id: 'cursor/grok-4.7@500k',
        name: 'Grok 4.7 @ 500k - Cursor',
        contextWindow: 500000,
        maxTokens: 64000,
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
      }],
    },
    'magpie-responses': {
      api: 'openai-responses',
      streamIdleTimeoutMs: 600000,
      models: [{
        id: 'codex/gpt-6.1-sol',
        name: 'GPT-6.1-Sol - Codex',
        contextWindow: 500000,
        maxTokens: 128000,
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        compat: { supportsStrictMode: true },
      }],
    },
  }
  const assigned = assignModels(LIVE, TARGETS)
  const result = mergeProviders(providers, assigned)
  assert.equal(result.changed, true)
  assert.equal(result.providers.magpie.baseURL, 'http://127.0.0.1:3425/v1')
  assert.equal(result.providers.magpie.models[0].maxTokens, 64000)
  assert.equal(result.providers['magpie-responses'].streamIdleTimeoutMs, 600000)
  assert.deepEqual(result.providers['magpie-responses'].models.map((model) => model.id), [
    'codex/gpt-6.1-sol',
    'codex/gpt-6.2-sol',
  ])
})

test('an identical catalog does not report a change', () => {
  const assigned = assignModels(LIVE, TARGETS)
  const first = mergeProviders({
    magpie: { api: 'openai-completions', models: [] },
    'magpie-responses': { api: 'openai-responses', models: [] },
  }, assigned)
  const second = mergeProviders(first.providers, assigned)
  assert.equal(second.changed, false)
  assert.equal(second.providers, first.providers)
})

test('an empty listing does not wipe a provider that exists', () => {
  const providers = {
    magpie: { api: 'openai-completions', models: [{ id: 'keep', name: 'Keep', input: ['text'] }] },
  }
  const result = mergeProviders(providers, { magpie: [] })
  assert.equal(result.changed, false)
  assert.equal(result.providers.magpie.models.length, 1)
})

test('a model the gateway dropped is removed, and a missing provider is skipped', () => {
  const providers = {
    magpie: {
      api: 'openai-completions',
      models: [
        { id: 'gone', name: 'Gone', input: ['text'] },
        {
          id: 'cursor/grok-4.7@500k',
          name: 'Grok 4.7 @ 500k - Cursor',
          contextWindow: 500000,
          input: ['text', 'image'],
          reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        },
      ],
    },
  }
  const assigned = assignModels(LIVE, TARGETS)
  const result = mergeProviders(providers, assigned)
  assert.deepEqual(result.providers.magpie.models.map((model) => model.id), [
    'cursor/grok-4.7@500k',
    'workbuddy/deepseek-v4.1-flash',
  ])
  assert.equal(result.summary.find((item) => item.providerId === 'magpie-responses').reason, 'provider-missing')
})
