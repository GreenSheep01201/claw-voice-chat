import type { OpenClawGateway } from './openclaw.js'

export type DeliveryContext = { channel: string; to: string }

/**
 * Resolve deliveryContext (channel + to) for a given sessionKey by querying sessions_list.
 * Throws if the session is not found or has no delivery target.
 */
export async function resolveDeliveryContext(gw: OpenClawGateway, sessionKey: string): Promise<DeliveryContext> {
  const list = await gw.invoke({
    tool: 'sessions_list',
    action: 'json',
    args: { limit: 200, activeMinutes: 60 * 24 * 30, messageLimit: 0 },
  })
  const sessions = Array.isArray((list as any)?.details?.sessions) ? (list as any).details.sessions : []
  const s = sessions.find((x: any) => x?.key === sessionKey)
  if (!s) {
    throw new Error(`session not found: ${sessionKey}`)
  }
  const dc = s.deliveryContext
  if (!dc?.channel || !dc?.to) {
    throw new Error(`session ${sessionKey} has no deliveryContext (channel=${dc?.channel}, to=${dc?.to})`)
  }
  return { channel: dc.channel, to: dc.to }
}

export type InjectParams = {
  sessionKey: string
  text: string
  channel: string
  to: string
}

/**
 * Execute the two-step inject:
 *   1) Send a visible user-utterance message to the channel.
 *   2) Trigger the OpenClaw agent turn via gateway /bridge/inject.
 * Throws on failure so callers can log/handle the error.
 */
export async function executeInject(gw: OpenClawGateway, params: InjectParams): Promise<void> {
  const { sessionKey, text, channel, to } = params

  const baseUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  if (!token) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not set')
  }

  // 1) Visible user-utterance line in the target channel.
  await gw.invoke({
    tool: 'message',
    action: 'send',
    args: { channel, target: to, message: text },
  })

  // 2) Trigger OpenClaw agent turn via gateway bridge/inject.
  const r = await fetch(`${baseUrl}/bridge/inject`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionKey, text }),
  })

  const body = await r.text().catch(() => '')
  if (!r.ok) {
    throw new Error(`gateway bridge/inject failed: ${r.status} ${r.statusText}${body ? `: ${body}` : ''}`)
  }
}
