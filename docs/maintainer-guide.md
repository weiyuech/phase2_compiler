# 开发维护与交接

当前多机器分支版本：`1.1.0-test.1`。既有测试标签与安装包保持不变；运行或交接时同时记录源码提交号与 UI 版本，不只看版本名称。新安装包须经过下文的 Windows 检查与精确标签交付。

## 1. 先确认正在操作哪份代码

本机日常入口是 `/Users/user/robot-live-system`。Codex worktree 是另一份独立工作目录，不会随日常目录一起更新；它不是云端代码。其他开发者使用自己的 clone，无须复制本机路径。

在将要启动的目录运行：

```bash
git rev-parse --show-toplevel
git branch --show-current
git log -1 --oneline
git status --short
git worktree list
node -p "require('./robot-ui/package.json').version"
```

更新流程：

1. 停止现场任务及该目录的后端/Electron；同一台电脑只启动一份桌面外壳；外壳内部自动管理三个机器后台，不另开根目录 `npm start`。
2. 保存本地代码改动，备份用户数据；不要用 `reset --hard` 或整目录覆盖来「同步」。只对明确文件做有名称的备份/stash，查看差异后决定如何合并。
3. `git fetch origin` 后核对要更新到的**精确提交**。优先 `git merge --ff-only <reviewed-commit>`；若拒绝，说明需要审查分歧，不能强行覆盖。关联 worktree 的本地已审查提交也可直接快进，不要求先推送。
4. 在根目录、`robot-ui/` 各执行 `npm ci`，然后运行下节检查。锁文件更新后，运行中的旧进程和旧 `node_modules` 不会自动变成新版本。
5. 记录两个目录的 HEAD、未提交差异和备份位置。不要未经审查直接 `stash pop`，否则旧依赖或旧功能可能被重新带回来。

相同 HEAD 只说明已提交代码相同；本地配置、未提交文件和依赖还需分别检查。不要自动在两个 worktree 之间双向复制文件。

## 2. 最小可复现验证

Node.js 22，依赖以两个 `package-lock.json` 为准。根包版本不是安装器版本；安装器版本在 `robot-ui/package.json` 及其锁文件。

```bash
npm ci
npm --prefix robot-ui ci
npm run test:all
npm run test:ocr
npm --prefix robot-ui run build
```

- `npm test` 只跑后端，`npm run test:ui` 只跑 UI，`test:all` 显式枚举两组文件并使用与 Windows CI 相同的并发数，避免 shell 通配符差异。
- `test:ocr` 使用真实 Sharp、ONNX 检测/识别模型和固定图，包含 session 初始化、结果校验与 worker 关闭。无需密钥、截屏权限或机器人，不写用户设置。
- 完整原生 OCR 生命周期：`node scripts/eval-ocr-workflow.mjs --report <临时报告路径>`。默认判断/回答是受控替身，不产生 API 费用；不等于真实模型语义准确率。
- `scripts/eval-ocr-judge-live.mjs --settings <测试账号配置> ...` 会真实调用 API，需单独授权和额度。不要把密钥或生产文本加进测试样例。
- Windows 打包原生依赖、安装升级、OS 选区权限和实体机器人听感不能用 Mac 单元测试代替。已知边界与现场验收见 [测试安装包说明](windows-test-installer.md)。

## 3. 从哪里读代码

| 需求 | 首要入口 | 回归重点 |
| --- | --- | --- |
| 多机器窗口、分屏与工作区隔离 | `robot-ui/src/main/{index,machine-runtime}.js`、`shell-state.mjs`、`MachineShell.vue` | `machine-profile`、`machine-shell`、`npm --prefix robot-ui run test:machines` |
| 应用接线、共享对象与销毁 | `src/index.js`、`src/ui-bridge.js` | `tour-ui-controls`、`cruise-websocket` |
| 机器人连接/导航 | `src/robot/listener.js`、`goal-tracker.js`、`src/task/cruise-controller.js` | `cruise-navigation`、`cruise-websocket` |
| 点位与过渡内容 | `src/task/point-narrator.js`、`src/transit/manager.js` | `point-handoff`、`transit-pool`、`local-playback-handoff` |
| 优先级、准备、句尾交接 | `src/tts/speech-coordinator.js`、`sentence-preparation.js`、`index.js` | `speech-coordinator`、`sentence-engine`、`prepared-handoff-integration` |
| 机器人 PCM 发送与缓存 | `src/tts/audio-output-router.js`、`prepared-audio-router.js`、`prepared-audio-cache.js` | `robot-prepared-audio`、`audio-output` |
| 弹幕生产接线与回复机会 | `src/phase2/index.js`、`barrage-decisions.js`、`barrage-timing.js` | `barrage-decisions`、`barrage-pipeline` |
| 弹幕内容匹配、回答、播放 | `src/phase2/barrage-manager.js`、`src/knowledge/barrage-provider.js` | `barrage-handoff`、`barrage-pipeline` |
| 截图、OCR、判断器 | `LiveMonitor.vue`、`src/phase2/ocr/{index,worker,image-change,text-judge,judge-prompt}.js` | `ocr-observations`、`ocr-worker-client`、`ocr-incremental` |
| 提示词与回答 API | `src/llm/`、`src/phase2/ocr/judge-prompt.js`、`SystemSettings.vue` | `llm-custom-cancellation`、UI `ocr-judge-prompt` |
| 日志、诊断、安装种子 | `src/diagnostics/`、`src/packaging/`、`robot-ui/scripts/` | `audio-diagnostics`、`package-seed`、`packaged-runtime` |

表中后端测试在 `test/*.test.js`，UI 测试在 `robot-ui/test/*.test.mjs`；Vue 组件在 `robot-ui/src/renderer/src/components/`。

`phase2` 是历史命名，现已承载生产弹幕功能，不是可随意移除的实验模块。`BarrageManager` 的直接调用兼容路径仍保留 `latestBarrageEvent`，但**生产入口由 `BarrageDecisionClock` 调用，传入 `requireReady: true, externalCadence: true`**。不要只读兼容路径就认定线上仍在排队补播。

## 4. 修改时必须保留的约定

### 播放

- 助播 > 弹幕 > 点位讲解 > 过渡。准备不占用说话权，低优先级音频在新音频准备时继续。
- TTS 自动交接在当前句结束后；点位恢复从下一句开始，过渡交出后丢弃剩余段落。MP3 不猜测句子；显式停止/跳过和助播打断仍立即处理。
- 每个 TTS 句子或完整 MP3 先准备完 PCM，再向机器人实时发送。共享一个 socket，不上传整段、不添加协议没有的 flush/播放完成命令。
- 640 bytes / 20 ms、16 kHz mono S16_LE；跨来源交接也保留包间距。序号、source/session、暂停原因和旧连接失效不能分散到 UI 或各个播放器中重复实现。
- 播放/准备回调必须验证所属任务与连接；旧回调不能清除新字幕、恢复旧点或在新 socket 继续。

详见 [音频交接](local-audio-handoff.md)、[准备与诊断](prepared-audio-diagnostics.md)、[机器人协议](robot-protocol.md)。

### 弹幕和三个 OCR 记录

1. **图像比较参考**：worker 上次实际 OCR 处理的画面，用于跳过近似图像的重复识别。
2. **当前原始观察**：最新截图及配对的原始 OCR；有界保留最近两个完成的图文对，另有有界执行/待处理工作。
3. **TTS 判断基线**：上次成功判断的原始 OCR 文字与元信息；不是模型输出，也不另存第三张图片文件。

扫描/原始日志与回复冷却独立。空闲冷却机会才调用 TTS 判断器，冻结 `<previous_ocr>` / `<current_ocr>`；成功（包括严格的 `无新问题`）更新基线，失败或忙碌跳过不更新。无新问题不生成回答；其他非空判断文本才交给回答 LLM。没有第二个恢复判断器、逐问题积压队列或原始 OCR 兜底播报。

MP3 只对当前 OCR 做匹配，不调用任何 LLM、不使用 TTS 判断基线；同样跳过准备、等待句尾、播放或助播占用期间的冷却机会。结束后不补播。详细时钟、取整、重试与取消规则以 [当前设计](barrage-cooldown-design.md) 为准；历史评估不是当前实现说明。

## 5. 数据、提交与交付

- 开发数据位于项目内；安装版使用 Electron `userData`。现有配置、音频、知识库和密钥属于用户，不能用测试种子覆盖。
- `data/barrage-knowledge/config.json` 等部分历史数据文件仍被 Git 跟踪：忽略规则不会保护已经跟踪的文件。逐个检查 `git diff`，显式 `git add <files>`；不要 `git add .`。
- 本地根目录历史日志及 `data/` 内日志已忽略，仍保留在磁盘。安装包仅取允许清单和生成的干净种子，不能直接复制整个项目。
- 修改依赖时同时维护锁文件，保留 ONNX/Sharp/FFmpeg 的目标平台验证；不得拿本机原生库替换 Windows 包内文件。
- 每个提交聚焦一个目的，写明原因、验证命令和未验证部分。交接至少提供提交号、改动入口、测试结果、运行方法、剩余风险；发布另记标签和安装包 SHA-256。
- 不移动已发布测试标签、不覆盖资产、不把草稿自动转正式发布。维护文档或本机通过不代表已生成新安装包。
