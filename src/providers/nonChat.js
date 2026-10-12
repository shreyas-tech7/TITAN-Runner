/**
 * @file Which model ids are never a chat completion target. One list, used by the model discovery and by
 * `resolveModel`, so a stored model that is not a chat model is never used again.
 *
 * The Groq text-to-speech models (canopylabs/orpheus-*, playai-tts) were found by the nightly canary. Discovery took
 * the first one as the chat model, and every Groq call failed with a 400 until the filter knew the name. Groq's model
 * list was slow at the time, so discovery could not repair the stored model. `resolveModel` now ignores it.
 */
export const NON_CHAT_ID_PATTERN = /whisper|tts|guard|moderation|embed|rerank|speech|audio|vision-only|image|dall-e|stt|orpheus|playai|canopylabs|voice|transcri/i;

/** @param {unknown} id @returns {boolean} False for a model id that can never answer a chat call. */
export function isChatModelId(id) {
  return typeof id === 'string' && id.length > 0 && !NON_CHAT_ID_PATTERN.test(id);
}

export default { NON_CHAT_ID_PATTERN, isChatModelId };
