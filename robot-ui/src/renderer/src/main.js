import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import BarrageOverlay from './BarrageOverlay.vue'

const ComponentToRender = window.location.hash === '#/overlay' ? BarrageOverlay : App

const app = createApp(ComponentToRender)
app.use(ElementPlus)
app.mount('#app')

