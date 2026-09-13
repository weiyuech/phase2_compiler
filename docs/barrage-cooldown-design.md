# Barrage timing and raw OCR ownership

Implemented for 1.0.2-test.6, 2026-09-13. Supersedes the abandoned per-scan judge,
recovery-judge and per-question queue draft.

## Independent observation and reply paths

- Scan at scan_interval (1–60 seconds). The worker compares the new image
  with its last successfully OCR-processed image; sufficiently similar images
  reuse cached raw OCR. Native inference remains single-flight/latest-only.
- Every actual OCR result, including blanks, goes to the asynchronous raw OCR
  text log. Cached image-gate hits are not logged as new inference. Cooldown,
  judge requests, preparation and playback do not suppress this path.
- Both barrage modes share a monotonic recurring reply clock. The first usable
  observation establishes the first opportunity; later slots are periodic.
  Busy slots are skipped, not queued or caught up after playback.
- Busy includes a judge request, answer generation, preparation/decoding,
  boundary wait, barrage playback, and host speech. Cruise/transit playback
  does not make barrage busy.
- Existing hierarchy/coordinator remains unchanged:
  host > barrage > point narration > transit. Preparation claims no speaker.
  Ready barrage respects existing TTS sentence boundaries; MP3 keeps its
  existing whole-file handoff policy.

## Timing settings

Cooldown rounds to the nearest interval multiple, with a minimum of one
interval and maximum 3000 seconds (largest valid multiple within that limit).
Ties round upward. Interval 3: 10 becomes 9; 2 and 0 become 3.
There is no zero-cooldown mode.

The renderer saves coupled values atomically; the backend normalizes again.
Legacy incompatible settings normalize on read without rewriting user files.
A timing change establishes a new future slot; it does not trigger a burst
or interrupt current speech.

## Three distinct records

1. Image-check reference: the worker's last OCR-processed image and cache.
2. Current observation: latest capture and its raw OCR. The client retains
   at most two completed PNG/raw-text pairs plus bounded active/latest-pending
   work. Replaced buffers are released; images are not written to disk by default.
3. TTS judge baseline: raw OCR text and metadata from the last successful
   judge request, including exact 无新问题. No third image file is needed.
   Busy slots, blanks and failed requests do not advance it.

At a TTS slot, freeze the baseline and current raw OCR in <previous_ocr> and
<current_ocr>. Escape OCR-provided delimiters. A valid response commits the
frozen raw input, never filtered model output. The decision path retains at
most 16,000 characters per snapshot and sends at most 10,000 per input tag.

Exact trimmed 无新问题 skips answer generation and audio. Other nonempty
text alone enters the existing answer LLM/TTS path, including existing
random/priority rules. No recovery judge, unanswered-question backlog, or
raw-text fallback. Successfully judged unchanged input does not cause repeated
paid calls. Failed judgments get at most one retry at a later slot; changed
observations get a new attempt budget.

MP3 calls neither LLM and uses no judge baseline. Every available slot matches
current raw OCR against existing keywords/concepts with priority/random
selection. A persistent matching screen may play again at a later free slot.

Stop/reselection, output/connection cancellation and mode changes invalidate
stale work. Host interruption invalidates prepared playback while retaining
the successful baseline and recurring clock. Old external requests cannot
overlap another paid request, commit a fresh-session baseline or start old audio.

## Verification

- Backend: npm test (requires permission to bind loopback test sockets).
- Renderer: node --test robot-ui/test/*.test.mjs.
- UI build: npm run build in robot-ui.
- Native workflow: node scripts/eval-ocr-workflow.mjs --report /tmp/ocr-workflow.json.
  Synthetic PNGs, real native OCR, virtual timing, controlled judge/answer/audio;
  no paid APIs or robot commands. Covers raw logging and PNG/text pairing.
- Opt-in semantic evaluation: node scripts/eval-ocr-judge-live.mjs --settings
  /path/to/settings.local.json --rounds 1 --report /tmp/judge-results.json.
  Explicitly calls the real judge API; answer LLM/audio remain stubs.

Local verification: 302 backend tests, 84 renderer tests and all 13 native OCR
workflow checks passed; UI build passed. This is not Windows hardware or
audible robot verification. Controlled judge responses do not prove perfect
semantic classification by a real model.
