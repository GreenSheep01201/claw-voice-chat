// 30ms @ 16kHz, PCM16 mono = 480 samples * 2 bytes = 960 bytes
export const FRAME_BYTES = 960

export function downsampleToPcm16(float32: Float32Array, inRate: number, outRate: number): Int16Array {
  if (outRate > inRate) return new Int16Array(0)

  const ratio = inRate / outRate
  const outLength = Math.floor(float32.length / ratio)
  const result = new Int16Array(outLength)

  let outIndex = 0
  let inIndex = 0

  while (outIndex < outLength) {
    const nextInIndex = Math.floor((outIndex + 1) * ratio)
    let accum = 0
    let count = 0

    for (let i = inIndex; i < nextInIndex && i < float32.length; i += 1) {
      accum += float32[i]!
      count += 1
    }

    const sample = count ? accum / count : 0
    const clamped = Math.max(-1, Math.min(1, sample))
    result[outIndex] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff

    outIndex += 1
    inIndex = nextInIndex
  }

  return result
}

export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!
    bytes[i * 2] = sample & 0xff
    bytes[i * 2 + 1] = (sample >> 8) & 0xff
  }
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary)
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}
