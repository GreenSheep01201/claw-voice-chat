import { config as loadEnv } from 'dotenv'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { getGatewayFromEnv } from './openclaw.js'
import { resolveDeliveryContext, executeInject } from './bridge-inject.js'

// Load .env from project root (one level up from server/).
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
loadEnv({ path: path.resolve(__dirname, '../../.env') })

const PORT = parseInt(process.env.PORT || '8888', 10)
const VCB_BACKEND_HTTP = process.env.VCB_BACKEND_HTTP || 'http://127.0.0.1:8766'

// In production we serve the built Vite client (client/dist).
const NODE_ENV = process.env.NODE_ENV || 'development'
const IS_PROD = NODE_ENV === 'production'

const app = express()
app.use(express.json({ limit: '1mb' }))

// Bridge endpoints: STT/TTS UI -> OpenClaw sessions/channels
app.get('/bridge/healthz', (_req, res) => {
  res.status(200).json({ ok: true })
})

// Create a bridge attachment for a session so the UI can subscribe to deltas via SSE.
app.post('/bridge/attach', async (req, res) => {
  try {
    const sessionKey = String(req.body?.sessionKey || '').trim()
    if (!sessionKey) return res.status(400).json({ ok: false, error: 'sessionKey required' })

    const baseUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'
    const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
    if (!token) return res.status(500).json({ ok: false, error: 'OPENCLAW_GATEWAY_TOKEN is required' })

    const r = await fetch(`${baseUrl}/bridge/attach`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionKey }),
    })

    const bodyText = await r.text().catch(() => '')
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: `attach failed: ${r.status}${bodyText ? `: ${bodyText}` : ''}` })
    }

    // passthrough gateway JSON
    res.status(200).type('application/json').send(bodyText)
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

// Proxy the OpenClaw gateway SSE stream so the browser doesn't need auth headers.
app.get('/bridge/stream', async (req, res) => {
  const bridgeId = String(req.query.bridgeId || '').trim()
  if (!bridgeId) return res.status(400).json({ ok: false, error: 'bridgeId required' })

  const baseUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  if (!token) return res.status(500).end('OPENCLAW_GATEWAY_TOKEN is required')

  const url = `${baseUrl}/bridge/stream?bridgeId=${encodeURIComponent(bridgeId)}`
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (!r.ok || !r.body) {
      const body = await r.text().catch(() => '')
      res.status(500).end(body || `stream failed: ${r.status}`)
      return
    }

    res.status(200)
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')

    const reader = r.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
    res.end()
  } catch (err: any) {
    if (!res.headersSent) res.status(500)
    res.end(String(err?.message || err))
  }
})

app.get('/bridge/targets', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10) || 50))
    const activeMinutes = Math.max(
      1,
      Math.min(60 * 24 * 30, parseInt(String(req.query.activeMinutes || '10080'), 10) || 10080),
    ) // default 7d

    const gw = getGatewayFromEnv()
    const result = await gw.invoke({
      tool: 'sessions_list',
      action: 'json',
      args: { limit, activeMinutes, messageLimit: 0 },
    })

    const sessions = Array.isArray((result as any)?.details?.sessions) ? (result as any).details.sessions : []

    const targets = sessions
      .filter((s: any) => s?.deliveryContext?.channel && s?.deliveryContext?.to)
      .map((s: any) => ({
        sessionKey: s.key,
        displayName: s.displayName,
        channel: s.deliveryContext.channel,
        to: s.deliveryContext.to,
        updatedAt: s.updatedAt,
      }))

    res.json({ ok: true, targets })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

app.post('/bridge/inject', async (req, res) => {
  try {
    const sessionKey = String(req.body?.sessionKey || '')
    const text = String(req.body?.text || '').trim()
    if (!sessionKey) return res.status(400).json({ ok: false, error: 'sessionKey required' })
    if (!text) return res.status(400).json({ ok: false, error: 'text required' })

    // Reply immediately so the voice UI never hangs waiting for OpenClaw to finish a turn.
    res.status(202).json({ ok: true })

    void (async () => {
      try {
        const gw = getGatewayFromEnv()
        const dc = await resolveDeliveryContext(gw, sessionKey)
        await executeInject(gw, { sessionKey, text, channel: dc.channel, to: dc.to })
      } catch (err: any) {
        console.error(`[bridge/inject] background task failed for session=${sessionKey}:`, err?.message || err)
      }
    })()
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

// TTS proxy: forwards text to external TTS providers and returns base64 audio.
app.post('/bridge/tts', async (req, res) => {
  try {
    const { text, provider, apiKey, model, voice, customUrl } = req.body || {}
    if (!text) return res.status(400).json({ ok: false, error: 'text required' })
    if (!provider) return res.status(400).json({ ok: false, error: 'provider required' })

    let audioBase64: string

    if (provider === 'openai' || provider === 'qwen') {
      const endpoint = provider === 'openai'
        ? 'https://api.openai.com/v1/audio/speech'
        : 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech'

      if (!apiKey) return res.status(400).json({ ok: false, error: 'apiKey required' })

      const ttsModel = model || (provider === 'openai' ? 'tts-1' : 'cosyvoice-v1')
      const ttsVoice = voice || (provider === 'openai' ? 'alloy' : 'longxiaochun')

      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: ttsModel, voice: ttsVoice, input: text }),
      })

      if (!r.ok) {
        const errText = await r.text().catch(() => '')
        return res.status(502).json({ ok: false, error: `TTS API ${r.status}: ${errText.slice(0, 200)}` })
      }

      const buf = Buffer.from(await r.arrayBuffer())
      audioBase64 = buf.toString('base64')
    } else if (provider === 'custom') {
      if (!customUrl) return res.status(400).json({ ok: false, error: 'customUrl required' })

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`

      const r = await fetch(customUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, model: model || undefined, voice: voice || undefined, input: text }),
      })

      if (!r.ok) {
        const errText = await r.text().catch(() => '')
        return res.status(502).json({ ok: false, error: `Custom TTS ${r.status}: ${errText.slice(0, 200)}` })
      }

      const contentType = r.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        // If the custom endpoint returns JSON with base64 audio
        const data = await r.json() as any
        audioBase64 = data.audio || data.data || ''
        if (!audioBase64) return res.status(502).json({ ok: false, error: 'No audio in custom TTS response' })
      } else {
        // Binary audio response
        const buf = Buffer.from(await r.arrayBuffer())
        audioBase64 = buf.toString('base64')
      }
    } else {
      return res.status(400).json({ ok: false, error: `unsupported provider: ${provider}` })
    }

    res.json({ ok: true, audio: audioBase64 })
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

// Model catalog cache (refreshed every 5 min or on first request).
type CatalogModel = { key: string; name: string; available: boolean; tags?: string[] }
let modelCacheData: CatalogModel[] | null = null
let modelCacheTs = 0
const MODEL_CACHE_TTL = 5 * 60_000

function loadModelCatalog(): Promise<CatalogModel[]> {
  const cli = process.env.OPENCLAW_CLI || ''
  if (!cli) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('node', [cli, 'models', 'list', '--all', '--json'], { timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve([])
      try {
        const data = JSON.parse(stdout) as { models?: CatalogModel[] }
        const models = (data.models || []).filter((m) => m.available !== false)
        modelCacheData = models
        modelCacheTs = Date.now()
        resolve(models)
      } catch {
        resolve([])
      }
    })
  })
}

// Warm cache at startup.
void loadModelCatalog()

app.get('/bridge/models', async (_req, res) => {
  if (modelCacheData && Date.now() - modelCacheTs < MODEL_CACHE_TTL) {
    return res.json({ ok: true, models: modelCacheData })
  }
  const models = await loadModelCatalog()
  res.json({ ok: true, models })
})

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, port: PORT, backend: VCB_BACKEND_HTTP, env: NODE_ENV })
})

// Proxy only the backend surfaces (HTTP + WS) to the existing FastAPI backend.
const apiProxy = createProxyMiddleware({
  target: VCB_BACKEND_HTTP,
  changeOrigin: true,
  pathRewrite: (path) => `/api${path}`,
})

const wsProxy = createProxyMiddleware({
  target: VCB_BACKEND_HTTP,
  changeOrigin: true,
  ws: true,
  pathRewrite: (path) => (path.startsWith('/ws/') ? path : `/ws${path}`),
})

app.use('/api', apiProxy)
app.use('/ws', wsProxy)

if (IS_PROD) {
  const clientDist = path.resolve(__dirname, '../../client/dist')
  app.use(express.static(clientDist))

  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

const server = app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[vcb-web] express listening on http://0.0.0.0:${PORT} (env=${NODE_ENV}) -> ${VCB_BACKEND_HTTP}`)
})

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/ws/')) {
    // @ts-expect-error
    return wsProxy.upgrade(req, socket, head)
  }
})
