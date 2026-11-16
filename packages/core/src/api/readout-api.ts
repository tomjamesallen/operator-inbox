import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

// Listen mode's half of the contract (ADR-0005). The page builds each
// Question's speech script, since it is the page that draws the body and maps
// a spoken word back onto it, and sends serve the scripts it wants made, the
// current Question first and then the ones after it in the view. Serve makes
// the audio one script at a time, in that order, caches it by a hash of the
// script and the voice, and answers where each one stands. The audio itself
// is fetched from `audio`, a plain route outside this group that answers
// `Range` requests, so the browser can seek in it.

/** The most scripts one request may want: the current Question and three after it. */
export const READOUT_MAX_SCRIPTS = 4;
/** The most segments in one script. */
export const READOUT_MAX_SEGMENTS = 400;
/** The most characters in one segment's text. */
export const READOUT_MAX_SEGMENT_TEXT = 4_000;
/** The longest pause after a segment, in seconds. */
export const READOUT_MAX_PAUSE = 2;

// One segment of a script: what the voice says, and the silence after it. The
// id is the page's own (`title`, `p0u3`), handed back with its timings.
export const ReadoutSegment = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(READOUT_MAX_SEGMENT_TEXT),
  ),
  pauseAfter: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(READOUT_MAX_PAUSE),
  ),
});
export type ReadoutSegment = typeof ReadoutSegment.Type;

export const ReadoutScript = Schema.Struct({
  segments: Schema.Array(ReadoutSegment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(READOUT_MAX_SEGMENTS),
  ),
});
export type ReadoutScript = typeof ReadoutScript.Type;

// The scripts the page wants made, in the order it wants them. Each request
// replaces what the last one asked for: a script no longer wanted that has
// not started is dropped; one being made is finished; made ones stay cached.
// None at all is the page turning listen mode off: nothing more is made.
export const ReadoutRequest = Schema.Struct({
  scripts: Schema.Array(ReadoutScript).check(
    Schema.isMaxLength(READOUT_MAX_SCRIPTS),
  ),
});
export type ReadoutRequest = typeof ReadoutRequest.Type;

// A word as spoken: characters `from`–`to` of its segment's text, and seconds
// `start`–`end` into the whole script's audio.
export const ReadoutWord = Schema.Struct({
  from: Schema.Int,
  to: Schema.Int,
  start: Schema.Number,
  end: Schema.Number,
});
export type ReadoutWord = typeof ReadoutWord.Type;

export const ReadoutTimedSegment = Schema.Struct({
  id: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  words: Schema.Array(ReadoutWord),
});
export type ReadoutTimedSegment = typeof ReadoutTimedSegment.Type;

// Where one wanted script stands, by the hash serve keys it by.
export const ReadoutReady = Schema.TaggedStruct('Ready', {
  hash: Schema.String,
  // Where to fetch the audio, an MP3.
  audio: Schema.String,
  duration: Schema.Number,
  // How long it took to make, for the page's lookahead; 0 when it was cached.
  generationMs: Schema.Number,
  segments: Schema.Array(ReadoutTimedSegment),
});
export type ReadoutReady = typeof ReadoutReady.Type;
export const ReadoutQueued = Schema.TaggedStruct('Queued', {
  hash: Schema.String,
  // Scripts ahead of it, the one being made included.
  position: Schema.Int,
});
export const ReadoutGenerating = Schema.TaggedStruct('Generating', {
  hash: Schema.String,
});
export const ReadoutFailed = Schema.TaggedStruct('Failed', {
  hash: Schema.String,
  message: Schema.String,
});
export const ReadoutEntry = Schema.Union([
  ReadoutReady,
  ReadoutQueued,
  ReadoutGenerating,
  ReadoutFailed,
]);
export type ReadoutEntry = typeof ReadoutEntry.Type;

export const ReadoutStatusDto = Schema.Struct({
  // The voice the audio is made in (config.json's `readout.voice`).
  voice: Schema.String,
  // Why no audio can be made at all on this machine (the voice's software is
  // not installed), for the page to say; every entry is then `Failed` too.
  unavailable: Schema.optionalKey(Schema.String),
  // One per script asked for, in the order asked.
  entries: Schema.Array(ReadoutEntry),
});
export type ReadoutStatusDto = typeof ReadoutStatusDto.Type;

/** Where a made script's audio is served: an MP3, answering `Range`. */
export const readoutAudioPath = (hash: string): string =>
  `/api/readout/audio/${hash}.mp3`;

/** A hash serve makes: 24 lower-case hex digits. */
export const READOUT_HASH = /^[0-9a-f]{24}$/;

export class ReadoutApiGroup extends HttpApiGroup.make('readout').add(
  HttpApiEndpoint.post('queue', '/readout', {
    payload: ReadoutRequest,
    success: ReadoutStatusDto,
  }),
) {}
