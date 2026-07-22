# 机器人巡游直播讲解系统

工作人员在控制面板配置巡游清单，系统按顺序指挥机器人前往每个点位，到达后自动查询知识库、LLM 改写、TTS 播报，播完自动前往下一个点。支持过渡音频（行进期间循环播放）和助播 Ducking（助播开麦时 TTS 自动暂停）。

---

## 快速开始

### 开发模式

```bash
# 后端（根目录）
npm install
npm start

# 前端（另开终端）
cd robot-ui
npm install
npm run dev

# 模拟机器人（另开终端，用于测试）
npm run mock-robot
```

### 打包安装包

```bash
cd robot-ui
npm install
npm run package   # 产出 dist/ 下的 .dmg / .exe / .AppImage
```

---

## 项目结构

```
robot-live-system/
├── src/
│   ├── index.js               # 后端主入口
│   ├── robot/listener.js      # 机器人 WebSocket（port 8765）
│   ├── task/manager.js        # 巡游清单驱动
│   ├── knowledge/             # 知识库（flatfile / sqlite）
│   ├── llm/                   # LLM 改写（豆包主 + DeepSeek 备）
│   ├── tts/                   # TTS 合成 + AudioPlayer
│   ├── transit/manager.js     # 过渡音频管理
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

---

## 过渡音频

机器人行进期间（TTS 播完到下一点到达之间）循环播放的背景音。

在控制面板「系统设置 → 过渡音频」配置：

| 参数 | 说明 |
|---|---|
| 启用 | 开关 |
| 类型 | TTS（LLM 改写一次后缓存循环）或 MP3（直接循环文件） |
| 文字 / 文件 | TTS 模式填文字，MP3 模式填文件路径 |

助播说话时过渡音频同步暂停，说完恢复。停止巡游时立即停止。

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

## 环境变量（.env）

| 变量 | 说明 | 必填 |
|---|---|---|
| `DOUBAO_API_KEY` | 火山方舟 LLM Key | 要 LLM 必填 |
| `DOUBAO_MODEL` | 推理接入点 ID（ep- 开头） | 要 LLM 必填 |
| `DEEPSEEK_API_KEY` | DeepSeek 备用 Key | 可选 |
| `TTS_APP_ID` | 火山引擎 TTS App ID | 要语音必填 |
| `TTS_ACCESS_TOKEN` | 火山引擎 TTS Token | 要语音必填 |
| `TTS_VOICE_TYPE` | 音色 ID（默认 `BV001_streaming`） | 可选 |
| `KB_PROVIDER` | `flatfile`（默认）或 `sqlite` | 可选 |
| `ROBOT_PORT` | 机器人 WebSocket 端口（默认 8765） | 可选 |
| `LLM_TIMEOUT_MS` | 每个 LLM 请求超时（默认 8000 ms） | 可选 |
| `NGROK_AUTHTOKEN` | ngrok 内网穿透 Token | 可选 |

缺失的凭据不会导致崩溃，对应功能进入 log-only 模式。

### ngrok 内网穿透

填写 `NGROK_AUTHTOKEN` 后，系统启动时自动建立 ngrok 隧道，将机器人 WebSocket 端口暴露到公网。隧道地址显示在控制面板顶部。无需重启，修改后在「系统设置」保存即可重新生效。

---

## 数据目录

打包后，知识库、巡游清单等可写数据存储在：

```
~/Library/Application Support/robot-live-ui/data/   # macOS
%APPDATA%\robot-live-ui\data\                        # Windows
```

项目 `./data/` 仅用于首次启动时初始化，之后通过控制面板操作数据。

---

## 工作流程

```
开始巡游
  └─ 发 set_goal → 机器人导航
       └─ [行进中] 过渡音频循环播放
            └─ 到达点位 → 停止过渡音频
                 └─ KB 查询 → LLM 改写 → TTS 播报
                      └─ [助播开麦] TTS / 过渡音频暂停，停麦后恢复
                           └─ 播报结束 → 过渡音频开始 → 发下一个 set_goal
                                └─ ... → 最后一个点播完 → 巡游完成
```
