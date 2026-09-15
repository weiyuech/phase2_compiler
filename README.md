# 机器人巡游直播讲解系统

工作人员在控制面板配置巡游清单，系统按顺序指挥机器人前往每个点位，到达后自动查询知识库、LLM 改写、TTS 播报，播完自动前往下一个点。支持过渡音频（行进期间循环播放）和助播 Ducking（助播开麦时 TTS 自动暂停）。

---

## 快速开始

### 开发模式

首次运行从本文件开始；[开发维护与交接](docs/maintainer-guide.md) 说明代码入口、行为约定、测试和多工作目录更新方法，[界面开发说明](robot-ui/README.md) 补充 Electron 相关内容。
使用 Node.js 22。需要两个终端：保留后端终端，再打开另一个终端启动界面；`Ctrl+C` 停止对应程序。不要同时从两个工作目录启动应用。

```bash
# 后端（先进入项目根目录）
npm ci
npm start

# 前端（另开终端，也先进入项目根目录）
cd robot-ui
npm ci
npm run dev

# 机器人音频传输测试器（可选，另开终端）
# macOS / Linux
python3 robot_audio_transport_test.py
# Windows
py robot_audio_transport_test.py
```

### 本地验证

```bash
# 在项目根目录运行；不会调用付费 LLM 或向实体机器人发送命令
npm run test:all   # 后端 + UI 自动化回归（部分测试绑定本机临时端口）
npm run test:ocr   # 真实 OCR 模型识别固定测试图，不截屏、不播放音频
npm --prefix robot-ui run build
```

`test:ocr` 只有识别出 `ROBOT 12345` 且置信度达标才显示 `[OCR check] PASS`；失败或超时以非零状态退出，并释放识别 worker。它验证本机原生依赖与模型，不验证操作系统截屏权限、Windows 安装包或机器人实际发声。

`onnxruntime-node` 当前固定为 **1.23.2**，与已验证的锁文件一致。遇到原生库缺失时，先核对 `node -p "process.platform + '/' + process.arch"`，再在正确的工作目录执行 `npm ci` 和 `npm run test:ocr`。不要从旧目录复制 `node_modules` 或仅为解决本机问题回退已验证的依赖版本。

### 打包安装包

```bash
# 仅在 Windows x64 构建环境本地试打包
cd robot-ui
npm ci
npm run package   # 产出项目根目录 release/ 下的 .exe
```

Windows 测试安装包通过精确版本标签构建，完成回归、音频解码、OCR 和应用启动检查后，仅上传到新建的草稿发布。不会合并 `main`、公开发布或覆盖已有安装包。详见 [Windows 测试安装包与验收](docs/windows-test-installer.md)。

---

## 项目结构

```
robot-live-system/
├── src/
│   ├── index.js               # 后端主入口
│   ├── robot/listener.js      # 机器人 WebSocket（远程客户端 / 本地监听）
│   ├── task/manager.js        # 巡游清单驱动
│   ├── knowledge/             # 知识库（flatfile / sqlite）
│   ├── llm/                   # LLM 改写（豆包主 + DeepSeek 备）
│   ├── tts/                   # TTS 合成 + AudioPlayer
│   ├── transit/manager.js     # 过渡音频管理
│   ├── phase2/                # 弹幕 OCR、冷却调度与回复（生产功能）
│   ├── diagnostics/           # 有界音频诊断与后台日志
│   ├── ui-bridge.js           # 控制面板 WebSocket（port 3001）
│   └── tunnel.js              # ngrok 内网穿透（可选）
├── robot-ui/                  # Electron 控制面板（Vue 3）
├── data/
│   ├── flatfiles/             # 知识库内容（{map}/{path}/{goal_id}.json）
│   ├── tour-list.json         # 巡游清单持久化
│   └── transit-audio.json     # 过渡音频配置
├── config/
│   └── banned-words.txt       # 违禁词列表（每行一个，# 注释）
└── .env                       # API Key 等配置
```

## 弹幕识别与播报

识别间隔控制截屏/识别频率，播报冷却控制回复机会；两者独立。冷却取最接近的识别间隔倍数，至少一个间隔。准备或播放弹幕时跳过该次回复机会，不在结束后补播；原始 OCR 日志仍可更新。

TTS 在空闲回复机会比较「上次成功判断的原始 OCR」与「当前原始 OCR」，仅将判断器返回的新增问题送入回答 LLM。严格返回 `无新问题` 时不回答、不播放，但更新成功判断基线；失败或忙碌跳过不更新。MP3 不调用 LLM，按当前 OCR 匹配素材，同样遵守冷却和优先级。

完整状态与保留规则见 [弹幕冷却与原始 OCR 所有权](docs/barrage-cooldown-design.md)。早期评估文档仅作历史记录，不能代替当前规则。

---

## 知识库

### 文件路径格式

```
data/flatfiles/{map_name}/{path_name}/{goal_id}.json
```

### 内容格式

```json
{
  "body":     "喂给 LLM 的讲解原文；LLM 失败时直接播报此字段",
  "mp3_file": "可选，预录 MP3 路径（相对项目根目录）"
}
```

- `body` 和 `mp3_file` 至少填一个。
- 播放模式（TTS / MP3）在巡游清单的点位条目里设置，不在知识库里。
- 建议通过控制面板「知识库」页增删改，勿直接编辑文件（打包后数据在 userData 目录）。

---

## 巡游清单

在控制面板「点位编辑」页配置，每个点位包含：

| 字段 | 说明 |
|---|---|
| `map_name` | 地图名 |
| `path_name` | 路径名 |
| `goal_id` | 目标点 ID（整数） |
| `goal_object` | 对准目标（可选） |
| `play_mode` | `tts`（LLM 改写后合成）或 `mp3`（播预录文件） |

到达顺序即列表顺序，支持拖拽排序。

巡游规则（2026-08-31）：

- **导航到达就播报，不等待物体对准。** 导航失败会提示并跳过该点介绍。
- 清单必须与所选地图一致；每次发目标前还检查机器人最近 10 秒内的地图心跳为同图且 `ready`。不一致会拒绝发送，不会自动切图。
- 只有匹配当前点的确认和随后匹配的 `done` 心跳才能触发一次播报，不要求先出现 `going`；其他点位的旧消息不能冒充当前点到达。
- 默认确认超时 5 秒、确认后到达超时 180 秒；超时或地图异常暂停并提示。
- 跳过当前点：前往下一点；已经在播放或合成的过渡音频继续，不从头重来。若正在讲解，仅结束当前点介绍。删除当前点并提交清单后，转向下一个仍保留的点；删除已经经过的点不打断正在执行的点。
- 暂停保留当前点、音频位置和后续清单；继续时沿用原任务，不重发目标、不重新讲解。暂停期间若机器人到达，先记录到达，继续后再开始该点介绍。异常已终止的目标等待需在继续时重试。
- 暂停/停止不是底盘急停：暂停控制应用音频和后续调度，当前协议没有底盘暂停命令；物理停止须在机器人端操作。

协议没有唯一命令 ID，因此重发完全相同点位时仍有旧消息无法区分的边界。详见 [机器人协议与异常处理](docs/robot-protocol.md)。

本地回归测试：`npm test`。只测巡游可运行 `node --test test/cruise-navigation.test.js test/cruise-websocket.test.js`；使用模拟机器人与 localhost WebSocket，不发送实体机器人命令。

---

## 过渡音频

机器人行进期间（TTS 播完到下一点到达之间）循环播放的背景音。

在控制面板「播报控制」页的「过渡音频」卡片配置：

| 参数 | 说明 |
|---|---|
| 启用 | 开关 |
| 类型 | TTS 或音频文件 |
| 共享素材池 | TTS 模式填文字；音频模式可添加多个文件，单曲循环或随机轮播 |

助播说话时过渡音频同步暂停，说完恢复。点位讲解准备好后才交接；TTS 自动交接等待当前句结束，丢弃过渡段落的剩余内容。停止巡游时立即停止。详见 [音频交接规则](docs/local-audio-handoff.md)。

手动播报测试仅在巡游停止后可用；暂停巡游仍保留任务，不能进行手动测试。

---

## Ducking（助播音量压制）

助播开麦时，TTS 和过渡音频自动暂停，停止说话后从原位继续播。
由前端麦克风检测驱动，在「实时监控」页的 Ducker 面板配置：

### 三个参数

| 参数 | 默认值 | 含义 |
|---|---|---|
| **静音阈值 (dB)** | -30 dB | 音量超过此值判定为助播在说话。越高越不灵敏（需要更大声才触发） |
| **判定时长 (s)** | 1.0 s | 助播停止后需安静多久才发 DUCK_END、恢复播放。越短恢复越快，但易受短暂停顿影响 |
| 触发帧数 | 1 帧 | 音量连续超阈值几帧才触发 DUCK_START（1 帧 ≈ 50 ms）。设为 1 响应最快；设高一些可避免爆音误触。 |

**三者联动效果：**
- 环境噪声大 → 适当调高阈值（如 -20 dB），避免误触
- 助播语速快、停顿多 → 适当调短判定时长（如 0.5 s）
- 开麦时有短暂爆音 → 适当调高触发帧数（如 3～5 帧），让短暂噪声不触发

点「保存」后立即生效并持久化，重启无需重设。

---

## 音频输出设备

在「系统设置 → 音频输出」选择所有播报声音的最终输出位置：

| 选项 | 行为 |
|---|---|
| **本地** | 通过本机 `ffplay` 播放 |
| **机器人端** | 转换为 16 kHz、单声道、S16_LE PCM，通过现有机器人 WebSocket 实时发送 |

此设置统一覆盖巡游 TTS、点位 MP3、弹幕 TTS/MP3、过渡音频和手动播报测试，并保存到可写数据目录的 `audio-output.json`。默认为本地，避免升级后意外改变已有现场行为。机器人端音量可在 **0–150%** 间调整；100% 保持原始 PCM，播放中调整会平滑生效且不会重启播报，本地播放音量不受影响。

机器人模式先完整准备每个 TTS 句子或音频文件的 PCM，再按 20 ms 分片（每片 640 PCM bytes）实时发送，不会一次性预发整段音频。准备与播放分离，保留助播 → 弹幕 → 点位讲解 → 过渡音频的优先级。机器人没有实际播放完成确认；句尾是发送端估计，现场须验证听感与停播响应。详见 [音频准备与诊断](docs/prepared-audio-diagnostics.md)。

---

## 环境变量（.env）

| 变量 | 说明 | 必填 |
|---|---|---|
| `DOUBAO_API_KEY` | 火山方舟 LLM Key | 要 LLM 必填 |
| `DOUBAO_MODEL` | 推理接入点 ID（ep- 开头） | 要 LLM 必填 |
| `DEEPSEEK_API_KEY` | DeepSeek 备用 Key | 可选 |
| `TTS_API_KEY` | 火山引擎 V3 TTS API Key | 要语音必填（或使用 App ID + Access Token） |
| `TTS_APP_ID` | 火山引擎 TTS App ID | 使用 App ID 鉴权时必填 |
| `TTS_ACCESS_TOKEN` | 火山引擎 TTS Access Token | 使用 App ID 鉴权时必填 |
| `TTS_VOICE_TYPE` | V3 兼容音色 ID | 要语音必填 |
| `TTS_RESOURCE_ID` | TTS 资源 ID；内置音色通常为 `seed-tts-1.0`，复刻音色为 `seed-icl-1.0` | 可选（可按 Cluster 推断） |
| `KB_PROVIDER` | `flatfile`（默认）或 `sqlite` | 可选 |
| `ROBOT_URL` | 客户端模式：连接机器人的完整 `ws://` / `wss://` 地址（保留目标端口和路径） | 可选 |
| `ROBOT_PORT` | 未填写 `ROBOT_URL` 时的本地监听端口（默认 8765），不是客户端目标端口 | 可选 |
| `LLM_TIMEOUT_MS` | 每个 LLM 请求超时（默认 8000 ms） | 可选 |
| `NGROK_AUTHTOKEN` | ngrok 内网穿透 Token | 可选 |

缺失的凭据不会导致崩溃，对应功能进入 log-only 模式。

### ngrok 内网穿透

当前版本的自动 ngrok 启动已停用。直接连接机器人使用 `ROBOT_URL`，不需要 ngrok；如自行把本地监听端口映射到 ngrok，客户端应使用 ngrok 提供的完整公网地址，不要自动追加本地端口。

---

## 数据目录

打包后，知识库、巡游清单等可写数据存储在：

```
~/Library/Application Support/robot-live-ui/data/   # macOS
%APPDATA%\robot-live-ui\data\                        # Windows
```

开发模式使用项目 `./data/`。安装包只携带经过允许清单筛选的干净初始数据：空巡游、关闭且为空的过渡音频、空知识库。首次启动只补充缺失的用户文件，不覆盖已有配置；开发者的录音、日志、缓存和凭据不进入安装包。

---

## 工作流程

```
开始巡游
  └─ 发 set_goal → 机器人导航
       └─ [行进中] 过渡音频循环播放
            └─ 到达点位 → KB 查询 → LLM 改写 → 准备首句音频
                 └─ 音频准备好 → 按句尾规则交接 → 点位播报
                      └─ [助播开麦] TTS / 过渡音频暂停，停麦后恢复
                           └─ 播报结束 → 过渡音频开始 → 发下一个 set_goal
                                └─ ... → 最后一个点播完 → 巡游完成
```
