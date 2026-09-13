# Screenshot → OCR → judge workflow verification — 2026-09-12

> Historical evaluation. For the current cooldown-only TTS judge, MP3 routing,
> snapshot ownership and verification, see [barrage-cooldown-design.md](barrage-cooldown-design.md).

## Result and test scope

The previous/current tags carry the correct OCR snapshots, and the exact
`无新问题` routing works. **The whole workflow is not yet fully reliable:**
real screenshots exposed repeated old questions caused by username recognition
changes, and a failed judge request can go un-retried while its image stays still.

The new opt-in harness is `scripts/eval-ocr-workflow.mjs`. It renders synthetic
Chinese PNG screenshots and passes them into the production `initPhase2`
`onBarrageImage` handler. It runs the real Sharp/ONNX worker, image comparator,
`OcrTextJudge`, and `BarrageManager` answer-input construction. The live portion
uses the current default prompt and the authorized `automated_video_editing`
Doubao account (`doubao-1-5-lite-32k-250115`, temperature 0.7, 500 tokens,
20-second test timeout). No saved credentials/settings are changed.

Only synthetic **OCR text**, not screenshots, goes to the external judge API.
Answer generation and audio are stubs; a gated audio stub exercises the actual
barrage speech-start/end hooks. OS screen capture, frontend WebSocket transport,
the configured scan timer, real answer generation and audible playback are not
exercised. This run is on macOS x64 with Node v22.16.0, not a Windows package.

Two live screenshot runs reproduced the same two semantic failures below. The
expanded run evaluated 23 scenarios: 90/92 diagnostic assertions matched their
expectations, with the two failures being the unwanted duplicate outputs.
This is **not** an accuracy rate or release approval: assertions include the
successful reproduction of known defects. A separate native-OCR run with
controlled judge outputs passed 104 lifecycle/contract assertions. The existing
20 OCR unit/regression tests also passed.

## Verified results

- The first screen's five recognized questions reached the answer stub verbatim.
- `ABCDE → BCDEFG` reached the live judge using actual OCR results and forwarded
  only F/G, not the overlapping B/C/D/E rows.
- Identical images and four changed background pixels skipped native inference
  and the judge. At 920 × 440, 24 changed pixels forced OCR; this proves comparison
  stayed anchored to the last *recognized* image, not the previous ignored frame.
- A changed image producing the same text returned exact `无新问题`. No
  `BARRAGE_TEXT_READ`, answer request, audio call or new cooldown was started.
  The current full OCR text still became the next previous-text baseline.
- After that skip, newly added H alone reached the answer stub.
- Leading/trailing whitespace around `无新问题` skips. `无新问题。` deliberately
  does not skip and is forwarded, following the user's exact-signal contract.
- Barrage speech-start paused new OCR work. Older pending PNGs were replaced by
  the latest one; speech-end resumed recognition of that latest image.
- With a slow judge, OCR continued producing results but only the newest pending
  text survived. The next tags contained first-successful/current-latest text,
  not an accidentally adjacent image pair.
- Stop during real native inference discarded its late result. Restart during a
  slow judge discarded the old answer and started the new text baseline empty.
- Host speech deferred judging; after the host finished, an unchanged image was
  eligible for judging because the deferred marker was present.

## Screenshot and text retention timeline

There are **two distinct baselines**, not two permanently saved screenshots with
their text always advancing together.

| Time/event | Screenshot state | Text state / next action |
| --- | --- | --- |
| Start / select a region | First image has no valid comparison baseline for its generation | Previous judged text is empty |
| Capture a new PNG | Worker compares current grayscale pixels with its last successfully OCR-processed image | No judge request yet |
| Pixels equivalent | Current candidate is released; old recognized-image baseline stays | Cached OCR is marked unchanged; normally no judge request |
| Pixels different; OCR succeeds | Current image replaces the previous recognized-image baseline, even if OCR returns blank | Nonempty `result.lines` become current OCR text |
| Judge starts | Image baseline has already advanced; later images may arrive | `<previous_ocr>` = last successfully judged full text; `<current_ocr>` = this job's full OCR text |
| Judge returns exact `无新问题` | No additional image storage operation | Current text replaces previous text; no answer/audio/cooldown |
| Judge returns other nonempty text | No additional image storage operation | Current full OCR becomes previous; only the returned text goes to the answer stage |
| Judge fails | Image baseline remains advanced | Previous judged text stays unchanged; failure is surfaced |
| Stop / reselect | Pending PNG is released; in-flight OCR may finish but its result is stale | Pending judge text and previous text clear; old responses are invalidated |

The worker's old grayscale image is not synchronously erased on stop: its
reference is cleared when the next generation's first image enters the worker,
or when the worker terminates. Released buffers are garbage-collection eligible;
this is not secure erasure.

The OCR queue holds at most one executing PNG plus one replaceable latest pending
PNG. The worker also holds its grayscale baseline/current candidate and temporary
decoding buffers. The text judge independently holds one active request and one
replaceable pending text. Thus “two screenshots for comparison” does **not** mean
there are exactly two image buffers across the entire application, or that every
capture is retained until it is judged. Transient questions can be dropped under
latest-only overload/speech policy.

Screenshots normally stay in memory, not a screenshot history on disk. The
optional `OCR_DEBUG_IMAGES=1` mode overwrites one debug crop at most every five
seconds; it is disabled in this test. OCR text logs are a separate mechanism.

Evidence: `robot-ui/src/renderer/src/components/LiveMonitor.vue:667`,
`src/phase2/ocr/index.js:110`, `src/phase2/ocr/worker.js:149`,
`src/phase2/ocr/text-judge.js:17`, `src/phase2/index.js:233`.

## Issues actually reproduced

### 1. Username OCR changes cause duplicate answers

The synthetic screenshots display the same `小方：运费多少？` message. When its
screen position changes, actual OCR produces `小万：运费多少` and later
`小方：运费多少`. In both live runs, the judge treated this username change as a
new message and forwarded it again. Adding only an entry notification moved it
back to `小万`; that also produced a duplicate.

The tag values exactly matched real OCR output. This is not missing/misordered
`<previous_ocr>` or `<current_ocr>` wiring. The current prompt/model did not
reliably distinguish username OCR noise from a genuinely different viewer asking
the same question. Punctuation and some other characters were also lost during
OCR; routing cannot recover text the engine never recognized.

The earlier text-only evaluation remains useful, but its 42/44 results did not
cover this naturally generated screenshot/recognition failure. A follow-up should
evaluate username-noise examples *and* genuinely different viewers together; it
must not simply suppress every repeated question from a different viewer.

### 2. A transient judge error can strand a visible new question

The test injects one failed judge request after successful native OCR. The error
is surfaced and raw OCR is not forwarded. Sending the identical PNG afterward
returns `unchanged: true`; `src/phase2/index.js:240` does not submit another judge
request. The provider can recover, but that still-visible question is not retried
until the image changes, a speech-deferred marker permits it, or the session is
restarted.

A follow-up should track “OCR succeeded but judging is unresolved” separately
from image change, and retry with bounded delay/latest-only cancellation. It
should not discard the useful image gate or repeatedly re-run native OCR just
because an API call failed. This check did not implement that behavior change.

### 3. Blank images leave stale displayed/text state

Real blank-image recognition returns null and updates the image baseline, but
Phase 2 does not clear `BARRAGE_CURRENT_TEXT` or advance the judge's previous text.
The last nonempty judged screen is compared when text reappears. UI clearing and
whether blanks should reset semantic history are distinct decisions; this test
records the current behavior without changing it.

## Repeat locally

Lifecycle-only, real native OCR, controlled judge outputs:

```sh
node scripts/eval-ocr-workflow.mjs --report /tmp/ocr-workflow-controlled.json
```

Opt-in live judge evaluation (paid requests using the specified test account):

```sh
node scripts/eval-ocr-workflow.mjs --settings /path/to/settings.local.json --report /tmp/ocr-workflow-live.json
```

The screenshots use the available `PingFang SC` font on this Mac. Cross-platform
font substitution can change recognition and is not an equivalent accuracy run.
Reports include only synthetic inputs/outputs and timings, no credentials.
The script exits nonzero on unexpected assertions/semantic failures. Known defect
reproductions are explicitly named rather than hidden behind a green summary.

No production OCR/playback logic, saved settings, GitHub branch or package was
changed in this verification pass; only the diagnostic harness and reports were
added.
