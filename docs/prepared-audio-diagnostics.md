# Prepared playback and audio diagnostics

## Speaking contract

Both output modes share **host → barrage → point narration → transit** priority.
Preparation does not own playback. TTS is split at sentence endings, retaining
punctuation/closing quotes and protecting common abbreviations and decimals.
Ordinary commas are not boundaries. Exceptionally long units are capped at 500
Unicode code points, preferring a nearby comma/newline/space and preserving all
spoken text; ordinary numbers and surrogate pairs are protected where possible.
MP3 has no invented sentence boundaries.

| Incoming event | Current TTS | Current MP3 |
| --- | --- | --- |
| Ready barrage | Finish current sentence; reply; resume next sentence | Pause at current position; reply; resume |
| Ready point narration during transit | Finish transit sentence; discard remaining transit passage | Stop transit when point playback starts |
| Host speech / operator pause | Immediate pause; retain position | Immediate pause; retain position |
| Stop / skip / stale point / output or robot-connection replacement | Cancel affected preparation and playback | Cancel affected preparation and playback |

Tour pause blocks point/transit, not otherwise eligible barrage. Host speech
blocks all automated audio. A ready barrage waiting for a boundary is discarded
on host interruption, preserving the existing host override. Barrage keeps one
current reply job. Recurring cooldown opportunities use the latest raw OCR;
busy opportunities are skipped, not queued or replayed after playback. Preparation
between barrage actions does not mute point audio. A skipped point cannot start
later from a stale callback. See [barrage-cooldown-design.md](barrage-cooldown-design.md)
for TTS judge baselines, MP3 matching and interval/cooldown rules.

TTS starts with the first complete sentence; only the current sentence plus the
next two are prefetched. Across all three engines, at most two synthesis requests
run simultaneously; foreground barrage outranks queued speculative work. Voice,
resource, speed, volume, sample rate, endpoint and format are frozen into cache
identity. A missing next sentence waits at the boundary; it does not skip words or
insert transit filler. Failures are surfaced instead of claiming successful audio.
Retiring a reusable source's sentence window also aborts its discarded queued or
running synthesis units. Late callbacks cannot refill that window or retain cache
handles; settled units detach their cancellation listeners. Existing transit
shutdown already releases its source, so this is stronger ownership cleanup,
not evidence that ordinary transit previously leaked provider calls.

One utterance start/end pair owns its caption and broadcast count. Sentence
updates use the same utterance ID; stale end/update callbacks cannot clear or
resurrect another speaker's caption. Local TTS continues to use ffplay, one gated
sentence at a time. Local MP3 stays on its existing player; M4A uses seekable file
input to preserve support for non-streamable containers. Player/process startup
can introduce sentence gaps: this is not a sample-gapless guarantee.

## Robot transport and storage

- Decode each complete file or synthesized sentence to 16 kHz mono signed 16-bit
  little-endian PCM before activation. No progressive decoder is tied to playback
  backpressure; full preparation cannot deadlock behind the old one-second limit.
- Prepared PCM: 64 MiB RAM, 256 MiB temporary disk cache; two concurrent decodes.
  Active/referenced assets cannot be evicted. Disk assets use bounded read-ahead.
  Capacity failures cancel/fail safely; incomplete assets are not played.
  Reservations skip the LRU inventory scan/sort while capacity remains sufficient.
  An individual reservation larger than the entire budget fails before eviction.
- Large in-memory MP3 cache identities use the same SHA256, updated in chunks of
  at most 1 MiB with an event-loop turn between chunks. Playback timers and stop
  requests can run during preparation; cancellation before completion prevents
  decode/cache admission. This does not copy the full input or enlarge any queue.
  On the development Mac, three 64 MiB trials reduced the longest probe gap from
  54–61 ms to 1.4–1.6 ms; total hashing took 61–63 ms versus 54–58 ms synchronously.
  These are local measurements, not a Windows or robot performance guarantee.
- Each cache uses a unique `data/robot-pcm-cache/run-<pid>-<nonce>` directory.
  Shutdown releases only that run's files. A later startup recovers recognized
  generated files only when the run's ownership metadata matches and its process
  is gone. Live/reused PIDs and uncertain ownership are left untouched and cannot
  block a new cache. Legacy root-level caches are also left untouched, so an old
  version may finish using them safely. This isolation covers temporary PCM only;
  the desktop's single-instance guard still protects the application profile.
  Developer cache/log histories are excluded from packaging and first-run seeding.
- Synthesized compressed sentences have a separate 8 MiB bounded cache. The
  existing user TTS library remains available: successful utterances are merged
  with ffmpeg (not concatenated MP3 bytes), using voice-aware identity. Temporary
  harvesting is limited to two 16 MiB jobs; oversized harvests are skipped without
  failing playback. Existing user library files are not automatically deleted.
- Send 640-byte PCM frames on a 20 ms target cadence using one monotonic-clock
  timer. Keep the nominal sample clock independent of the minimum wire spacing:
  ordinary lateness can be recovered against that clock, with at least 10 ms
  between full frames in the same uninterrupted session. Feeding the wire guard
  back into the nominal clock can accumulate late wakeups instead of recovering
  them. Windows timer rounding is one possible source; the customer log does not
  identify the operating-system cause. A wakeup at least one whole frame late restarts the nominal
  phase; no loop sends several frames in one callback to repay the delay.
  Early timer wakeups recheck both deadlines before sending. This is a target
  cadence, not a zero-jitter guarantee. The final packet can be shorter;
  completion preserves its full remaining PCM duration and waits for local
  socket writes to drain. It is not a playback acknowledgment.
- New/resumed robot speakers share a connection-scoped packet boundary: wait for
  the last sent packet's remaining PCM duration (at most 20 ms), then anchor the
  incoming schedule to its actual first send. Start hooks cannot compress packets
  one and two; host/stop cancellation still clears pending sends immediately.
  Boundary waits/gaps are recorded separately from within-clip packet statistics.
  The 10 ms same-session correction does not shorten handoff/resume boundaries
  or the final tail; those retain the preceding packet's full actual duration.
  This is minimum send spacing, not confirmation that the robot buffer is empty
  or that audible stuttering is resolved.
- Do not upload an entire clip in advance. Keep the existing robot socket and JSON
  protocol, continuous sequence within an utterance, pause/resume position and
  source-session conventions. No Python runtime, second audio socket or invented
  receiver-flush command is introduced.
- Robot volume is applied only at the final PCM send boundary. `100%` is bit-exact;
  `0–150%` changes use signed 16-bit saturation and a short live ramp without
  cancelling playback, resetting sequence numbers or changing prepared caches.
- WebSocket write callbacks and backlog are measured; optional frame compression
  is disabled. At 64 KiB of pending writes, stop taking further PCM from the
  reader; resume at or below 16 KiB. Sequence and reader position stay unchanged
  during the wait. The hard cap is 1 MiB (formerly 256 KiB), an emergency bound,
  not the normal queue target. A connection-scoped watchdog survives stop/retry;
  failure to drain below the recovery threshold within 15 seconds discards the
  old socket. Final sentence drain waits for zero local buffered bytes.
- A failed socket is immediately unavailable for new navigation/audio commands.
  Reset terminates it rather than flushing old queued PCM through graceful close.
  Client mode retries after 5 seconds; server mode waits for the robot to reconnect.
  Existing disconnect handling stops narration/tours and clears stale goal/map
  state; operators must restart playback. No automatic physical stop or resume
  command is invented, and robot-side received audio cannot be erased locally.
  Normal pause/stop alone does not reset a healthy shared connection.
- Provider TTS failure/cancellation closes its request socket and ignores late
  audio. Completed requests close gracefully with a bounded cleanup fallback.
  Network stalls, disk read-ahead waits and event-loop stalls can still interrupt
  delivery. The socket remains on the existing event loop.

These thresholds are initial engineering defaults, not hardware-tuned values.
For the October 2026 change, verification includes syntax, build, source review,
pure text/timing calculations, controlled transport regressions and loopback
provider cleanup tests. Release also runs the Windows packaged-runtime and
installer gates, including a real-timer cadence measurement using the production
scheduling helpers in both unpacked and installed Electron. It does not create a
robot/socket fixture or contact a provider. These software checks do not establish real robot performance;
no hardware or production-provider network validation was done.

OCR image processing runs in one persistent worker with bounded ONNX/Sharp native
parallelism. It executes one frame at a time and retains at most one newer waiting
frame; repeated region selection, stop and reconnect use generation guards so stale
results and capture loops cannot restart. Interval OCR and its raw text log remain
independent of reply preparation/playback. Similar images reuse cached OCR; busy
cooldown slots skip reply work, not observation. The downloadable raw text log uses
bounded asynchronous writes rather than blocking the robot packet scheduler.

`onnxruntime-node` is intentionally pinned to `1.23.2`: later published packages
omit the prebuilt macOS Intel (`darwin/x64`) binding. The same N-API package retains
the Windows x64 binding used by the installer, which is independently exercised by
the packaged-runtime gate. Do not widen this pin without testing both platforms.

## Exporting a choppiness report

Open **系统设置 → 音频诊断** at any time, including while connected. Recording is
automatic. After a glitch, optionally press **刚才卡顿**, then **导出诊断日志**.
The default text/JSON report contains timing, preparation/wait states, anonymous
session/utterance IDs, cancellations, fixed error codes, packet summaries,
backlog, event-loop/resource statistics, versions and retained time range.
No audio, image, transcript, credentials or full URL is included by default.
Nothing uploads automatically.

Audio history and backend history each have their own **1 MiB total** budget,
two 512 KiB segments. The backend migrates the newest bounded history from its
older larger logs. Rotation discards oldest records; oversized records and slow
or failed writes cannot grow queues indefinitely. Packets are measured in memory;
one-second summaries and bounded events are written asynchronously. Diagnostic
records are dropped under pressure rather than waiting on disk in the audio path.
Runtime summaries contain drop/discard/truncation counters. Last unflushed events
may be lost after a crash; exports state the actual retained interval.
The per-frame diagnostic path uses a fixed packet field whitelist and reuses its
timing state; the full export/event sanitizer remains unchanged. Local profiling
found this path was already a small fraction of one millisecond per audio second,
so reducing its allocations alone is not an explanation or cure for choppiness.

Electron main exports persisted files even when the backend cannot start.
Development storage is project `data/`; packaged storage is Electron `userData`.
Including **raw backend logs** is an explicit checkbox plus native privacy warning:
those existing logs can contain spoken/OCR text, paths, documents and URLs. Review
before sharing. Exported files are user-owned and are never cleaned up by rotation.

### Reading the send-rate and PCM measurements

A 640-byte frame contains 20 ms of audio. Sustained spacing of about 31 ms means
the application sends only about `20 / 31 = 0.65` seconds of audio per second:
10 seconds of audio takes about 15.5 seconds to send. This is sustained sender
slowdown, which can starve playback if the receiver's buffered audio runs out.
One isolated long interval is jitter; a historical maximum alone does not show
that the current stream is slow. A zero local socket backlog and fast write
callbacks also do not prove sufficient send rate or successful robot playback.
Receiver buffer depth, decoding, speaker state and actual audibility are unknown.

The latest roughly one-second `packet-summary` contains:

| Field | Meaning |
| --- | --- |
| `audioDurationMs` | PCM duration of all frames sent in that summary (`bytes / 32`). |
| `cadenceSamples` | Number of comparable adjacent-frame intervals within a session and connection. |
| `cadenceAudioMs` | Sum of each comparable interval's preceding frame duration, including shorter frames. |
| `activeSendMs` | Sum of those intervals' measured elapsed time. |
| `sendRateRatio` | `cadenceAudioMs / activeSendMs`; `1.00` matches the audio sample clock. Omitted when no elapsed interval exists. |
| `sendLagMs` | Positive difference `activeSendMs - cadenceAudioMs` for that summary, not receiver latency. |
| `capturedAt` | Summary timestamp, used to distinguish current measurements from retained ones. |
| `pcmSamples`, `pcmNonzeroSamples`, `pcmPeak`, `pcmRms` | Post-gain signal measurements for observed frames in the latest contiguous session within the summary. RMS is weighted by sample count, including short final frames. |
| `robotVolumePercent` | Last observed robot output volume setting in that signal window. |

Recorded pauses, session changes and connection/generation changes break the
comparison. Socket completion callbacks do not count a second copy of a frame.
Live PCM measurements also reset at these boundaries and do not wait for a long
clip to finish. They retain their summary timestamp; values shown during a pause
are observations of previously sent frames, not current robot speaker state.
The UI uses the recent summary for the send-rate warning, not lifetime maxima:
the summary must be at most three seconds old, contain at least ten comparable
intervals over at least 200 ms, and show a rate below `0.90`. A stale or disconnected
display retains its last data with an explicit label. A rate near `1.00` still
does not establish audible continuity.

On completed robot audio, `robot_audio_sent` now includes `audioDurationMs`,
`elapsedMs`, `robotVolumePercent`, `pcmSamples`, `pcmNonzeroSamples`, `pcmPeak`
and `pcmRms`. PCM energy is measured after the volume ramp and saturation,
immediately before transport; no audio samples are retained in diagnostics.
`pcmPeak` is the maximum absolute signed-16-bit sample, and `pcmRms` its root
mean square. Zero peak/RMS/nonzero count for a completed nonempty clip shows
the outgoing PCM was silent; nonzero energy shows outgoing signal, not sound
from the robot speaker. `elapsedMs` can include pauses and waits, so use the
same-session summaries to assess continuous send speed. Older reports lack
these energy fields; their absence is not evidence of mute. The completion
event continues to state `playbackAcknowledged: false`.

## Automatic robot connection and point diagnostics

The top-bar **导出诊断日志** button includes structured robot diagnostics by
default. Customers only need to export that one file after a problem; they do
not need a terminal, packet capture, debug switch, or access to robot internals.
This recording requires an app build containing the new recorder. Older exports
cannot retrospectively recover commands and replies that were never recorded.

The report distinguishes connection attempts that never opened from connections
that opened and later closed. It records fixed error/close codes, elapsed time,
reconnect delay and time since the last heartbeat. Each point command has a local
ID linking its confirmation, ignored replies, comparison results, relevant
heartbeat transitions and final outcome. These IDs do not change robot messages.
An arrival heartbeat received before an accepted confirmation is recorded as
such, so an “arrived” display can be compared with the actual command wait.

Robot history and failure snapshots each have a separate **1 MiB total** budget.
Unchanged heartbeats are summarized; a failure retains bounded preceding context
in the incident history so ordinary later traffic cannot overwrite it. Subsequent
failures still rotate out older incidents. Recording is asynchronous and bounded;
disk trouble must not block navigation or speech. Export briefly asks only the
selected machine's backend to flush its local writers. If it has stopped, fails,
or does not respond within one second, persisted history is still exported and
`metadata.diagnosticsFlush` records that limitation.

Default reports contain comparison flags, value types, numeric point IDs and
per-run fingerprints of map/path/object identities. They exclude raw protocol
messages, connection addresses, credentials and map/path/object names. The
Chinese findings describe observed failures and do not claim to identify a
robot-side defect, Wi-Fi outage, or other unobserved cause. Nothing uploads
automatically, and runtime histories are excluded from installer seeds.

## Verification and release gate

Run `npm test` for the existing navigation/WebSocket tests and the prepared audio,
sentence, handoff, caption, latest-only barrage, cache and logging regressions.
Some tests bind localhost WebSocket fixtures; none need the physical robot or
production TTS credentials. Run `npm --prefix robot-ui run build` for all Electron
bundles. Browser fixture checks exercise connected/offline diagnostics controls;
they do not prove native save dialogs or packaged Windows operation.

The Windows gate measures 500 real timer callbacks plus the final frame drain
for 10,000 ms of PCM, using the same nominal-clock, wire-deadline and scheduling
helpers as production. It fails sustained elapsed drift above 10%, sends closer
than the configured wire guard, or a shortened final drain. Reports retain mean,
minimum, p95/p99 and maximum intervals, cumulative drift, partial/whole-frame
overruns, early wakeups and CPU use. Individual gaps and CPU use are reported
without a zero-jitter or strict CPU-limit claim. A 30-second watchdog fails a
stuck measurement. Both the unpacked executable and the NSIS-installed and
overwritten executable must pass; source-only or macOS measurements cannot
qualify a Windows release. These are app scheduling checks, not network, receiver
buffer or acoustic measurements. Physical validation below remains outstanding
when no robot is available.

The existing three-machine installer test also checks aggregate receipt speed
from the actual packaged backends using its already-captured loopback PCM. Only
complete uninterrupted clips qualify: machine 2 after recovery and machines 1/3
across the other machine's restart/crash. First-to-last receipt is compared with
the preceding frames' PCM duration, excluding the final frame whose playout tail
is not observed. More than 10% sustained slowdown fails this engineering gate.
Individual receive callbacks may coalesce, so this gate imposes no per-callback
minimum spacing and does not establish a physical robot underrun threshold.

Before release, compare the same MP3 against the successful Python client on the
real robot. Record both with the actual live camera/phone microphone. Check cloned
voice consistency, sentence intonation/gaps, every source handoff, immediate host
pause/stop response, skipped-point cancellation and scene correctness. Include
tests with OCR/barrage disabled and then enabled; inspect diagnostics around the
same marked time in the recording. Verify native export on a packaged user machine
with the backend running, stopped and failed; verify privacy opt-in and rotation.

Camera/stream settings are unchanged. Because the same camera microphone hears
the robot speaker, preparation changes speech start time, not an independent
audio/video track offset. This does **not** establish acceptable scene alignment
or acoustic latency. Robot boundaries are **sender-estimated**: this protocol has
no audible-completion acknowledgment. If the recording reveals cut sentence tails
or old speech carrying into a new scene, block release and investigate receiver
buffering rather than inserting guessed delays.
