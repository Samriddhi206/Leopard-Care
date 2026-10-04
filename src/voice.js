// "Read aloud": ElevenLabs audio from the API, falling back to the browser's
// built-in SpeechSynthesis when the API is unconfigured, rate-limited or offline.
import { fetchSpeech } from './api.js';

const MAX_TEXT = 600;
let audio = null;
let objectUrl = null;
let abortController = null;
let utterance = null;
let onStop = null;

function cleanup() {
  abortController?.abort();
  abortController = null;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (utterance) {
    // Detach first: cancel() fires the old utterance's error event asynchronously.
    utterance.onend = null;
    utterance.onerror = null;
    utterance = null;
    window.speechSynthesis.cancel();
  }
}

function finish() {
  cleanup();
  const callback = onStop;
  onStop = null;
  callback?.();
}

export function isSpeaking() {
  return onStop !== null;
}

export function stop() {
  finish();
}

function speakWithBrowser(text) {
  if (!('speechSynthesis' in window)) return false;
  utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.onend = finish;
  utterance.onerror = finish;
  window.speechSynthesis.speak(utterance);
  return true;
}

/**
 * Speak `text`. Resolves to "elevenlabs", "browser", or "unavailable".
 * `onEnd` runs once when playback finishes or is stopped.
 */
export async function speak(text, { onEnd } = {}) {
  finish();
  const phrase = text.trim().slice(0, MAX_TEXT);
  if (!phrase) return 'unavailable';
  onStop = onEnd ?? (() => {});

  const controller = new AbortController();
  abortController = controller;
  try {
    const blob = await fetchSpeech(phrase, { signal: controller.signal });
    if (controller.signal.aborted) return 'elevenlabs';
    objectUrl = URL.createObjectURL(blob);
    audio = new Audio(objectUrl);
    audio.onended = finish;
    // Undecodable or interrupted audio: say it with the browser voice instead.
    audio.onerror = () => {
      cleanup();
      if (!speakWithBrowser(phrase)) finish();
    };
    await audio.play();
    return 'elevenlabs';
  } catch (error) {
    // Stopped by the user while the request was in flight.
    if (controller.signal.aborted || onStop === null) return 'elevenlabs';
    cleanup();
    if (speakWithBrowser(phrase)) return 'browser';
    finish();
    return 'unavailable';
  }
}
