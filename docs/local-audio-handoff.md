# Shared transition audio and point narration

The prepared-audio update applies this policy to both local and robot output.
See [prepared playback and diagnostics](prepared-audio-diagnostics.md) for limits,
timing semantics and the required physical acceptance checks.

## Settings

In the **过渡音频** card on **播报控制**, enable transition audio and choose either TTS text or
audio files. Audio files use one shared pool across travel segments, not one
recording per route. Repeat mode loops the selected file; shuffle plays every
available file once per shuffled cycle and avoids immediate repeats when more
than one file is available. MP3, WAV, OGG and M4A remain supported.

The existing `mp3_file` setting migrates to a singleton `mp3_files` pool. The
selected repeat file remains in `mp3_file`; `mp3_mode` is `repeat` or `shuffle`.
An explicit empty pool clears its references. Removing an entry never deletes
the underlying file. Missing or failed clips are skipped for the current run.
Saved settings take effect on the next transition start, not mid-clip.

## Playback handoff

- Arrival does not stop transition audio while point content is loading or
  being rewritten/synthesized.
- The point's own MP3 selection or prepared TTS sentence asks for playback
  permission. Preparing a reply does not claim the speaker.
- After the local player launches successfully, permission is checked again;
  the handoff stops transition audio and starts the point's speech state before
  feeding narration bytes to the player.
- A ready higher-priority source waits for the current TTS sentence to finish;
  it may interrupt MP3 without inventing sentence boundaries. Host speech remains
  immediate. Barrage takes priority over point narration, then transit.
  A normal tour pause resumes in place. Skip, stop, point deletion and output
  changes invalidate pending work so a late callback cannot cut the next leg.
- Missing content or preparation/startup failure does not claim the speaker.
  Transition audio remains until another valid handoff or tour stop/end.

Point narration remains tied to that point's content/audio directory. The
transition pool can contain short, reusable clips; it need not contain one
long recording aligned to the entire tour. TTS starts after its first complete
sentence is prepared, while up to two following sentences prepare ahead. A launched
player is not an acoustic timing guarantee: this is preparation-aware handoff, not
sample-accurate gapless playback or crossfading.

## Shared contract

`CruiseController.deferTransitUntilSpeech` is enabled for both output modes.
Each point receives an abort signal, `isCurrent()` and `onAudioStart()`; a stale
or paused handoff returns `false`. `createPointNarrator` owns the shared
preparation/eligibility policy. `TTSEngine` accepts `waitForPlayback`,
`beforePlay`, `onAudioStart` and an external abort signal.

The prepared-PCM robot adapter honors the same contract: prepare the segment,
await eligibility, recheck cancellation/output ownership, acquire the speaker,
then transmit at real-time speed. At a transit-to-point handoff, remaining transit
sentences are discarded. Interrupted point narration resumes at its next sentence.

Regression coverage: `test/point-handoff.test.js`,
`test/local-playback-handoff.test.js`, and `test/transit-pool.test.js`, alongside
the existing navigation, WebSocket and robot-audio tests.
