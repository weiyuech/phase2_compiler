# Robot Live UI — 界面开发

本目录是已集成的 Electron + Vue 控制台，不是需要另行复制的 UI 插件。
先读根目录 [快速开始](../README.md) 和 [开发维护与交接](../docs/maintainer-guide.md)。不要再次向后端插入旧版桥接代码，也不需要修改或硬编码 `PROJECT_ROOT`。

## 启动与验证

开发时需要两个终端；以下命令都从项目根目录开始：

```bash
# 终端一：后端
npm ci
npm start
```

```bash
# 终端二：Electron（含 Vite 开发服务）
cd robot-ui
npm ci
npm run dev
```

开发模式的 Electron **不会自动启动后端**。浏览器中的 Vite 页面不能代替 Electron 的截屏、选区、文件和诊断导出能力。关闭开发应用时，也关闭对应后端，避免另一份旧代码继续占用 3001 端口。

```bash
# 在项目根目录验证
npm run test:ui
npm --prefix robot-ui run build
```

UI 测试以组件源码/状态契约为主，不等于完整交互验收；选区、权限、麦克风和实际播放仍需在 Electron 中检查。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `src/main/index.js` | 窗口、截屏选区、文件 IPC、打包后端生命周期、诊断导出 |
| `src/preload/index.js` | 主进程与 renderer 的受控 IPC 接口 |
| `src/renderer/src/App.vue` | 页面组合与应用级 UI 状态 |
| `src/renderer/src/components/Controls.vue` | 播报控制页、过渡音频卡片、识别间隔/冷却设置 |
| `src/renderer/src/components/LiveMonitor.vue` | 截屏采集和实时监控 |
| `src/renderer/src/components/SystemSettings.vue` | 连接、输出、音量、提示词等设置 |
| `../src/ui-bridge.js` | 内部控制台 WebSocket 协议，默认本机 3001 |
| `../src/tts/` | 实际准备、仲裁、播放与机器人音频发送；不在 Vue 中实现 |

OCR 选区保留透明原生窗口背景与绿色半透明 CSS；不要把 CSS 色值重新直接交给原生窗口路径。对应回归在 `test/overlay-background.test.mjs`。

## 开发与安装包的区别

- 开发：后端独立运行，数据使用项目目录下的 `data/`、`config/`；原生依赖使用当前 Node 架构。
- 安装包：Electron main 用 `utilityProcess.fork` 启动随包后端；可写数据保存在用户目录，初次启动只补齐缺失种子，不覆盖已有配置。
- 音频：本地走 FFplay；机器人走现有 WebSocket。不要复制早期文档的 `afplay`、PowerShell 播放替换方案。
- Windows x64 发布由 CI 准备目标平台依赖，不能把 Mac `node_modules` 复制进去。应用标识和用户数据目录不能为了测试随意更改。

安装包允许清单、验证和草稿发布规则见 [Windows 测试安装包](../docs/windows-test-installer.md)。构建成功不等于实体机器人音质已经验证。
