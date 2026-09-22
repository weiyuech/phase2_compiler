import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Compile the active application's real templates, without mounting Electron,
// opening a socket, selecting files, or sending playback commands. The override
// allows a staged test to review the actual application before installation.
const uiRoot = process.env.ROBOT_UI_ROOT || fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(resolve(uiRoot, 'package.json'))
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')

function compileComponent(name) {
  const filename = resolve(uiRoot, 'src/renderer/src/components', name)
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  assert.deepEqual(errors, [], `${name} parses`)
  assert.ok(descriptor.template, `${name} has a template`)
  assert.doesNotThrow(() => compileScript(descriptor, { id: name }), `${name} script compiles`)
  const result = compileTemplate({ source: descriptor.template.content, filename, id: name })
  assert.deepEqual(result.errors, [], `${name} template compiles`)
  return result.ast
}

// Traverse semantic template nodes, not code-generation graphs (which share
// nodes and can contain cycles). Vue lowers conditional templates into branches.
function entries(node, ancestors = []) {
  if (!node || typeof node !== 'object') return []
  return [
    { node, ancestors },
    ...(node.children || []).flatMap(child => entries(child, [...ancestors, node])),
    ...(node.branches || []).flatMap(branch => entries(branch, [...ancestors, node])),
  ]
}

function attribute(node, name) {
  return node.props?.find(prop => prop.type === 6 && prop.name === name)?.value?.content
}

function hasClass(node, name) {
  return (attribute(node, 'class') || '').split(/\s+/).includes(name)
}

function directive(node, name, arg) {
  return node.props?.find(prop => prop.type === 7 && prop.name === name &&
    (arg === undefined || prop.arg?.content === arg))
}

function expression(prop) {
  return prop?.exp?.loc?.source
}

function textContent(node) {
  if (node.type === 2) return node.content
  if (node.type === 12) return textContent(node.content)
  return (node.children || []).map(child => typeof child === 'object' ? textContent(child) : '').join('')
}

const controls = compileComponent('Controls.vue')
const transit = compileComponent('TransitAudioSettings.vue')
const controlNodes = entries(controls)
const transitNodes = entries(transit)

function uniqueControl(className) {
  const matching = controlNodes.filter(({ node }) => hasClass(node, className))
  assert.equal(matching.length, 1, `one ${className}`)
  return matching[0]
}

function hasTitle(node, title) {
  return entries(node).some(({ node: child }) => textContent(child).trim() === title)
}

test('broadcast control page stays on one page without additional tab navigation', () => {
  const forbiddenRoles = new Set(['tab', 'tablist', 'tabpanel'])
  assert.equal(controlNodes.filter(({ node }) => forbiddenRoles.has(attribute(node, 'role'))).length, 0)
  assert.equal(controlNodes.filter(({ node }) => hasClass(node, 'controls-tabs')).length, 0)
  uniqueControl('controls-layout')
  uniqueControl('controls-grid')
})

test('compact operating strip keeps tour and broadcast actions in separate labelled groups', () => {
  const strip = uniqueControl('controls-toolbar')
  const grid = uniqueControl('controls-grid')
  const content = strip.ancestors.at(-1)
  assert.equal(grid.ancestors.at(-1), content, 'lower grid is a sibling of the strip')
  assert.ok(content.children.indexOf(strip.node) < content.children.indexOf(grid.node), 'operating strip appears first')
  const panels = strip.node.children.filter(node => hasClass(node, 'tour-control') || hasClass(node, 'broadcast-control'))
  assert.equal(panels.length, 2)
  assert.ok(hasClass(panels[0], 'tour-control'))
  assert.ok(hasClass(panels[1], 'broadcast-control'))
  assert.ok(hasTitle(panels[0], '巡游控制'))
  assert.ok(hasTitle(panels[1], '播报控制'))
  uniqueControl('tour-control')
  uniqueControl('broadcast-control')
})

test('broadcast group uses its red pause/resume button without a separate running label', () => {
  const broadcast = uniqueControl('broadcast-control').node
  const broadcastNodes = entries(broadcast)
  assert.equal(broadcastNodes.filter(({ node }) => hasClass(node, 'status-pill')).length, 0)
  assert.doesNotMatch(textContent(broadcast), /允许播报|运行中|已暂停/)
  const pause = broadcastNodes.find(({ node }) => expression(directive(node, 'on', 'click')) === 'togglePause')?.node
  assert.ok(pause, 'pause/resume control belongs to the broadcast group')
  assert.equal(expression(directive(pause, 'bind', 'type')), "isPaused ? 'primary' : 'danger'")
  assert.match(pause.loc.source, /恢复播报/)
  assert.match(pause.loc.source, /暂停播报/)
})

test('lower workspace places transit beside a barrage-then-manual stack', () => {
  const grid = uniqueControl('controls-grid').node
  const transitCard = uniqueControl('transit-card')
  const side = uniqueControl('controls-side')
  assert.equal(transitCard.ancestors.at(-1), grid, 'transit is a direct grid child')
  assert.ok(hasClass(transitCard.node, 'control-card'))
  assert.equal(side.ancestors.at(-1), grid, 'right stack is a direct grid child')
  assert.ok(grid.children.indexOf(transitCard.node) < grid.children.indexOf(side.node), 'transit precedes the right stack')
  const sideCards = side.node.children.filter(node => hasClass(node, 'control-card'))
  assert.equal(sideCards.length, 2)
  assert.ok(hasClass(sideCards[0], 'barrage-card'))
  assert.ok(hasClass(sideCards[1], 'test-card'))
  assert.ok(hasTitle(sideCards[0], '弹幕识别'))
  assert.ok(hasTitle(sideCards[1], '手动播报测试'))
})

test('transition audio remains always mounted with one shared form and socket binding', () => {
  const components = controlNodes.filter(({ node }) => node.tag === 'TransitAudioSettings')
  assert.equal(components.length, 1, 'one transition form, with no duplicate settings instance')
  const { node, ancestors } = components[0]
  assert.ok(hasClass(ancestors.at(-1), 'transit-card'), 'form stays in its card')
  for (const ancestor of [...ancestors, node]) {
    assert.equal(directive(ancestor, 'show'), undefined, 'the form and its ancestors are not v-show gated')
    assert.equal(directive(ancestor, 'if'), undefined, 'the form and its ancestors are not v-if gated')
    assert.ok(![9, 10, 11].includes(ancestor.type), 'form is not nested in a compiled conditional or loop')
  }
  assert.equal(expression(directive(node, 'bind', 'ws-ref')), 'props.wsRef')
})

test('existing tour, broadcast, barrage, and manual-test bindings are preserved', () => {
  const models = new Set(controlNodes.map(({ node }) => expression(directive(node, 'model'))).filter(Boolean))
  for (const expected of ['repeatCount', 'barrageEnabled', 'barrageCooldown', 'testText']) {
    assert.ok(models.has(expected), `existing control is still bound: ${expected}`)
  }
  const clickHandlers = new Set(controlNodes.map(({ node }) => expression(directive(node, 'on', 'click'))).filter(Boolean))
  for (const expected of ['startTour', "send('PAUSE_TOUR')", "send('RESUME_TOUR')", "send('STOP_TOUR')", "send('SKIP_POINT')", 'togglePause', 'sendTestSpeech', 'downloadBarrageLog', 'exportDiagnostics']) {
    assert.ok(clickHandlers.has(expected), `existing action is preserved: ${expected}`)
  }
  const changes = new Set(controlNodes.map(({ node }) => expression(directive(node, 'on', 'change'))).filter(Boolean))
  assert.ok(changes.has('onBarrageToggle'))
  assert.ok(changes.has('onCooldownChange'))
})

test('tour action visibility and disconnected/manual-input guards stay intact', () => {
  const conditions = new Map([
    ['startTour', "tourStatus === 'idle' || tourStatus === 'finished'"],
    ["send('PAUSE_TOUR')", "tourStatus === 'running'"],
    ["send('RESUME_TOUR')", "tourStatus === 'paused'"],
    ["send('STOP_TOUR')", "tourStatus === 'running' || tourStatus === 'paused'"],
    ["send('SKIP_POINT')", "tourStatus === 'running' || tourStatus === 'paused'"],
  ])
  for (const [handler, condition] of conditions) {
    const matches = controlNodes.filter(({ node }) => expression(directive(node, 'on', 'click')) === handler)
    assert.equal(matches.length, 1, `one ${handler} button`)
    const { node, ancestors } = matches[0]
    assert.ok(ancestors.some(ancestor => ancestor.type === 10 && ancestor.condition?.loc?.source === condition),
      `same tour-state condition: ${handler}`)
    assert.equal(expression(directive(node, 'bind', 'disabled')), '!wsConnected')
  }
  const pause = controlNodes.find(({ node }) => expression(directive(node, 'on', 'click')) === 'togglePause').node
  assert.equal(expression(directive(pause, 'bind', 'disabled')), '!wsConnected')
  const manual = controlNodes.find(({ node }) => expression(directive(node, 'on', 'click')) === 'sendTestSpeech').node
  assert.equal(expression(directive(manual, 'bind', 'disabled')), '!canTestSpeech')
})

test('transition card preserves TTS, shared-pool, repeat/shuffle, file selection, and save bindings', () => {
  const models = new Set(transitNodes.map(({ node }) => expression(directive(node, 'model'))).filter(Boolean))
  assert.deepEqual([...models].sort(), [
    'transitConfig.enabled', 'transitConfig.type', 'transitConfig.text',
    'transitConfig.mp3_mode', 'transitConfig.mp3_file',
  ].sort())
  const radioValues = transitNodes
    .filter(({ node }) => node.tag === 'el-radio-button')
    .map(({ node }) => attribute(node, 'value'))
  assert.deepEqual(radioValues, ['tts', 'mp3', 'repeat', 'shuffle'])
  const clickHandlers = new Set(transitNodes.map(({ node }) => expression(directive(node, 'on', 'click'))).filter(Boolean))
  for (const expected of ['pickTransitMp3', 'removeTransitMp3(file)', 'saveTransitConfig']) {
    assert.ok(clickHandlers.has(expected), expected)
  }
  assert.ok(transitNodes.some(({ node }) => hasClass(node, 'transit-pool')))
  assert.ok(transitNodes.some(({ node }) => hasClass(node, 'transit-pool-file')))
  const saveButton = transitNodes.find(({ node }) => expression(directive(node, 'on', 'click')) === 'saveTransitConfig').node
  assert.equal(expression(directive(saveButton, 'bind', 'loading')), 'savingTransit')
})
