type ToolInvokeRequest = {
  tool: string
  action?: string
  args?: Record<string, any>
  sessionKey?: string
  dryRun?: boolean
}

type ToolInvokeResponse = { ok: true; result: any } | { ok: false; error: { type?: string; message: string } }

export class OpenClawGateway {
  private baseUrl: string
  private token: string

  constructor(opts: { baseUrl: string; token: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
  }

  async invoke(req: ToolInvokeRequest): Promise<any> {
    const url = `${this.baseUrl}/tools/invoke`
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(req),
    })

    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`gateway tool invoke failed: ${r.status} ${r.statusText}${body ? `: ${body}` : ''}`)
    }

    const data = (await r.json()) as ToolInvokeResponse
    if (!data.ok) throw new Error(data.error?.message || 'tool invoke error')
    return data.result
  }
}

export function getGatewayFromEnv() {
  const baseUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN is required')
  return new OpenClawGateway({ baseUrl, token })
}
