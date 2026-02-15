export type ServerMessage =
  | { type: 'ready'; llm?: string; tts_enabled?: boolean }
  | { type: 'info'; message?: string }
  | { type: 'error'; message?: string }
  | { type: 'stt_partial'; text?: string }
  | { type: 'stt_final'; text?: string }
  | { type: 'user_text'; text?: string }
  | { type: 'assistant_delta'; text?: string }
  | { type: 'assistant_final'; text?: string }
  | { type: 'tts_audio'; audio?: string }
  | { type: 'command_result'; kind?: string; text?: string }
  | { type: string; [k: string]: unknown }

export type CliStatus = {
  available: boolean
  version?: string
  tools?: Record<string, string>
}

export type Profile = {
  key: string
  provider?: string
  mode?: string
}
