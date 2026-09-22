# Robot Live UI — 界面开发

本目录是已集成的 Electron + Vue 控制台，不是需要另行复制的 UI 插件。
先读根目录 [快速开始](../README.md) 和 [开发维护与交接](../docs/maintainer-guide.md)。不要再次向后端插入旧版桥接代码，也不需要修改或硬编码 `PROJECT_ROOT`。

## 启动与验证

开发时在项目根目录安装依赖，然后只启动 Electron：

```bash
npm ci
npm --prefix robot-ui ci
npm --prefix robot-ui run dev
```

Electron 在开发和安装版中都自动启动三个独立后台。不要同时另开 `npm start`。
浏览器里的 Vite 页面只预览外层欢迎页和切换栏；完整机器工作区、截屏、文件和诊断功能须在 Electron 中验收。
关闭窗口会隐藏到托盘；通过托盘「退出」或应用菜单真正退出，才会停止三个后台。

```bash
# 在项目根目录验证
npm run test:ui
npm --prefix robot-ui run build
```

UI 测试以组件源码/状态契约为主，不等于完整交互验收；选区、权限、麦克风和实际播放仍需在 Electron 中检查。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `src/main/index.js`、`shell-state.mjs` | 外层窗口、三台机器视图、单页/双栏、按页面分派 IPC |
| `src/main/machine-runtime.js` | 每台机器独立的后台生命周期、设置、选区和文件 IPC |
| `src/renderer/src/MachineShell.vue` | 欢迎页、机器标签收起/展开、双栏选择 |
| `src/preload/index.js` | 主进程与 renderer 的受控 IPC 接口 |
| `src/renderer/src/App.vue` | 页面组合与应用级 UI 状态 |
| `src/renderer/src/components/Controls.vue` | 播报控制页、过渡音频卡片、识别间隔/冷却设置 |
| `src/renderer/src/components/LiveMonitor.vue` | 截屏采集和实时监控 |
| `src/renderer/src/components/SystemSettings.vue` | 连接、输出、音量、提示词等设置 |
| `../src/ui-bridge.js` | 内部控制台 WebSocket 协议，默认本机 3001 |
| `../src/tts/` | 实际准备、仲裁、播放与机器人音频发送；不在 Vue 中实现 |

OCR 选区保留透明原生窗口背景与绿色半透明 CSS；不要把 CSS 色值重新直接交给原生窗口路径。对应回归在 `test/overlay-background.test.mjs`。

## 开发与安装包的区别

- 开发：Electron 自动管理三个后台；机器 1 使用原项目数据，2/3 使用 `.local-machines/` 中的独立目录。
- 安装包：Electron main 用 `utilityProcess.fork` 启动随包后端；可写数据保存在用户目录，初次启动只补齐缺失种子，不覆盖已有配置。
- 音频：本地走 FFplay；机器人走现有 WebSocket。不要复制早期文档的 `afplay`、PowerShell 播放替换方案。
- Windows x64 发布由 CI 准备目标平台依赖，不能把 Mac `node_modules` 复制进去。应用标识和用户数据目录不能为了测试随意更改。

安装包允许清单、验证和草稿发布规则见 [Windows 测试安装包](../docs/windows-test-installer.md)。构建成功不等于实体机器人音质已经验证。

## 多机器交互验收

构建后运行 `npm --prefix robot-ui run test:machines`。脚本用临时空白配置启动真正的 Electron，
检查欢迎页、收起/展开、切换、双栏、三个后台和 OCR 同时运行，以及只重启机器 2 时其他后台不变。
OCR 使用无字体依赖的固定测试图，不截取屏幕、不播放声音、不调用付费模型或实体机器人。
截图和结果保存到 `output/machine-shell-preview/`，不进入 Git 或安装包。
Windows CI 会对打包的真实应用运行相同检查。
