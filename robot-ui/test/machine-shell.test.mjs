import test from 'node:test'
import assert from 'node:assert/strict'
import { ShellState } from '../src/main/shell-state.mjs'

test('welcome is launch-only, starts in machine 1 and switching/collapse never restores it', () => {
  const session = new ShellState()
  assert.deepEqual(session.snapshot(), { entered: false, activeMachine: 1, collapsed: false, layout: 'single', panes: [1, 2] })
  session.enter()
  session.select(2)
  session.toggle()
  assert.deepEqual(session.snapshot(), { entered: true, activeMachine: 2, collapsed: true, layout: 'single', panes: [1, 2] })
  session.toggle()
  assert.deepEqual(session.snapshot(), { entered: true, activeMachine: 2, collapsed: false, layout: 'single', panes: [1, 2] })
  assert.equal(new ShellState().entered, false, 'only a new app session restores the welcome')
})

test('collapsed navigation returns space to the current workspace and accepts only known machines', () => {
  const session = new ShellState()
  assert.deepEqual(session.bounds(1280, 820), { x: 0, y: 68, width: 1280, height: 752 })
  session.toggle()
  assert.deepEqual(session.bounds(1280, 820), { x: 0, y: 40, width: 1280, height: 780 })
  for (const id of [0, 4, '1', null, '../1']) assert.throws(() => session.select(id), /Unknown machine/)
  assert.equal(session.activeMachine, 1)
})


test('split view shows two distinct machines, swaps duplicate selections and preserves active machine on return', () => {
  const session = new ShellState()
  session.enter()
  session.setLayout('split')
  assert.deepEqual(session.visibleMachines, [1, 2])
  assert.deepEqual(session.bounds(1280, 820, 1), { x: 0, y: 104, width: 639, height: 716 })
  assert.deepEqual(session.bounds(1280, 820, 2), { x: 641, y: 104, width: 639, height: 716 })
  session.selectPane(1, 3)
  assert.deepEqual(session.visibleMachines, [1, 3])
  session.selectPane(0, 3)
  assert.deepEqual(session.visibleMachines, [3, 1])
  session.select(2)
  assert.deepEqual(session.visibleMachines, [2, 1], 'top tabs replace only the focused pane')
  session.toggle()
  assert.equal(session.headerHeight, 76)
  session.setLayout('single')
  assert.deepEqual(session.visibleMachines, [2])
  assert.equal(session.entered, true)
  assert.throws(() => session.selectPane(2, 1))
  assert.throws(() => session.selectPane(0, 4))
  assert.throws(() => session.setLayout('unknown'))
  const snapshot = session.snapshot()
  snapshot.panes[0] = 99
  assert.equal(session.panes[0], 2, 'renderer snapshots cannot mutate shell state')
})
