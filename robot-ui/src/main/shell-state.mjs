export class ShellState {
  constructor() {
    this.entered = false
    this.activeMachine = 1
    this.collapsed = false
    this.layout = 'single'
    this.panes = [1, 2]
  }
  snapshot() {
    return { entered: this.entered, activeMachine: this.activeMachine, collapsed: this.collapsed,
      layout: this.layout, panes: [...this.panes] }
  }
  enter() { this.entered = true; return this.snapshot() }
  select(id) {
    if (![1, 2, 3].includes(id)) throw new Error('Unknown machine')
    if (this.layout === 'split' && !this.panes.includes(id)) {
      const pane = Math.max(0, this.panes.indexOf(this.activeMachine))
      this.panes[pane] = id
    }
    this.activeMachine = id
    return this.snapshot()
  }
  toggle() { this.collapsed = !this.collapsed; return this.snapshot() }
  setLayout(layout) {
    if (!['single', 'split'].includes(layout)) throw new Error('Unknown layout')
    this.layout = layout
    if (layout === 'split' && !this.panes.includes(this.activeMachine)) this.panes[0] = this.activeMachine
    return this.snapshot()
  }
  selectPane(pane, id) {
    if (![0, 1].includes(pane) || ![1, 2, 3].includes(id)) throw new Error('Unknown pane or machine')
    const other = 1 - pane
    if (this.panes[other] === id) this.panes[other] = this.panes[pane]
    this.panes[pane] = id
    this.activeMachine = id
    return this.snapshot()
  }
  get visibleMachines() { return this.entered ? (this.layout === 'split' ? [...this.panes] : [this.activeMachine]) : [] }
  get headerHeight() { return (this.collapsed ? 40 : 68) + (this.layout === 'split' ? 36 : 0) }
  bounds(width, height, id = this.activeMachine) {
    const bounds = { x: 0, y: this.headerHeight, width: Math.max(0, width), height: Math.max(0, height - this.headerHeight) }
    if (this.layout === 'split' && this.panes.includes(id)) {
      const leftWidth = Math.floor((width - 2) / 2)
      const right = this.panes.indexOf(id) === 1
      bounds.x = right ? leftWidth + 2 : 0
      bounds.width = Math.max(0, right ? width - bounds.x : leftWidth)
    }
    return bounds
  }
}
