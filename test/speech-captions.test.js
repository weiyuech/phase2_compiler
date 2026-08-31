import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeechCaptions } from '../robot-ui/src/renderer/src/speech-captions.js'

test('sentence updates keep one utterance and do not count as another broadcast', () => {
  const captions = new SpeechCaptions()
  assert.equal(captions.start({ utteranceId: 'point1', source: 'point', text: 'full text' }), true)
  captions.sentence({ utteranceId: 'point1', text: 'first' })
  captions.sentence({ utteranceId: 'point1', text: 'second' })
  assert.equal(captions.entries.size, 1)
  assert.equal(captions.text, 'second')
  assert.equal(captions.start({ utteranceId: 'point1', source: 'point', text: 'second' }), false)
})
test('barrage interruption restores point caption and stale end cannot clear new speech', () => {
  const captions = new SpeechCaptions()
  captions.start({ utteranceId: 'p1', source: 'point', text: 'point sentence' })
  captions.start({ utteranceId: 'b1', source: 'barrage', text: 'reply' })
  captions.end({ utteranceId: 'obsolete' })
  assert.equal(captions.text, 'reply')
  captions.end({ utteranceId: 'b1' })
  assert.equal(captions.text, 'point sentence')
  captions.sentence({ utteranceId: 'b1', text: 'obsolete sentence' })
  assert.equal(captions.text, 'point sentence')
})
test('skip clears only point captions while a barrage reply remains', () => {
  const captions = new SpeechCaptions()
  captions.start({ utteranceId: 'p1', source: 'point', text: 'point' })
  captions.start({ utteranceId: 'b1', source: 'barrage', text: 'reply' })
  captions.end({ source: 'point' })
  assert.equal(captions.text, 'reply')
  captions.end({ utteranceId: 'b1' })
  assert.equal(captions.text, '')
})
