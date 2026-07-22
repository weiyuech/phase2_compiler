<template>
  <div class="overlay-container">
    <div class="instructions">
      拖拽鼠标框选弹幕区域
    </div>

    <div 
      class="selection-area"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
    >
      <div 
        v-if="isSelecting || hasSelection"
        class="selection-box"
        :style="boxStyle"
      ></div>
    </div>

    <div v-if="hasSelection" class="controls" :style="controlsStyle">
      <el-button type="primary" size="small" @click="confirmSelection">确定</el-button>
      <el-button type="danger" size="small" @click="cancelSelection">取消</el-button>
    </div>
    <div v-else class="controls-fixed">
      <el-button type="danger" size="small" @click="cancelSelection">退出</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const startX = ref(0)
const startY = ref(0)
const currentX = ref(0)
const currentY = ref(0)
const isSelecting = ref(false)
const hasSelection = ref(false)

const boxStyle = computed(() => {
  const x = Math.min(startX.value, currentX.value)
  const y = Math.min(startY.value, currentY.value)
  const width = Math.abs(startX.value - currentX.value)
  const height = Math.abs(startY.value - currentY.value)
  return {
    left: `${x}px`,
    top: `${y}px`,
    width: `${width}px`,
    height: `${height}px`
  }
})

const controlsStyle = computed(() => {
  const x = Math.min(startX.value, currentX.value)
  const y = Math.max(startY.value, currentY.value)
  return {
    left: `${x}px`,
    top: `${y + 10}px`
  }
})

function onMouseDown(e) {
  // Only start selection if left click
  if (e.button !== 0) return
  hasSelection.value = false
  isSelecting.value = true
  startX.value = e.clientX
  startY.value = e.clientY
  currentX.value = e.clientX
  currentY.value = e.clientY
}

function onMouseMove(e) {
  if (!isSelecting.value) return
  currentX.value = e.clientX
  currentY.value = e.clientY
}

function onMouseUp() {
  isSelecting.value = false
  // Require at least a 20x20 box to be considered a selection
  if (Math.abs(startX.value - currentX.value) > 20 && Math.abs(startY.value - currentY.value) > 20) {
    hasSelection.value = true
  } else {
    hasSelection.value = false
  }
}

function confirmSelection() {
  const x = Math.min(startX.value, currentX.value)
  const y = Math.min(startY.value, currentY.value)
  const width = Math.abs(startX.value - currentX.value)
  const height = Math.abs(startY.value - currentY.value)
  
  // Send back to main process
  window.api.closeBarrageOverlay({ x, y, width, height })
}

function cancelSelection() {
  window.api.closeBarrageOverlay(null)
}
</script>

<style scoped>
.overlay-container {
  width: 100vw;
  height: 100vh;
  /* Light green veil with 80% transparency (0.2 opacity) */
  background-color: rgba(74, 222, 128, 0.2);
  position: relative;
  overflow: hidden;
  user-select: none;
}

.instructions {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.7);
  color: white;
  padding: 10px 20px;
  border-radius: 6px;
  font-size: 16px;
  pointer-events: none;
  z-index: 100;
}

.selection-area {
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

.selection-box {
  position: absolute;
  border: 2px dashed #f59e0b;
  background-color: rgba(245, 158, 11, 0.2);
  pointer-events: none;
}

.controls {
  position: absolute;
  display: flex;
  gap: 10px;
  z-index: 100;
}

.controls-fixed {
  position: absolute;
  top: 20px;
  right: 20px;
  z-index: 100;
}
</style>

<style>
/* Override global backgrounds for the overlay window */
html, body, #app {
  background: transparent !important;
}
</style>
