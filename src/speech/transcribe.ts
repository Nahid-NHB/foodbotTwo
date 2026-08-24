/**
 * Audio → Bangla text via Google Gemini inline audio input.
 *
 * Whisper was a separate step in the OpenAI version. Gemini 2.0 Flash
 * accepts audio bytes inline, so we just POST the audio + a "transcribe this"
 * instruction and get back the transcript.
 *
 * Returns the transcribed text. Throws on API errors.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generateContent, type GeminiPart } from '../ai/gemini.js';

const TRANSCRIBE_INSTRUCTION =
  'Transcribe the following Bangla voice note exactly as spoken. ' +
  'Return only the transcribed text, with no commentary, no quotes, no timestamps.';

/**
 * Transcribe an audio buffer to text.
 *
 * @param audioBuffer Raw audio bytes (e.g. ogg/opus from WhatsApp).
 * @param mimeType MIME type — defaults to audio/ogg if unknown.
 */
export async function transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
  if (audioBuffer.length === 0) {
    throw new Error('transcribe: empty audio buffer');
  }
  const safeMime = mimeType && mimeType.length > 0 ? mimeType : 'audio/ogg';
  const base64 = audioBuffer.toString('base64');

  const audioPart: GeminiPart = {
    inlineData: { mimeType: safeMime, data: base64 },
  };
  const instructionPart: GeminiPart = { text: TRANSCRIBE_INSTRUCTION };

  const response = await generateContent({
    contents: [{ role: 'user', parts: [audioPart, instructionPart] }],
    generationConfig: { temperature: 0 },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  logger.info({ length: text.length, mime: safeMime }, 'gemini transcription complete');
  if (!text) {
    throw new Error('transcribe: empty response from Gemini');
  }
  return text;
}