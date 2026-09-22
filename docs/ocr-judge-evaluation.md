# OCR judge live evaluation — 2026-09-12

> Historical evaluation. For the current cooldown-only TTS judge, MP3 routing,
> snapshot ownership and verification, see [barrage-cooldown-design.md](barrage-cooldown-design.md).

Follow-up: the [real screenshot workflow verification](ocr-workflow-verification.md)
found additional OCR-username duplicates and an API-failure retry gap. The results
below are text-only evaluation results, not proof of screenshot-to-answer reliability.

The default remains shared by the backend and settings UI in
`src/phase2/ocr/judge-prompt.js`. Input keeps `<previous_ocr>` and `<current_ocr>`;
only the exact trimmed output `无新问题` skips the reply stage. All other output
is forwarded unchanged. No local semantic filter was added after the judge.

## Actual API test

Used the existing `automated_video_editing` project's configured Doubao
`doubao-1-5-lite-32k-250115` account, for testing only. No credential was copied
into this repository or into robot-live-system's saved settings. The endpoint,
provider request implementation, temperature 0.7, and 500-token cap used the live
judge path. The test used the editing project's 20-second timeout rather than
robot-live-system's locally configured 8 seconds.

All input was synthetic text. The test exercised `OcrTextJudge`, including its
successive raw-text baseline and exact skip signal, then the real `BarrageManager`
answer-input construction. Answer generation and speech were stubs: no OCR,
recording, TTS, or physical robot commands ran.

The first concise draft passed 29/36 strict checks. Explicit rules/examples for
OCR mistakes, full original messages including usernames, and real negation
changes improved the next draft to 34/36. The final prompt passed **42/44**
checks (22 cases, twice), including **8/8 holdout checks** not used as prompt
examples. All 44 routing checks passed; no API errors occurred in this final run.

Passing cases included rolling overlap (ABCDE → BCDEFG forwards only FG), identical
screens, entry/gift/like notifications, 半/羊, wrapped or disappearing old lines,
new messages after a skipped round, and price/model/quantity/negation changes.
Holdouts covered 未/末, username OCR mistakes alongside a new question, changed
quantity, and a genuinely different viewer asking the same question.

**Known unresolved model error:** in a six-message screen where only
`小陈：中午发货吗？` changes to `小陈：中牛发货吗？`, the model returned that
changed old line instead of `无新问题` in both final repetitions, despite the
explicit example. It was forwarded as the existing exact-signal contract requires.
These results are regression evidence, not a general accuracy guarantee; the
default update must not be represented as eliminating all OCR false positives.

## Default/custom compatibility

An exact saved copy of the previous default (including Windows CRLF line endings)
resolves to the updated default in memory. Genuine custom text stays unchanged;
reading either form does not overwrite the operator's file. This prevents earlier
settings saves from silently pinning the old default forever.

## Repeat the opt-in test

```sh
node scripts/eval-ocr-judge-live.mjs --settings /path/to/settings.local.json --rounds 2 --report /tmp/ocr-judge-results.json
```

This command explicitly makes paid API requests using that settings file's `llm`
section. It is not part of automated CI. It prints no API key or provider error
body, uses no fallback account, and exits nonzero if any strict expectation fails.
The generated report contains only synthetic inputs/outputs, test settings and
sanitized status fields. An API quota failure in the app's separately saved
account is not repaired by updating the prompt.
