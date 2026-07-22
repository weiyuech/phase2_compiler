# Robot Live UI — 安装与使用说明

## 目录结构

把整个 `ui/` 文件夹放进你的 `robot-live-system/` 目录下：

```
robot-live-system/
├── src/
│   ├── index.js          ← 你的现有后端（加几行代码）
│   ├── ui-bridge.js      ← 新增（从本包复制过来）
│   └── ...
├── ui/                   ← 整个 Electron UI 放这里
│   ├── package.json
│   ├── electron.vite.config.mjs
│   └── src/
└── ...
```

---

## Step 1 — 修改后端 src/index.js

在你的 `src/index.js` 顶部加上：

```js
const uiBridge = require('./ui-bridge');
uiBridge.start(); // 启动 WebSocket on port 3001
```

然后在合适的位置加上广播，例如：

```js
// 当机器人到达点位时
uiBridge.broadcast('POINT_ARRIVED', { point_id: 'point_001' });

// TTS 开始播放时
uiBridge.broadcast('SPEECH_START', { text: llmOutput });

// TTS 播放结束
uiBridge.broadcast('SPEECH_END', {});

// Ducking 开始/结束
uiBridge.broadcast('DUCK_START', {});
uiBridge.broadcast('DUCK_END', {});

// 发出 ACK 时
uiBridge.broadcast('ACK_SENT', { point_id: currentPointId });
```

暂停检查（在播报队列逻辑中）：

```js
if (uiBridge.isPaused()) return; // 跳过这次播报

// 用 UI 设置的 duck volume
const vol = uiBridge.getDuckVolume(); // 0.0 ~ 1.0
```

监听 UI 控制命令（可选，如果你的 ducker 支持动态参数）：

```js
uiBridge.on('onSetDuckVolume', (vol) => {
  ducker.setDuckVolume(vol);
});
uiBridge.on('onSetFadeMs', (ms) => {
  ducker.setFadeMs(ms);
});
uiBridge.on('onTestSpeech', async (text) => {
  await tts.speak(text);
});
uiBridge.on('onSkipPoint', () => {
  robot.sendAck({ action: 'skip' });
});
```

---

## Step 2 — 设置 PROJECT_ROOT

打开 `ui/src/main/index.js`，找到这一行：

```js
const PROJECT_ROOT = resolve(app.getPath('home'), 'robot-live-system')
```

改成你项目的实际路径，例如：
```js
const PROJECT_ROOT = 'C:\\Users\\YourName\\robot-live-system'
```

---

## Step 3 — 安装依赖并运行 UI

```bash
cd robot-live-system/ui
npm install
npm run dev          # 开发模式（热重载）
```

打包成 .exe（Windows）：
```bash
npm run package
# 输出在 ui/dist/ 目录
```

---

## Windows 音频说明（直播伴侣对接）

1. 下载安装 **VB-Audio Virtual Cable**（免费）：https://vb-audio.com/Cable/
2. 你的 Node.js 后端将 TTS 音频输出到 "CABLE Input" 虚拟设备
3. 打开直播伴侣 → 音频设置 → 选择 "CABLE Output" 作为麦克风输入
4. Mac/Windows 没有区别，只要后端运行在 Windows 上就行

**注意**：你的 `src/tts/audio-player.js` 可能用了 `afplay`（Mac 专用），
需要改成 Windows 兼容的方式。最简单的替代：
```js
const { exec } = require('child_process');
exec(`powershell -c (New-Object Media.SoundPlayer "${wavFile}").PlaySync()`);
// 或者用 mplayer / vlc 命令行
```
