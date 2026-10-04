// ElevenLabs text-to-speech client with a small in-memory cache, so repeated
// phrases ("Your next medication is…") don't spend credits twice.

const API_URL = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
// Flash is the low-latency, lower-cost model; override with ELEVENLABS_MODEL_ID.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
const PLACEHOLDER_KEY = 'your_elevenlabs_api_key_here';
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const cache = new Map();
let cacheBytes = 0;

export class VoiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

export function isVoiceConfigured() {
  const key = process.env.ELEVENLABS_API_KEY;
  return Boolean(key && key !== PLACEHOLDER_KEY);
}

function remember(text, audio) {
  cache.set(text, audio);
  cacheBytes += audio.length;
  // Map iteration order is insertion order, so the first key is the oldest.
  for (const [key, value] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(key);
    cacheBytes -= value.length;
  }
}

export async function synthesize(text) {
  if (!isVoiceConfigured()) throw new VoiceError('Voice service is not configured', 503);

  const cached = cache.get(text);
  if (cached) {
    cache.delete(text);
    cache.set(text, cached); // mark as recently used
    return cached;
  }

  let response;
  try {
    response = await fetch(`${API_URL}/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error('ElevenLabs request failed:', error.name);
    throw new VoiceError('Voice service is unavailable', 502);
  }

  if (!response.ok) {
    // Log only the status: upstream bodies can echo request details.
    console.error('ElevenLabs responded with status', response.status);
    throw new VoiceError(response.status === 429 ? 'Voice service is busy, try again shortly' : 'Voice service is unavailable', response.status === 429 ? 429 : 502);
  }

  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_AUDIO_BYTES) throw new VoiceError('Voice response was too large', 502);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length > MAX_AUDIO_BYTES) throw new VoiceError('Voice response was too large', 502);

  remember(text, audio);
  return audio;
}
