import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDeliveryContext, executeInject } from './bridge-inject.js'
import type { OpenClawGateway } from './openclaw.js'

function makeGw(invokeFn: (req: any) => Promise<any>): OpenClawGateway {
  return { invoke: invokeFn } as unknown as OpenClawGateway
}

describe('resolveDeliveryContext', () => {
  it('returns channel and to when session has deliveryContext', async () => {
    const gw = makeGw(async () => ({
      details: {
        sessions: [
          { key: 'sess-1', deliveryContext: { channel: 'telegram', to: '12345' } },
          { key: 'sess-2', deliveryContext: { channel: 'discord', to: '67890' } },
        ],
      },
    }))

    const dc = await resolveDeliveryContext(gw, 'sess-1')
    assert.deepStrictEqual(dc, { channel: 'telegram', to: '12345' })
  })

  it('throws when session is not found', async () => {
    const gw = makeGw(async () => ({
      details: { sessions: [{ key: 'other', deliveryContext: { channel: 'telegram', to: '111' } }] },
    }))

    await assert.rejects(() => resolveDeliveryContext(gw, 'missing-session'), {
      message: /session not found: missing-session/,
    })
  })

  it('throws when session has no deliveryContext', async () => {
    const gw = makeGw(async () => ({
      details: { sessions: [{ key: 'sess-1', deliveryContext: {} }] },
    }))

    await assert.rejects(() => resolveDeliveryContext(gw, 'sess-1'), {
      message: /has no deliveryContext/,
    })
  })

  it('throws when sessions_list returns empty result', async () => {
    const gw = makeGw(async () => ({ details: { sessions: [] } }))

    await assert.rejects(() => resolveDeliveryContext(gw, 'sess-1'), {
      message: /session not found/,
    })
  })

  it('throws when sessions_list response has unexpected shape', async () => {
    const gw = makeGw(async () => ({ unexpected: true }))

    await assert.rejects(() => resolveDeliveryContext(gw, 'sess-1'), {
      message: /session not found/,
    })
  })

  it('throws when gateway invoke itself fails', async () => {
    const gw = makeGw(async () => {
      throw new Error('gateway timeout')
    })

    await assert.rejects(() => resolveDeliveryContext(gw, 'sess-1'), {
      message: /gateway timeout/,
    })
  })
})

describe('executeInject', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    mock.restoreAll()
  })

  it('throws when OPENCLAW_GATEWAY_TOKEN is not set', async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN
    const gw = makeGw(async () => ({}))

    await assert.rejects(
      () => executeInject(gw, { sessionKey: 's1', text: 'hi', channel: 'telegram', to: '123' }),
      { message: /OPENCLAW_GATEWAY_TOKEN is not set/ },
    )
  })

  it('sends visible message then triggers gateway inject', async () => {
    const invokeCalls: any[] = []
    const gw = makeGw(async (req) => {
      invokeCalls.push(req)
      return {}
    })

    // Mock global fetch for the gateway /bridge/inject call
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init: any) => {
      return { ok: true, status: 200, text: async () => '{"ok":true}' } as Response
    }

    try {
      await executeInject(gw, { sessionKey: 's1', text: 'hello', channel: 'telegram', to: '123' })

      // Step 1: visible message was sent via gw.invoke
      assert.equal(invokeCalls.length, 1)
      assert.deepStrictEqual(invokeCalls[0], {
        tool: 'message',
        action: 'send',
        args: { channel: 'telegram', target: '123', message: 'hello' },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws when gateway /bridge/inject returns non-ok', async () => {
    const gw = makeGw(async () => ({}))

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'boom' } as Response
    }

    try {
      await assert.rejects(
        () => executeInject(gw, { sessionKey: 's1', text: 'hi', channel: 'telegram', to: '123' }),
        { message: /gateway bridge\/inject failed: 500/ },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws when gw.invoke (message send) fails', async () => {
    const gw = makeGw(async () => {
      throw new Error('message send failed')
    })

    await assert.rejects(
      () => executeInject(gw, { sessionKey: 's1', text: 'hi', channel: 'telegram', to: '123' }),
      { message: /message send failed/ },
    )
  })

  it('sends correct auth header and body to gateway /bridge/inject', async () => {
    const gw = makeGw(async () => ({}))
    let capturedInit: any = null
    let capturedUrl: string = ''

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init: any) => {
      capturedUrl = String(input)
      capturedInit = init
      return { ok: true, status: 200, text: async () => '' } as Response
    }

    try {
      await executeInject(gw, { sessionKey: 's1', text: 'test msg', channel: 'telegram', to: '999' })

      assert.equal(capturedUrl, 'http://127.0.0.1:18789/bridge/inject')
      assert.equal(capturedInit.method, 'POST')
      assert.equal(capturedInit.headers['authorization'], 'Bearer test-token')
      assert.equal(capturedInit.headers['content-type'], 'application/json')

      const body = JSON.parse(capturedInit.body)
      assert.deepStrictEqual(body, { sessionKey: 's1', text: 'test msg' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
