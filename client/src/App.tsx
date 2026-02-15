import { useEffect, useMemo, useRef, useState } from 'react'
import { base64ToArrayBuffer, bytesToBase64, downsampleToPcm16, FRAME_BYTES, pcm16ToBytes } from './lib/audio'
import type { CliStatus, Profile, ServerMessage } from './types'

type Role = 'meta' | 'user' | 'assistant' | 'command'

type ChatMsg = { id: string; role: Role; text: string }

type WsStatus = 'offline' | 'online'

type AudioStatus = 'locked' | 'unlocked'

const LS = {
  token: 'vcb_token',
  model: 'vcb_model',
  profile: 'vcb_profile_key',
  engine: 'vcb_engine',
  audioUnlocked: 'vcb_audio_unlocked',
  ttsEnabled: 'vcb_tts_enabled',
  targetSessionKey: 'vcb_target_session_key',
  ttsProvider: 'vcb_tts_provider',
  ttsVoiceUri: 'vcb_tts_voice_uri',
  ttsApiKey: 'vcb_tts_api_key',
  ttsModel: 'vcb_tts_model',
  ttsVoiceName: 'vcb_tts_voice_name',
  ttsCustomUrl: 'vcb_tts_custom_url',
  sttLanguage: 'vcb_stt_language',
  sttModelSize: 'vcb_stt_model_size',
} as const

type TtsProvider = 'browser' | 'openai' | 'qwen' | 'custom'
type SettingsTab = 'models' | 'voice'

const STT_LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'ko', label: 'Korean' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ru', label: 'Russian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
] as const

const STT_MODEL_SIZES = [
  { value: 'tiny', label: 'Tiny', desc: 'Fastest, lowest accuracy' },
  { value: 'base', label: 'Base', desc: 'Fast, basic accuracy' },
  { value: 'small', label: 'Small', desc: 'Balanced speed' },
  { value: 'medium', label: 'Medium', desc: 'Recommended' },
  { value: 'large-v3', label: 'Large v3', desc: 'Best accuracy, slowest' },
] as const

const TTS_PROVIDER_DEFAULTS: Record<TtsProvider, { model: string; voice: string }> = {
  browser: { model: '', voice: '' },
  openai: { model: 'tts-1', voice: 'alloy' },
  qwen: { model: 'cosyvoice-v1', voice: 'longxiaochun' },
  custom: { model: '', voice: '' },
}

/** Detect device language and map to supported STT language code. */
function detectDeviceLanguage(): string {
  const lang = (navigator.language || '').toLowerCase()
  const prefix = lang.split('-')[0]
  const supported: string[] = STT_LANGUAGES.map((l) => l.code).filter((c) => c !== 'auto')
  if (supported.includes(prefix)) return prefix
  return 'auto'
}

function langCodeToLocale(code: string): string {
  const map: Record<string, string> = {
    ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN',
    es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ru: 'ru-RU',
    pt: 'pt-BR', it: 'it-IT', vi: 'vi-VN', th: 'th-TH',
    ar: 'ar-SA', hi: 'hi-IN', id: 'id-ID',
  }
  return map[code] || 'en-US'
}

/** Strip markdown and special characters so TTS reads clean text. */
function sanitizeTtsText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')      // remove code blocks
    .replace(/`[^`]*`/g, '')             // remove inline code
    .replace(/!\[.*?\]\(.*?\)/g, '')     // remove images ![alt](url)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text only
    .replace(/#{1,6}\s/g, '')            // headings
    .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2') // bold/italic markers
    .replace(/~~(.*?)~~/g, '$1')         // strikethrough
    .replace(/^[\s]*[-*+]\s/gm, '')      // list markers
    .replace(/^[\s]*\d+\.\s/gm, '')      // numbered list markers
    .replace(/^>\s?/gm, '')              // blockquote
    .replace(/\|/g, '')                  // table pipes
    .replace(/---+/g, '')               // horizontal rules
    .replace(/[*_~`#>|\\]/g, '')        // remaining markdown chars
    .replace(/\n{2,}/g, '\n')            // collapse multiple newlines
    .trim()
}

function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function TalkClawIcon() {
  return (
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-10 w-10">
      <defs>
        <linearGradient id="lobster-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="100%" stopColor="#991b1b" />
        </linearGradient>
      </defs>
      <path
        d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
        fill="url(#lobster-gradient)"
      />
      <path
        d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
        fill="url(#lobster-gradient)"
      />
      <path
        d="M100 35 C112 28 118 36 114 44 C110 52 102 50 97 42 C94 36 97 33 100 35Z"
        fill="url(#lobster-gradient)"
      />

      <g transform="translate(110, 24) rotate(8)">
        <rect x="-7" y="-7" width="14" height="18" rx="7" fill="#374151" stroke="#050810" strokeWidth="1.5" />
        <path d="M-4 -1 H4" stroke="#050810" strokeWidth="1" />
        <path d="M-4 3 H4" stroke="#050810" strokeWidth="1" />
        <rect x="-2" y="11" width="4" height="10" rx="2" fill="#050810" />
        <path d="M-6 24 H6" stroke="#050810" strokeWidth="2" strokeLinecap="round" />
      </g>

      <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <circle cx="45" cy="35" r="6" fill="#050810" />
      <circle cx="75" cy="35" r="6" fill="#050810" />
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
      <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />

      <path
        d="M50 56 C50 52 56 50 60 50 C64 50 70 52 70 56 C70 62 65 68 60 68 C55 68 50 62 50 56 Z"
        fill="#050810"
      />
      <path
        d="M54 56 C54 54 57 53 60 53 C63 53 66 54 66 56 C66 59 63 64 60 64 C57 64 54 59 54 56 Z"
        fill="#ffffff"
        opacity="0.18"
      />
      <path
        d="M78 52 Q84 56 78 60"
        stroke="#050810"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        opacity="0.55"
      />
      <path
        d="M82 48 Q90 56 82 64"
        stroke="#050810"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        opacity="0.35"
      />
    </svg>
  )
}

export default function App() {
  const wsRef = useRef<WebSocket | null>(null)

  // mic capture state (not in React state to avoid rerender pressure)
  const micAudioContextRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const micSinkRef = useRef<GainNode | null>(null)
  const pcmRemainderRef = useRef<Uint8Array>(new Uint8Array(0))

  // assistant draft tracking
  const assistantDraftIdRef = useRef<string | null>(null)

  // playback
  const playbackContextRef = useRef<AudioContext | null>(null)
  const playbackQueueRef = useRef<string[]>([])
  const playbackBusyRef = useRef(false)

  const [tokenFieldVisible, setTokenFieldVisible] = useState(true)
  const [token, setToken] = useState<string>(() => localStorage.getItem(LS.token) || '')

  const [wsStatus, setWsStatus] = useState<WsStatus>('offline')
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('locked')
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem(LS.ttsEnabled) !== '0')

  const manualDisconnectRef = useRef(false)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)

  const [sttPartial, setSttPartial] = useState('')
  const [chat, setChat] = useState<ChatMsg[]>([])

  const [talkActive, setTalkActive] = useState(false)
  const [micLevel, setMicLevel] = useState(0) // 0..1 (RMS-ish)
  const levelRafRef = useRef<number | null>(null)
  const micLevelRef = useRef(0)

  // routing target (OpenClaw channel session)
  const [targetSessionKey, setTargetSessionKey] = useState<string>(() => localStorage.getItem(LS.targetSessionKey) || '')
  const [targets, setTargets] = useState<Array<{ sessionKey: string; displayName: string; channel: string; to: string }>>([])

  // TTS/STT settings
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>(() => (localStorage.getItem(LS.ttsProvider) as TtsProvider) || 'browser')
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceUri, setSelectedVoiceUri] = useState<string>(() => localStorage.getItem(LS.ttsVoiceUri) || '')
  const [ttsApiKey, setTtsApiKey] = useState<string>(() => localStorage.getItem(LS.ttsApiKey) || '')
  const [ttsModel, setTtsModel] = useState<string>(() => localStorage.getItem(LS.ttsModel) || 'tts-1')
  const [ttsVoiceName, setTtsVoiceName] = useState<string>(() => localStorage.getItem(LS.ttsVoiceName) || 'alloy')
  const [ttsCustomUrl, setTtsCustomUrl] = useState<string>(() => localStorage.getItem(LS.ttsCustomUrl) || '')
  const [sttLanguage, setSttLanguage] = useState<string>(() => localStorage.getItem(LS.sttLanguage) || detectDeviceLanguage())
  const [sttModelSize, setSttModelSize] = useState<string>(() => localStorage.getItem(LS.sttModelSize) || 'medium')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('models')
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [previewError, setPreviewError] = useState('')

  // Refs for SSE event handler access (avoids stale closures)
  const ttsProviderRef = useRef(ttsProvider)
  const selectedVoiceUriRef = useRef(selectedVoiceUri)
  const sttLanguageRef = useRef(sttLanguage)
  const browserVoicesRef = useRef<SpeechSynthesisVoice[]>(browserVoices)
  const ttsApiKeyRef = useRef(ttsApiKey)
  const ttsModelRef = useRef(ttsModel)
  const ttsVoiceNameRef = useRef(ttsVoiceName)
  const ttsCustomUrlRef = useRef(ttsCustomUrl)

  // bridge SSE subscription (streams channel responses back)
  const bridgeIdRef = useRef<string | null>(null)
  const bridgeEsRef = useRef<EventSource | null>(null)
  const ttsEnabledRef = useRef(ttsEnabled)
  // Accumulate stt_final texts during push-to-talk; flush as one message on button release.
  const sttAccumulatorRef = useRef<string[]>([])

  async function refreshTargets() {
    try {
      const r = await fetch('/bridge/targets?limit=50')
      if (!r.ok) return
      const data = (await r.json()) as any
      if (data?.ok && Array.isArray(data.targets)) setTargets(data.targets)
    } catch {
      // ignore
    }
  }

  async function injectToTarget(text: string) {
    const t = text.trim()
    if (!t || !targetSessionKey) return
    try {
      await fetch('/bridge/inject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionKey: targetSessionKey, text: t }),
      })
    } catch {
      // ignore
    }
  }

  // Keep refs in sync with state
  useEffect(() => { ttsProviderRef.current = ttsProvider }, [ttsProvider])
  useEffect(() => { selectedVoiceUriRef.current = selectedVoiceUri }, [selectedVoiceUri])
  useEffect(() => { sttLanguageRef.current = sttLanguage }, [sttLanguage])
  useEffect(() => { browserVoicesRef.current = browserVoices }, [browserVoices])
  useEffect(() => { ttsApiKeyRef.current = ttsApiKey }, [ttsApiKey])
  useEffect(() => { ttsModelRef.current = ttsModel }, [ttsModel])
  useEffect(() => { ttsVoiceNameRef.current = ttsVoiceName }, [ttsVoiceName])
  useEffect(() => { ttsCustomUrlRef.current = ttsCustomUrl }, [ttsCustomUrl])

  // Load browser speech synthesis voices
  useEffect(() => {
    const load = () => setBrowserVoices(window.speechSynthesis?.getVoices() || [])
    load()
    window.speechSynthesis?.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load)
  }, [])

  // settings modal
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [engines, setEngines] = useState<string[]>([])
  const [models, setModels] = useState<string[]>([])

  const [profileKey, setProfileKey] = useState<string>(() => localStorage.getItem(LS.profile) || '')
  const [engine, setEngine] = useState<string>(() => localStorage.getItem(LS.engine) || 'codex')
  const [modelSearch, setModelSearch] = useState<string>(() => localStorage.getItem(LS.model) || '')

  const isConnected = wsStatus === 'online'
  const cliMode = !profileKey // default means "CLI/Env"

  const wsUrl = useMemo(() => {
    const tokenTrimmed = (token || '').replace(/\s+/g, '')

    const m = localStorage.getItem(LS.model) || ''
    const p = localStorage.getItem(LS.profile) || ''
    const e = localStorage.getItem(LS.engine) || ''
    const lang = localStorage.getItem(LS.sttLanguage) || detectDeviceLanguage()
    const modelSize = localStorage.getItem(LS.sttModelSize) || 'medium'

    const params = new URLSearchParams()
    if (tokenTrimmed) params.set('token', tokenTrimmed)
    if (m) params.set('model', m)
    if (p) params.set('profile', p)
    if (e) params.set('engine', e)
    if (lang && lang !== 'auto') params.set('language', lang)
    if (modelSize && modelSize !== 'medium') params.set('model_size', modelSize)

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const qs = params.toString() ? `?${params.toString()}` : ''
    return `${protocol}://${window.location.host}/ws/chat${qs}`
  }, [token, sttLanguage, sttModelSize])

  // Auto-scroll removed — on mobile it pushes the voice button off-screen.

  useEffect(() => {
    // Hide token field automatically when server auth is disabled.
    ;(async () => {
      try {
        const r = await fetch('/api/runtime')
        if (!r.ok) return
        const rt = (await r.json()) as any
        const authEnabled = Boolean(rt && rt.auth_enabled)
        if (!authEnabled) {
          setTokenFieldVisible(false)
          setToken('')
          localStorage.removeItem(LS.token)
        }
      } catch {
        // ignore
      }
    })()

    // (Re-enabled) Gemini engine is supported again.
    if (localStorage.getItem(LS.engine) === '__never__') {
      localStorage.removeItem(LS.engine)
      setEngine('codex')
      addMeta("Cleared unsupported engine 'gemini' (using codex)")
    }

    void refreshTargets()
  }, [])

  // Bridge attach + SSE subscription: when targetSessionKey changes, attach and subscribe.
  useEffect(() => {
    if (bridgeEsRef.current) {
      bridgeEsRef.current.close()
      bridgeEsRef.current = null
    }
    bridgeIdRef.current = null

    if (!targetSessionKey) return

    let cancelled = false

    ;(async () => {
      try {
        const r = await fetch('/bridge/attach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionKey: targetSessionKey }),
        })
        if (cancelled) return
        if (!r.ok) return

        const data = (await r.json()) as any
        if (cancelled || !data?.ok || !data?.bridgeId) return

        bridgeIdRef.current = data.bridgeId

        const es = new EventSource(`/bridge/stream?bridgeId=${encodeURIComponent(data.bridgeId)}`)
        bridgeEsRef.current = es

        es.addEventListener('assistant_delta', (e) => {
          try {
            const d = JSON.parse((e as MessageEvent).data)
            if (d.delta) appendAssistantDelta(d.delta)
          } catch { /* ignore */ }
        })

        es.addEventListener('assistant_final', (e) => {
          try {
            const d = JSON.parse((e as MessageEvent).data)
            const text = d.text || ''
            finalizeAssistant(text)
            if (text && ttsEnabledRef.current) {
              if (ttsProviderRef.current === 'browser') {
                if (window.speechSynthesis) {
                  const utt = new SpeechSynthesisUtterance(sanitizeTtsText(text))
                  const voice = browserVoicesRef.current.find(v => v.voiceURI === selectedVoiceUriRef.current)
                  if (voice) utt.voice = voice
                  else utt.lang = langCodeToLocale(sttLanguageRef.current)
                  window.speechSynthesis.speak(utt)
                }
              } else {
                void playExternalTts(text)
              }
            }
          } catch { /* ignore */ }
        })

        es.addEventListener('assistant_reset', () => {
          commitAssistantDraft()
        })
      } catch { /* ignore */ }
    })()

    return () => {
      cancelled = true
      if (bridgeEsRef.current) {
        bridgeEsRef.current.close()
        bridgeEsRef.current = null
      }
      bridgeIdRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSessionKey])

  useEffect(() => {
    if (localStorage.getItem(LS.audioUnlocked) === '1') {
      void unlockAudio(false)
    }

    const onVis = () => {
      if (document.visibilityState === 'visible' && wsStatus === 'offline') {
        scheduleReconnect('visibility')
      }
    }
    const onFocus = () => {
      if (wsStatus === 'offline') scheduleReconnect('focus')
    }

    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)

    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
      clearReconnectTimer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsStatus])

  function addMeta(text: string) {
    setChat((c) => [...c, { id: uid(), role: 'meta', text }])
  }

  function addMessage(role: Exclude<Role, 'meta'>, text: string) {
    setChat((c) => [...c, { id: uid(), role, text }])
  }

  function commitAssistantDraft() {
    assistantDraftIdRef.current = null
  }

  function appendAssistantDelta(delta: string) {
    setChat((c) => {
      const draftId = assistantDraftIdRef.current
      if (!draftId) {
        const id = uid()
        assistantDraftIdRef.current = id
        return [...c, { id, role: 'assistant', text: delta }]
      }

      return c.map((m) => (m.id === draftId ? { ...m, text: m.text + delta } : m))
    })
  }

  function finalizeAssistant(finalText: string) {
    setChat((c) => {
      const draftId = assistantDraftIdRef.current
      assistantDraftIdRef.current = null

      if (draftId) {
        return c.map((m) => {
          if (m.id !== draftId) return m
          if (finalText && finalText.length > m.text.length) return { ...m, text: finalText }
          return m
        })
      }

      if (finalText) return [...c, { id: uid(), role: 'assistant', text: finalText }]
      return c
    })
  }

  function sendJson(payload: any) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
  }

  async function unlockAudio(persist: boolean) {
    try {
      if (!playbackContextRef.current) playbackContextRef.current = new AudioContext()

      const ctx = playbackContextRef.current
      if (ctx.state !== 'running') await ctx.resume()

      // Play near-silent buffer to fully unlock.
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start()

      if (persist) localStorage.setItem(LS.audioUnlocked, '1')

      setAudioStatus('unlocked')
      addMeta('Audio enabled')
    } catch (err: any) {
      setAudioStatus('locked')
      addMeta(`Audio unlock failed: ${err?.name || 'Error'}`)
    }
  }

  function toggleTts() {
    const next = !ttsEnabled
    setTtsEnabled(next)
    ttsEnabledRef.current = next
    localStorage.setItem(LS.ttsEnabled, next ? '1' : '0')
    if (!next) window.speechSynthesis?.cancel()
  }

  async function playExternalTts(text: string) {
    try {
      const res = await fetch('/bridge/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: sanitizeTtsText(text),
          provider: ttsProviderRef.current,
          apiKey: ttsApiKeyRef.current,
          model: ttsModelRef.current,
          voice: ttsVoiceNameRef.current,
          customUrl: ttsCustomUrlRef.current,
        }),
      })
      const data = await res.json()
      if (data.ok && data.audio) enqueueAudio(data.audio)
      else addMeta(`TTS error: ${data.error || 'unknown'}`)
    } catch (err: any) {
      addMeta(`TTS error: ${err?.message || 'fetch failed'}`)
    }
  }

  async function previewVoice() {
    if (previewPlaying) return
    const sampleText = sttLanguage === 'ko' ? '안녕하세요, 이것은 음성 테스트입니다.'
      : sttLanguage === 'ja' ? 'こんにちは、これは音声テストです。'
      : sttLanguage === 'zh' ? '你好，这是一个语音测试。'
      : 'Hello, this is a voice preview test.'

    setPreviewPlaying(true)
    setPreviewError('')
    try {
      if (ttsProvider === 'browser') {
        window.speechSynthesis?.cancel()
        const utt = new SpeechSynthesisUtterance(sampleText)
        const voice = browserVoices.find(v => v.voiceURI === selectedVoiceUri)
        if (voice) utt.voice = voice
        else utt.lang = langCodeToLocale(sttLanguage)
        utt.onend = () => setPreviewPlaying(false)
        utt.onerror = () => { setPreviewPlaying(false); setPreviewError('Browser TTS failed') }
        window.speechSynthesis?.speak(utt)
      } else {
        const res = await fetch('/bridge/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: sampleText,
            provider: ttsProvider,
            apiKey: ttsApiKey,
            model: ttsModel,
            voice: ttsVoiceName,
            customUrl: ttsCustomUrl,
          }),
        })
        const data = await res.json()
        if (data.ok && data.audio) {
          if (!playbackContextRef.current) playbackContextRef.current = new AudioContext()
          const ctx = playbackContextRef.current
          if (ctx.state !== 'running') await ctx.resume()
          const buf = await ctx.decodeAudioData(base64ToArrayBuffer(data.audio))
          const source = ctx.createBufferSource()
          source.buffer = buf
          source.connect(ctx.destination)
          source.onended = () => setPreviewPlaying(false)
          source.start()
        } else {
          setPreviewError(data.error || 'Unknown error')
          setPreviewPlaying(false)
        }
      }
    } catch (err: any) {
      setPreviewError(err?.message || 'Connection failed')
      setPreviewPlaying(false)
    }
  }

  function enqueueAudio(base64Wav: string) {
    playbackQueueRef.current.push(base64Wav)
    if (!playbackBusyRef.current) void playNextAudio()
  }

  async function playNextAudio() {
    if (!playbackQueueRef.current.length) {
      playbackBusyRef.current = false
      return
    }

    playbackBusyRef.current = true

    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext()
      setAudioStatus(playbackContextRef.current.state === 'running' ? 'unlocked' : 'locked')
    }

    const wavBase64 = playbackQueueRef.current.shift()!
    const arrayBuffer = base64ToArrayBuffer(wavBase64)

    try {
      const ctx = playbackContextRef.current
      if (!ctx) throw new Error('no audio context')

      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      source.start()
      source.onended = () => void playNextAudio()
    } catch (err: any) {
      addMeta(`Audio decode/play failed: ${err?.name || 'Error'}`)
      void playNextAudio()
    }
  }

  async function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'ready':
        addMeta(`Ready (LLM=${(msg as any).llm}, TTS=${(msg as any).tts_enabled ? 'on' : 'off'})`)
        break
      case 'info': {
        const infoMsg: string = (msg as any).message || 'info'
        // When bridge is active, suppress WS backend LLM timing messages (they're irrelevant).
        if (bridgeIdRef.current && /\bllm\b/i.test(infoMsg)) break
        addMeta(infoMsg)
        break
      }
      case 'error':
        addMeta(`Error: ${(msg as any).message || 'unknown'}`)
        break
      case 'stt_partial':
        setSttPartial((msg as any).text || '')
        break
      case 'stt_final': {
        const t = (msg as any).text || ''
        setSttPartial('')
        if (t) {
          // Accumulate during push-to-talk; inject as one message on button release.
          sttAccumulatorRef.current.push(t)
        }
        break
      }
      case 'user_text': {
        const t = (msg as any).text || ''
        commitAssistantDraft()
        addMessage('user', t)
        // NOTE: Do NOT mirror here.
        // We mirror only on stt_final / manual text submit to avoid duplicates.
        break
      }
      case 'assistant_delta':
        // When bridge is active, suppress WS backend LLM responses (bridge SSE handles them).
        if (!bridgeIdRef.current) appendAssistantDelta((msg as any).text || '')
        break
      case 'assistant_final':
        if (!bridgeIdRef.current) finalizeAssistant((msg as any).text || '')
        break
      case 'command_result':
        commitAssistantDraft()
        addMessage('command', `[${(msg as any).kind}] ${(msg as any).text || ''}`)
        break
      case 'tts_audio':
        // When bridge is active, suppress WS backend TTS (bridge response will be TTS'd separately).
        if (!bridgeIdRef.current && ttsEnabledRef.current) {
          if (typeof (msg as any).audio === 'string') enqueueAudio((msg as any).audio)
        }
        break
      default:
        break
    }
  }

  function scheduleReconnect(reason: string) {
    if (manualDisconnectRef.current) return
    if (reconnectTimerRef.current != null) return

    const attempt = reconnectAttemptRef.current
    const baseMs = 500
    const maxMs = 10_000
    const backoff = Math.min(maxMs, Math.floor(baseMs * Math.pow(1.8, attempt)))
    const jitter = Math.floor(Math.random() * 250)
    const delayMs = backoff + jitter

    reconnectAttemptRef.current = attempt + 1
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      if (document.visibilityState === 'hidden') {
        // Don't fight mobile background throttling.
        scheduleReconnect('hidden')
        return
      }
      addMeta(`Reconnecting… (${reason}, attempt ${reconnectAttemptRef.current})`)
      connect()
    }, delayMs)
  }

  function clearReconnectTimer() {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }

  function connect() {
    if (wsRef.current) return

    manualDisconnectRef.current = false
    clearReconnectTimer()

    const tokenTrimmed = (token || '').replace(/\s+/g, '')
    setToken(tokenTrimmed)
    if (tokenTrimmed) localStorage.setItem(LS.token, tokenTrimmed)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setWsStatus('online')
      reconnectAttemptRef.current = 0
      addMeta('Connected')
      const ctx = playbackContextRef.current
      if (ctx && ctx.state !== 'running') void ctx.resume()
    }

    ws.onclose = (event) => {
      addMeta(`Disconnected (${event.code})`)
      setWsStatus('offline')
      wsRef.current = null
      stopMic()
      scheduleReconnect(`close:${event.code}`)
    }

    ws.onerror = () => {
      addMeta('WebSocket error')
      // Let onclose drive the reconnect; onerror can happen before close.
    }

    ws.onmessage = async (event) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      await handleServerMessage(msg)
    }
  }

  function disconnect() {
    manualDisconnectRef.current = true
    clearReconnectTimer()
    reconnectAttemptRef.current = 0

    if (!wsRef.current) return
    wsRef.current.close()
    wsRef.current = null
  }

  function pushAudioBytes(bytes: Uint8Array) {
    const rem = pcmRemainderRef.current
    const merged = new Uint8Array(rem.length + bytes.length)
    merged.set(rem, 0)
    merged.set(bytes, rem.length)
    pcmRemainderRef.current = merged

    while (pcmRemainderRef.current.length >= FRAME_BYTES) {
      const frame = pcmRemainderRef.current.slice(0, FRAME_BYTES)
      pcmRemainderRef.current = pcmRemainderRef.current.slice(FRAME_BYTES)
      sendJson({ type: 'audio', pcm16: bytesToBase64(frame) })
    }
  }

  async function startMic() {
    if (!isConnected || micAudioContextRef.current) return

    if (!navigator.mediaDevices?.getUserMedia) {
      addMeta('Mic error: getUserMedia not available (need HTTPS context + mic permission)')
      return
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err: any) {
      addMeta(`Mic error: ${err?.name || 'UnknownError'} (${err?.message || ''})`)
      return
    }

    const audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    const sink = audioContext.createGain()
    sink.gain.value = 0

    micAudioContextRef.current = audioContext
    micStreamRef.current = stream
    micSourceRef.current = source
    micProcessorRef.current = processor
    micSinkRef.current = sink
    pcmRemainderRef.current = new Uint8Array(0)

    processor.onaudioprocess = (event) => {
      if (!isConnected) return

      const input = event.inputBuffer.getChannelData(0)

      // Mic level indicator (RMS)
      let sumSq = 0
      for (let i = 0; i < input.length; i += 1) {
        const s = input[i]!
        sumSq += s * s
      }
      const rms = Math.sqrt(sumSq / Math.max(1, input.length))
      // gentle smoothing
      micLevelRef.current = micLevelRef.current * 0.85 + rms * 0.15
      if (levelRafRef.current == null) {
        levelRafRef.current = requestAnimationFrame(() => {
          levelRafRef.current = null
          setMicLevel(Math.max(0, Math.min(1, micLevelRef.current)))
        })
      }

      const pcm16 = downsampleToPcm16(input, audioContext.sampleRate, 16000)
      if (!pcm16.length) return
      const bytes = pcm16ToBytes(pcm16)
      pushAudioBytes(bytes)
    }

    source.connect(processor)
    processor.connect(sink)
    sink.connect(audioContext.destination)

    addMeta('Mic streaming started')
  }

  function stopMic() {
    const audioContext = micAudioContextRef.current
    if (!audioContext) return

    try {
      micProcessorRef.current?.disconnect()
      micSourceRef.current?.disconnect()
      micSinkRef.current?.disconnect()
    } catch {
      // ignore
    }

    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    void audioContext.close()

    micAudioContextRef.current = null
    micStreamRef.current = null
    micSourceRef.current = null
    micProcessorRef.current = null
    micSinkRef.current = null
    pcmRemainderRef.current = new Uint8Array(0)

    micLevelRef.current = 0
    setMicLevel(0)

    sendJson({ type: 'flush' })

    // Flush accumulated STT finals as a single message to the channel.
    // Use a short delay to let the backend process the flush and emit any remaining stt_final.
    setTimeout(() => {
      const parts = sttAccumulatorRef.current
      sttAccumulatorRef.current = []
      if (parts.length > 0) {
        const combined = parts.join(' ')
        void injectToTarget(combined)
      }
    }, 500)

    addMeta('Mic streaming stopped')
  }

  // settings
  async function checkCliStatus() {
    setCliStatus(null)
    try {
      const r = await fetch('/api/cli/status')
      if (!r.ok) throw new Error('API Error')
      const data = (await r.json()) as CliStatus
      setCliStatus(data)

      const tools = data.tools && typeof data.tools === 'object' ? data.tools : {}
      const nextEngines: string[] = []
      if (tools['openclaw']) {
        nextEngines.push('codex', 'claude', 'gemini')
      } else {
        if (tools['codex']) nextEngines.push('codex')
        if (tools['claude']) nextEngines.push('claude')
        if (tools['gemini']) nextEngines.push('gemini')
      }
      setEngines(nextEngines)
    } catch {
      setCliStatus({ available: false })
      setEngines([])
    }
  }

  async function fetchProfiles() {
    try {
      const r = await fetch('/api/profiles')
      if (!r.ok) return
      const data = (await r.json()) as Profile[]
      setProfiles(data)
    } catch {
      setProfiles([])
    }
  }

  async function fetchModels(nextProfileKey: string, nextEngine: string) {
    // Try bridge catalog first (uses openclaw CLI for full model list).
    try {
      const r = await fetch('/bridge/models')
      if (r.ok) {
        const data = (await r.json()) as any
        if (data?.ok && Array.isArray(data.models)) {
          // Determine which provider to filter by from the selected profile.
          let providerFilter = ''
          if (nextProfileKey) {
            const prof = profiles.find((p) => p.key === nextProfileKey)
            if (prof?.provider) providerFilter = prof.provider
          }

          const allModels: string[] = data.models.map((m: any) => m.key as string).filter(Boolean)

          if (allModels.length > 0) {
            if (providerFilter) {
              const filtered = allModels.filter((k) => k.startsWith(providerFilter + '/'))
              // Meta-providers (e.g. GitHub Copilot) give access to models across
              // multiple underlying providers. If the filter yields no/few results,
              // fall back to showing all models.
              setModels(filtered.length > 0 ? filtered : allModels)
            } else {
              // No profile selected: show all models
              setModels(allModels)
            }
            return
          }
          // Bridge catalog returned no models (e.g. OPENCLAW_CLI not set) — fall through to legacy API.
        }
      }
    } catch {
      // fall through to legacy API
    }

    // Fallback: legacy Python backend /api/models.
    try {
      let url = '/api/models'
      const params = new URLSearchParams()
      if (nextProfileKey) params.set('profile', nextProfileKey)
      if (nextEngine && !nextProfileKey) params.set('engine', nextEngine)
      const qs = params.toString()
      if (qs) url += `?${qs}`

      const r = await fetch(url)
      if (!r.ok) return
      const data = (await r.json()) as string[]
      setModels(data)
    } catch {
      setModels([])
    }
  }

  async function openSettings() {
    // restore
    setModelSearch(localStorage.getItem(LS.model) || '')
    setProfileKey(localStorage.getItem(LS.profile) || '')
    setEngine(localStorage.getItem(LS.engine) || 'codex')

    // restore TTS/STT settings
    setTtsProvider((localStorage.getItem(LS.ttsProvider) as TtsProvider) || 'browser')
    setSelectedVoiceUri(localStorage.getItem(LS.ttsVoiceUri) || '')
    setTtsApiKey(localStorage.getItem(LS.ttsApiKey) || '')
    setTtsModel(localStorage.getItem(LS.ttsModel) || 'tts-1')
    setTtsVoiceName(localStorage.getItem(LS.ttsVoiceName) || 'alloy')
    setTtsCustomUrl(localStorage.getItem(LS.ttsCustomUrl) || '')
    setSttLanguage(localStorage.getItem(LS.sttLanguage) || detectDeviceLanguage())
    setSttModelSize(localStorage.getItem(LS.sttModelSize) || 'medium')
    setSettingsTab('models')

    dialogRef.current?.showModal()

    await checkCliStatus()
    await fetchProfiles()

    // fetchModels depends on profiles state — trigger via the useEffect below.
  }

  function saveSettings() {
    const modelVal = modelSearch.trim()
    if (modelVal) localStorage.setItem(LS.model, modelVal)
    else localStorage.removeItem(LS.model)

    if (profileKey) localStorage.setItem(LS.profile, profileKey)
    else localStorage.removeItem(LS.profile)

    if (engine) localStorage.setItem(LS.engine, engine)
    else localStorage.removeItem(LS.engine)

    // TTS settings
    localStorage.setItem(LS.ttsProvider, ttsProvider)
    if (selectedVoiceUri) localStorage.setItem(LS.ttsVoiceUri, selectedVoiceUri)
    else localStorage.removeItem(LS.ttsVoiceUri)
    if (ttsApiKey) localStorage.setItem(LS.ttsApiKey, ttsApiKey)
    else localStorage.removeItem(LS.ttsApiKey)
    if (ttsModel) localStorage.setItem(LS.ttsModel, ttsModel)
    else localStorage.removeItem(LS.ttsModel)
    if (ttsVoiceName) localStorage.setItem(LS.ttsVoiceName, ttsVoiceName)
    else localStorage.removeItem(LS.ttsVoiceName)
    if (ttsCustomUrl) localStorage.setItem(LS.ttsCustomUrl, ttsCustomUrl)
    else localStorage.removeItem(LS.ttsCustomUrl)

    // STT settings
    localStorage.setItem(LS.sttLanguage, sttLanguage)
    localStorage.setItem(LS.sttModelSize, sttModelSize)

    dialogRef.current?.close()
  }

  function cancelSettings() {
    dialogRef.current?.close()
  }

  const filteredModels = useMemo(() => {
    const filter = (modelSearch || '').toLowerCase()
    if (!filter) return models
    return models.filter((m) => m.toLowerCase().includes(filter))
  }, [models, modelSearch])

  // keep models in sync when profile/engine/profiles change inside dialog
  useEffect(() => {
    void fetchModels(profileKey, engine)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey, engine, profiles])

  // talk handlers
  const handleStartTalk = (e: React.MouseEvent | React.TouchEvent) => {
    // only left click
    if (e.type === 'mousedown') {
      const me = e as React.MouseEvent
      if (me.button !== 0) return
    }
    e.preventDefault()
    sttAccumulatorRef.current = []
    setTalkActive(true)
    void startMic()
  }

  const handleStopTalk = (e: any) => {
    e.preventDefault()
    setTalkActive(false)
    stopMic()
  }

  function sendTextInput(text: string) {
    const t = text.trim()
    if (!t) return
    if (bridgeIdRef.current) {
      // Channel connected: skip WS backend LLM, only inject to the channel.
      // Show user message locally since backend won't echo it back.
      commitAssistantDraft()
      addMessage('user', t)
      void injectToTarget(t)
    } else {
      // No channel: use WS backend LLM (backend echoes user_text + runs LLM).
      sendJson({ type: 'text', text: t })
    }
  }

  const [textInput, setTextInput] = useState('')

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 md:grid-cols-2">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Claw-Voice-Chat</h1>
              <div className="mt-1 text-xs text-zinc-500">
                Push-to-talk voice + streaming transcript (same protocol)
              </div>
            </div>

            <div className="flex flex-col items-end gap-2">
              <span
                className={
                  'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ' +
                  (isConnected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-300')
                }
              >
                <span
                  className={
                    'inline-block h-2 w-2 rounded-full ' + (isConnected ? 'bg-emerald-400' : 'bg-zinc-400')
                  }
                />
                {wsStatus}
              </span>

              <span
                className={
                  'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ' +
                  (talkActive ? 'bg-sky-500/15 text-sky-200' : 'bg-zinc-700/30 text-zinc-300')
                }
              >
                <span className={'inline-block h-2 w-2 rounded-full ' + (talkActive ? 'bg-sky-400' : 'bg-zinc-500')} />
                mic: {talkActive ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>

          {tokenFieldVisible ? (
            <label className="mt-4 block">
              <div className="text-xs font-medium text-zinc-400">Auth Token</div>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                placeholder="VCB_AUTH_TOKEN"
                className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              />
            </label>
          ) : null}

          <div className="mt-4 grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <button
              onClick={connect}
              disabled={isConnected}
              className="col-span-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Connect
            </button>
            <button
              onClick={disconnect}
              disabled={!isConnected}
              className="col-span-1 rounded-lg bg-zinc-700 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-600 disabled:opacity-50"
            >
              Disconnect
            </button>
            <button
              onClick={() => void openSettings()}
              className="col-span-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700"
            >
              Options
            </button>

            <div className="col-span-3 mt-2 grid grid-cols-1 gap-2 sm:mt-0 sm:grid-cols-[1fr_auto] sm:items-center">
              <select
                value={targetSessionKey}
                onChange={(e) => {
                  setTargetSessionKey(e.target.value)
                  if (e.target.value) localStorage.setItem(LS.targetSessionKey, e.target.value)
                  else localStorage.removeItem(LS.targetSessionKey)
                }}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                title="Mirror STT/text into an OpenClaw channel session"
              >
                <option value="">(no channel selected)</option>
                {targets.map((t) => (
                  <option key={t.sessionKey} value={t.sessionKey}>
                    {t.displayName || `${t.channel}:${t.to}`}
                  </option>
                ))}
              </select>

              <button
                onClick={() => void refreshTargets()}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-stretch">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <button
                    disabled={!isConnected}
                    onMouseDown={handleStartTalk}
                    onMouseUp={handleStopTalk}
                    onMouseLeave={(e) => {
                      if (micAudioContextRef.current) handleStopTalk(e)
                    }}
                    onTouchStart={handleStartTalk}
                    onTouchEnd={handleStopTalk}
                    onTouchCancel={handleStopTalk}
                    className={
                      'group flex items-center justify-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold transition ' +
                      (!isConnected
                        ? 'border-zinc-800 bg-zinc-950/10 text-zinc-500'
                        : talkActive
                          ? 'border-sky-500 bg-sky-500/15 text-sky-100 shadow-[0_0_0_4px_rgba(56,189,248,0.08)]'
                          : 'border-zinc-700 bg-zinc-950/40 hover:bg-zinc-950/60')
                    }
                  >
                    <TalkClawIcon />
                    <span>Hold to Speak</span>
                  </button>

                  <div className="hidden sm:block">
                    <div className="text-xs font-medium text-zinc-400">Mic level</div>
                    <div className="mt-1 h-2 w-44 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className={
                          'h-full rounded-full transition-[width] duration-75 ' +
                          (talkActive ? 'bg-sky-400' : 'bg-zinc-600')
                        }
                        style={{ width: `${Math.round(micLevel * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">{talkActive ? 'listening…' : 'idle'}</div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-xs font-medium text-zinc-400">Controls</div>
                  <div className="mt-1 text-[11px] text-zinc-500">release to flush</div>
                </div>
              </div>

              <div className="mt-3 sm:hidden">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>Mic level</span>
                  <span>{talkActive ? 'listening…' : 'idle'}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={'h-full rounded-full transition-[width] duration-75 ' + (talkActive ? 'bg-sky-400' : 'bg-zinc-600')}
                    style={{ width: `${Math.round(micLevel * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <button
              onClick={() => sendJson({ type: 'reset' })}
              disabled={!isConnected}
              className="rounded-2xl bg-zinc-800 px-4 py-4 text-sm font-semibold hover:bg-zinc-700 disabled:opacity-50"
            >
              Reset Chat
            </button>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
            {audioStatus === 'locked' ? (
              <button
                onClick={() => void unlockAudio(true)}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm font-semibold hover:bg-zinc-700"
              >
                Enable Audio
              </button>
            ) : (
              <button
                onClick={toggleTts}
                className={
                  'rounded-lg px-3 py-2 text-sm font-semibold ' +
                  (ttsEnabled
                    ? 'bg-emerald-600 hover:bg-emerald-500'
                    : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400')
                }
              >
                {ttsEnabled ? 'TTS On' : 'TTS Off'}
              </button>
            )}
            <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2">
              <div className="text-xs text-zinc-400">Playback</div>
              <span
                className={
                  'inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs font-medium ' +
                  (audioStatus === 'unlocked'
                    ? ttsEnabled
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-amber-500/15 text-amber-300'
                    : 'bg-zinc-700/40 text-zinc-300')
                }
              >
                <span
                  className={
                    'inline-block h-2 w-2 rounded-full ' +
                    (audioStatus === 'unlocked'
                      ? ttsEnabled ? 'bg-emerald-400' : 'bg-amber-400'
                      : 'bg-zinc-400')
                  }
                />
                {audioStatus === 'unlocked' ? (ttsEnabled ? 'TTS on' : 'TTS off') : 'locked'}
              </span>
            </div>
          </div>

          <label className="mt-4 block">
            <div className="text-xs font-medium text-zinc-400">Type Message</div>
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              rows={3}
              placeholder="Type text, #kanban, *obsidian, /img prompt"
              className="mt-2 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  const t = textInput
                  setTextInput('')
                  sendTextInput(t)
                }
              }}
            />
          </label>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => {
                const t = textInput
                setTextInput('')
                sendTextInput(t)
              }}
              disabled={!isConnected}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Send Text
            </button>
            <div className="min-h-[1.25rem] flex-1 text-xs text-emerald-300/90">{sttPartial}</div>
          </div>

          <details className="mt-4 rounded-xl border border-zinc-800 bg-black/20 p-3 text-[11px] text-zinc-400">
            <summary className="cursor-pointer select-none text-xs font-semibold text-zinc-300">Connection details</summary>
            <div className="mt-2">
              <div className="text-[11px] text-zinc-500">WebSocket URL</div>
              <div className="mt-1 break-all rounded-lg border border-zinc-800 bg-black/30 p-2">{wsUrl}</div>
            </div>
          </details>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Transcript</h2>
            <div className="text-xs text-zinc-500">{chat.length} lines</div>
          </div>
          <div className="mt-3 h-[70vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
            {chat.length ? (
              chat.map((m) => (
                <div
                  key={m.id}
                  className={
                    'mb-2 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ' +
                    (m.role === 'meta'
                      ? 'bg-zinc-800/40 text-zinc-300'
                      : m.role === 'user'
                        ? 'bg-sky-500/10 text-sky-200'
                        : m.role === 'command'
                          ? 'bg-amber-500/10 text-amber-200'
                          : 'bg-emerald-500/10 text-emerald-100')
                  }
                >
                  {m.text}
                </div>
              ))
            ) : (
              <div className="text-sm text-zinc-500">(no messages yet)</div>
            )}
          </div>
        </section>

        <dialog ref={dialogRef as any} className="backdrop:bg-black/70">
          <div className="w-[min(980px,95vw)] rounded-2xl border border-zinc-800 bg-zinc-950 p-5 text-zinc-100">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">Configuration</div>
                <div className="mt-1 flex gap-1">
                  {(['models', 'voice'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={
                        'rounded-lg px-3 py-1.5 text-xs font-medium transition ' +
                        (settingsTab === tab
                          ? 'bg-emerald-600/20 text-emerald-300'
                          : 'text-zinc-400 hover:text-zinc-200')
                      }
                      onClick={() => setSettingsTab(tab)}
                    >
                      {tab === 'models' ? 'Models' : 'TTS / STT'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-400">CLI Status:</span>
                  <span
                    title={cliStatus?.version || ''}
                    className={
                      'inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium ' +
                      (cliStatus?.available ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-300')
                    }
                  >
                    {cliStatus ? (cliStatus.available ? 'Active' : 'Not Found') : 'Checking...'}
                  </span>
                </div>
                {cliStatus?.tools ? (
                  <div className="mt-2 grid max-w-[460px] grid-cols-1 gap-1">
                    {Object.entries(cliStatus.tools).length ? (
                      Object.entries(cliStatus.tools).map(([name, path]) => (
                        <div key={name} className="flex items-center justify-between gap-2">
                          <span className="font-medium text-zinc-200">{name}</span>
                          <span className="truncate text-zinc-500" title={path}>
                            {path}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="text-zinc-500">No CLI tools detected</div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            {settingsTab === 'models' ? (
            <div className={`mt-5 grid grid-cols-1 gap-4 ${cliMode ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
              {/* Profile */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="font-semibold">Profile</div>
                  <div className="text-xs text-zinc-500">Auth & Context</div>
                </div>
                <div className="mt-3 space-y-2">
                  <button
                    type="button"
                    className={
                      'w-full rounded-lg border px-3 py-2 text-left text-sm ' +
                      (!profileKey ? 'border-emerald-500 bg-emerald-600/10' : 'border-zinc-700 hover:bg-zinc-900/40')
                    }
                    onClick={() => setProfileKey('')}
                  >
                    <div className="font-medium">Default (CLI/Env)</div>
                    <div className="text-xs text-zinc-500">Use server defaults</div>
                  </button>

                  {profiles.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={
                        'w-full rounded-lg border px-3 py-2 text-left text-sm ' +
                        (profileKey === p.key
                          ? 'border-emerald-500 bg-emerald-600/10'
                          : 'border-zinc-700 hover:bg-zinc-900/40')
                      }
                      onClick={() => setProfileKey(p.key)}
                    >
                      <div className="font-medium">{p.key}</div>
                      <div className="text-xs text-zinc-500">
                        {p.provider || ''}
                        {p.mode ? ` • ${p.mode}` : ''}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Engine (CLI mode only) */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="font-semibold">Engine</div>
                  <div className="text-xs text-zinc-500">CLI Tool</div>
                </div>
                {!cliMode ? (
                  <div className="mt-3 text-sm text-zinc-500">Hidden (OAuth profile selected)</div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {engines.length ? (
                      engines.map((eng) => (
                        <button
                          key={eng}
                          type="button"
                          className={
                            'w-full rounded-lg border px-3 py-2 text-left text-sm ' +
                            (engine === eng
                              ? 'border-emerald-500 bg-emerald-600/10'
                              : 'border-zinc-700 hover:bg-zinc-900/40')
                          }
                          onClick={() => setEngine(eng)}
                        >
                          <div className="font-medium">{eng}</div>
                          <div className="text-xs text-zinc-500">CLI</div>
                        </button>
                      ))
                    ) : (
                      <div className="text-sm text-zinc-500">No engines detected</div>
                    )}
                  </div>
                )}
              </div>

              {/* Model (hidden in CLI/Env mode — engine handles model selection) */}
              {!cliMode ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="font-semibold">Model</div>
                  <div className="text-xs text-zinc-500">Inference Engine</div>
                </div>

                <input
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search or type custom model..."
                  className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                />

                <div className="mt-3 max-h-[320px] space-y-2 overflow-auto pr-1">
                  {!models.length && !modelSearch ? (
                    <div className="rounded-lg border border-zinc-800 bg-black/20 p-3 text-sm text-zinc-500">
                      No models found.
                      <div className="text-xs opacity-70">Ensure OpenClaw CLI is available or models are cached.</div>
                    </div>
                  ) : filteredModels.length === 0 && modelSearch ? (
                    <div className="rounded-lg border border-zinc-800 bg-black/20 p-3 text-sm text-zinc-500">
                      No matches. Using custom: "{modelSearch}"
                    </div>
                  ) : (
                    filteredModels.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={
                          'w-full rounded-lg border px-3 py-2 text-left text-sm ' +
                          (modelSearch === m
                            ? 'border-emerald-500 bg-emerald-600/10'
                            : 'border-zinc-700 hover:bg-zinc-900/40')
                        }
                        onClick={() => setModelSearch(m)}
                      >
                        {m}
                      </button>
                    ))
                  )}
                </div>
              </div>
              ) : null}
            </div>
            ) : (
            <div className="mt-5 space-y-5">
              {/* TTS Provider */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4">
                <div className="font-semibold">TTS Provider</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(['browser', 'openai', 'qwen', 'custom'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={
                        'rounded-lg border px-3 py-2 text-sm font-medium ' +
                        (ttsProvider === p
                          ? 'border-emerald-500 bg-emerald-600/10 text-emerald-300'
                          : 'border-zinc-700 text-zinc-300 hover:bg-zinc-900/40')
                      }
                      onClick={() => {
                        setTtsProvider(p)
                        const defaults = TTS_PROVIDER_DEFAULTS[p]
                        setTtsModel(defaults.model)
                        setTtsVoiceName(defaults.voice)
                        setTtsApiKey('')
                        setTtsCustomUrl('')
                        setPreviewError('')
                      }}
                    >
                      {p === 'browser' ? 'Browser' : p === 'openai' ? 'OpenAI' : p === 'qwen' ? 'Qwen' : 'Custom'}
                    </button>
                  ))}
                </div>

                <div className="mt-4">
                  {ttsProvider === 'browser' ? (
                    <label className="block">
                      <div className="text-xs font-medium text-zinc-400">Voice</div>
                      <select
                        value={selectedVoiceUri}
                        onChange={(e) => setSelectedVoiceUri(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                      >
                        <option value="">(system default)</option>
                        {(() => {
                          const groups: Record<string, SpeechSynthesisVoice[]> = {}
                          for (const v of browserVoices) {
                            const lang = v.lang.split('-')[0] || 'other'
                            ;(groups[lang] ??= []).push(v)
                          }
                          return Object.entries(groups)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([lang, voices]) => (
                              <optgroup key={lang} label={lang.toUpperCase()}>
                                {voices.map((v) => (
                                  <option key={v.voiceURI} value={v.voiceURI}>
                                    {v.name} ({v.lang})
                                  </option>
                                ))}
                              </optgroup>
                            ))
                        })()}
                      </select>
                    </label>
                  ) : ttsProvider === 'openai' ? (
                    <div className="space-y-3">
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">API Key</div>
                        <input
                          type="password"
                          value={ttsApiKey}
                          onChange={(e) => setTtsApiKey(e.target.value)}
                          placeholder="sk-..."
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">Model</div>
                        <select
                          value={ttsModel}
                          onChange={(e) => setTtsModel(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        >
                          <option value="tts-1">tts-1</option>
                          <option value="tts-1-hd">tts-1-hd</option>
                          <option value="gpt-4o-mini-tts">gpt-4o-mini-tts</option>
                        </select>
                      </label>
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">Voice</div>
                        <select
                          value={ttsVoiceName}
                          onChange={(e) => setTtsVoiceName(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        >
                          {['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'].map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : ttsProvider === 'qwen' ? (
                    <div className="space-y-3">
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">DashScope API Key</div>
                        <input
                          type="password"
                          value={ttsApiKey}
                          onChange={(e) => setTtsApiKey(e.target.value)}
                          placeholder="sk-..."
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">Voice</div>
                        <input
                          value={ttsVoiceName}
                          onChange={(e) => setTtsVoiceName(e.target.value)}
                          placeholder="longxiaochun"
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                        <div className="mt-1 text-[11px] text-zinc-500">e.g. longxiaochun, longwan, longyue</div>
                      </label>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">Endpoint URL</div>
                        <input
                          value={ttsCustomUrl}
                          onChange={(e) => setTtsCustomUrl(e.target.value)}
                          placeholder="https://api.example.com/v1/audio/speech"
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">API Key (optional)</div>
                        <input
                          type="password"
                          value={ttsApiKey}
                          onChange={(e) => setTtsApiKey(e.target.value)}
                          placeholder="Bearer token"
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">Model (optional)</div>
                        <input
                          value={ttsModel}
                          onChange={(e) => setTtsModel(e.target.value)}
                          placeholder="model name"
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-400">Voice (optional)</div>
                        <input
                          value={ttsVoiceName}
                          onChange={(e) => setTtsVoiceName(e.target.value)}
                          placeholder="voice name"
                          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                      </label>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={previewPlaying || (ttsProvider !== 'browser' && !ttsApiKey && ttsProvider !== 'custom') || (ttsProvider === 'custom' && !ttsCustomUrl)}
                    className={
                      'rounded-lg border px-4 py-2 text-sm font-medium transition ' +
                      (previewPlaying
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 text-zinc-300 hover:bg-zinc-900/40')
                    }
                    onClick={() => void previewVoice()}
                  >
                    {previewPlaying ? 'Playing...' : 'Preview Voice'}
                  </button>
                  {previewError ? (
                    <span className="text-xs text-red-400">{previewError}</span>
                  ) : null}
                </div>
              </div>

              {/* STT Settings */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4">
                <div className="font-semibold mb-3">STT Settings</div>

                {/* Model Size */}
                <div className="mb-4">
                  <div className="flex items-baseline justify-between">
                    <div className="text-sm text-zinc-300">Model Size</div>
                    <div className="text-xs text-zinc-500">Accuracy vs speed trade-off</div>
                  </div>
                  <div className="mt-2 grid grid-cols-5 gap-1">
                    {STT_MODEL_SIZES.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                          sttModelSize === s.value
                            ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                            : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                        }`}
                        onClick={() => setSttModelSize(s.value)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[11px] text-zinc-500">
                    {STT_MODEL_SIZES.find((s) => s.value === sttModelSize)?.desc || ''}
                    {sttModelSize !== 'medium' ? ' — Reconnect to apply.' : ''}
                  </div>
                </div>

                {/* Language */}
                <div className="flex items-baseline justify-between">
                  <div className="text-sm text-zinc-300">Language</div>
                  <div className="text-xs text-zinc-500">Speech recognition hint</div>
                </div>
                <select
                  value={sttLanguage}
                  onChange={(e) => setSttLanguage(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                >
                  {STT_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
                <div className="mt-2 text-[11px] text-zinc-500">
                  Sets the language hint for faster-whisper STT. Also used as fallback TTS language for browser voices.
                </div>
              </div>
            </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm font-medium hover:bg-zinc-700"
                onClick={cancelSettings}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                onClick={saveSettings}
              >
                Save Changes
              </button>
            </div>
          </div>
        </dialog>
      </main>
    </div>
  )
}
