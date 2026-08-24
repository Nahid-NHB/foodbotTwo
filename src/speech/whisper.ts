import { openai } from '../ai/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Transcribe audio to text using OpenAI Whisper with the Bangla language hint.
 *
 * The 'language' parameter dramatically improves accuracy on noisy
 * Bangladeshi street recordings by preventing Whisper from guessing Hindi.
 *
 * Returns the transcribed Bangla text. Throws on API errors — the caller
 * (audio.transcribe worker) handles retries with backoff.
 */
export async function transcribe(audioBuffer: Buffer, _mimeType: string): Promise<string> {
  if (audioBuffer.length === 0) {
    throw new Error('transcribe: empty audio buffer');
  }
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/ogg' });
  // The OpenAI Node SDK's File expects a filename. Cast to satisfy the type.
  const file = new File([blob], 'voice.ogg', { type: 'audio/ogg' });

  const result = await openai.audio.transcriptions.create({
    file,
    model: config.WHISPER_MODEL,
    language: 'bn',
    temperature: 0,
    response_format: 'json',
  });

  const text = result.text?.trim() ?? '';
  logger.info({ length: text.length }, 'whisper transcription complete');
  return text;
}