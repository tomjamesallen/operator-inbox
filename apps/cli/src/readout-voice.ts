import type {
  ReadoutSegment,
  ReadoutTimedSegment,
} from '@operator-inbox/core/api';
import { Context, Data, type Effect } from 'effect';

// Listen mode's voice, as a port: what turns one speech script into an MP3
// and the timings of its words. The `Readout` service (`readout.ts`) owns the
// queue and the cache and knows nothing of how the speech is made; the one
// adapter today is local Kokoro through mlx-audio (`readout-kokoro.ts`). Any
// other (a cloud voice) is another layer for this tag.

// Why a script could not be spoken. `unavailable`: the voice's software is not
// on this machine, so nothing can be made until it is, and the message says
// how to fix that. `failed`: this attempt failed, and another may not.
export class ReadoutVoiceError extends Data.TaggedError('ReadoutVoiceError')<{
  readonly reason: 'unavailable' | 'failed';
  readonly message: string;
}> {}

/**
 * How hard to push the machine. `now`: the script the operator is waiting
 * on, made as fast as the voice can. `background`: a script made ahead, which
 * nobody waits on yet, made gently enough that the rest of the machine stays
 * responsive.
 */
export type ReadoutPace = 'now' | 'background';

/** What a spoken script came to: its length in seconds and its timed segments. */
export interface SpokenScript {
  readonly duration: number;
  readonly segments: ReadonlyArray<ReadoutTimedSegment>;
}

export interface ReadoutVoiceService {
  /**
   * The model and the voice, as one name (`kokoro-82m-bf16/bm_george`). It is
   * part of every script's cache hash, so audio made by another voice is never
   * served for this one.
   */
  readonly id: string;
  /** The voice's own name, as config.json gives it. */
  readonly voice: string;
  /**
   * Is the voice's software here? Cheap, and starts nothing: it fails
   * `unavailable` when it is not.
   */
  readonly available: Effect.Effect<void, ReadoutVoiceError>;
  /** Speak `segments` into an MP3 at `to`, at `pace`. */
  readonly speak: (
    segments: ReadonlyArray<ReadoutSegment>,
    to: string,
    pace: ReadoutPace,
  ) => Effect.Effect<SpokenScript, ReadoutVoiceError>;
}

export class ReadoutVoice extends Context.Service<
  ReadoutVoice,
  ReadoutVoiceService
>()('operator-inbox/ReadoutVoice') {}
