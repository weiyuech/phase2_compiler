# 机器人通信协议与寻址模型

## 1. 核心概念：基于索引的航点寻址

系统采用三层寻址结构，本质是"查表"操作：

```
Map (地图)
  └── Path (路径文件)
        └── Goal_id (目标点索引)
              └── Goal_object (到达后的云台动作)
```

| 层级 | 本质 | 说明 |
|---|---|---|
| **Map** | 全局坐标系 | 场地标识，决定使用哪套坐标系 |
| **Path** | 目标点数据库 | 该地图下的 CSV 文件，每行存一个坐标点 `(x, y, θ)` |
| **Goal_id** | CSV 行号/索引 | 查表取出对应坐标，底盘导航至该位置 |
| **Goal_object** | 云台对准指令 | 到达坐标后，云台识别并对准的目标物体（COCO 类名） |

> **Path 不是连续轨迹**。它是一个离散的"目标点清单"。可以直接命令机器人去 `goal_id: 3`，无需先经过 1 和 2。业务上按顺序执行是服务端逻辑，不是机器人的内置约束。

---

## 2. 每个航点的两段式执行

到达一个目标点是两个串行阶段：

```
阶段 A — 导航 (Navigation)
  底盘规划路径 → 移动到 (x, y, θ)
  心跳字段: task.goal_status: going → done（可能直接收到 done）

阶段 B — 对准 (Alignment)
  云台识别目标物体 (goal_object) → 对准
  心跳字段: task.object_status: going → done

阶段 A 导航到达 → 触发播报，不等待阶段 B
```

`goal_object` 驱动的是阶段 B。它告诉机器人"到了之后看什么"，与底盘导航解耦。

**业务规则更新（2026-08-31）：** 导航到达就播报。对准状态 `going`、`done`、`failed` / `faild`，或未提供，均不阻止播报。导航失败不等于到达。

---

## 3. 服务端→机器人指令

### 3.1 获取地图列表
```json
{ "get_map_list": "all" }
```
**回复:**
```json
{ "robot_map_list": ["map1", "map2"] }
```

### 3.2 切换地图
```json
{ "set_switch_map": "map1" }
```
**回复:**
```json
{ "robot_switch_map": "true" }
```
`"false"` 表示该地图不存在。

### 3.3 获取路径列表
```json
{ "get_path_list": "map1" }
```
**回复:**
```json
{ "robot_path_list": ["path1", "path2"] }
```

### 3.4 发布目标点
```json
{
  "set_goal": {
    "path_name":   "path1",
    "goal_id":     3,
    "goal_object": "car"
  }
}
```
**回复:**
```json
{
  "robot_goal": {
    "path_file":   "path1",
    "goal_id":     3,
    "goal_object": "car",
    "goal_check":  "true"
  }
}
```
`goal_check: "false"` 表示该 path/goal_id 组合不存在于机器人本地文件。

`set_goal` **没有地图字段**。应用先核对清单地图、操作员选择的地图，以及机器人最近 10 秒内的 `map.name/status` 心跳；必须同图且为 `ready` 才发送。跨地图清单会在开始前被拒绝，应用不会自动切换地图。地图切换仍由操作员手动完成，且必须先停止巡游。

---

## 4. 机器人心跳（1 Hz）

```json
{
  "system": {
    "status":  "ready",
    "battery": 85
  },
  "map": {
    "mode":   "localization",
    "name":   "map1",
    "status": "ready"
  },
  "navigation": {
    "status":      "ready",
    "goal_status": "going"
  },
  "task": {
    "path_file":        "path1",
    "goal_id":          3,
    "goal_object":      "car",
    "goal_status":      "going",
    "object_status":    "going",
    "task_remain_time": 12
  }
}
```

### 字段枚举值

| 字段 | 枚举值 | 说明 |
|---|---|---|
| `system.status` | `ready` / `error` | 硬件状态 |
| `system.battery` | 0–100 | 电量百分比 |
| `map.mode` | `localization` / `mapping` | 定位模式 / 建图模式 |
| `map.status` | `ready` / `preparing` / `failed` | 定位状态 |
| `navigation.goal_status` | `going` / `done` / `failed` | 底盘导航状态 |
| `task.goal_status` | `going` / `done` / `failed` | 同上（任务层） |
| `task.object_status` | `going` / `done` / `failed` | 云台对准状态 |
| `task.task_remain_time` | number (秒) | 预计剩余时间 |

---

## 5. 播报触发条件

```
有正在等待的目标点
  → 收到匹配 path_file / goal_id / goal_object 的 robot_goal，goal_check 为 true
  → 随后收到匹配地图 / 路径 / 点位 ID 的心跳，且地图 ready
  → task.goal_status === 'done'
  → 只播报一次；object_status 不作为门槛
```

不要求先看到 `going`：机器人快速到达，或开始时已在点位，也能接受确认之后的 `done`。确认之前的 `done` 不缓存为本次到达；等待下一条匹配心跳。收到其他点位的旧回复/心跳只忽略，绝不把旧点位的状态改成当前点位。

触发时，从匹配的心跳中提取：

- `map.name` → 地图
- `task.path_file` → 路径名
- `task.goal_id` → 目标点 ID

三者组合查询知识库，优先 `{goal_id}-{goal_object}.json`（如果有指定物体），再回退到 `{goal_id}.json`。

### 异常与取消

- 目标确认超时（默认 5 秒）、到达超时（确认后默认 180 秒）、目标不存在或地图变化/未就绪：暂停巡游并显示错误，不播报、不自动发下一个点。超时时长可在 `RobotListener` 构造参数中调整。
- 匹配目标的 `task.goal_status` 为 `failed` / `faild`：提示导航失败，跳过该点介绍，继续下一个点。
- 跳过/删除当前点：只放弃该点的旧确认/到达处理及未完成的介绍，转向下一个点；其后的巡游清单保留。已在播放或合成的过渡音频继续，不停止后重新开始。
- UI 删除以“提交巡游清单”为生效时刻。删除当前点后选择它原来后面的首个仍保留点，不回到列表开头。若当前已在点 3，删除旧点 2 不取消点 3 的目标、介绍或过渡音频。
- 暂停：音频暂停，当前任务与音频位置保留；继续时恢复原任务，不重新发送目标或重播整段。若暂停期间收到到达，先记录到达，继续后再介绍；当前介绍若恰好结束，也要等继续后才发下一点。助播/弹幕结束不会解除手动暂停。
- 停止或断线：停止本端巡游和音频，旧回调不能推进另一次巡游。异常已结束的目标等待（如超时）与普通暂停不同，继续时会重新请求当前点。
- **暂停/停止不是机器人急停。** 当前协议未提供底盘暂停/停止命令；暂停期间机器人可能继续移动，需要停止底盘时使用机器人端控制。

### 协议边界

当前消息没有唯一命令 ID。若连续重发**完全相同的目标**，延迟的旧确认和旧 `done` 仍可能与新任务无法区分；仅靠本端无法彻底解决。严格消除该歧义需要双方扩展协议，让 `set_goal`、确认和心跳回传同一个唯一 ID。当前应用未擅自增加机器人不支持的字段。

本地回归：`node --test test/cruise-navigation.test.js test/cruise-websocket.test.js`。包含真实 localhost WebSocket 收发，但不连接实体机器人，也不调用 LLM/TTS。硬件验收仍需核对实际固件是否按约定回传目标字段。

---

## 6. goal_object 在服务端的完整流向

```
巡游清单 item.goal_object
  ↓
robot.sendSetGoal(item)                               — 地图本地校验后发 set_goal
  ↓
robot_goal.goal_object                               — 指令回声确认，不代表对准成功
  ↓
LLM 改写上下文                                        — 提供期望对准的物体上下文
  ↓
TTS 播报（对 goal_object 感知的口播内容）
```

> **注意：** `goal_object` 可选择物体专属知识库条目，并作为上下文传给 LLM；它只是预期目标，不保证云台已经对准。不要把“导航到达”理解成“物体识别成功”。

---

## 7. 知识库结构

```
data/flatfiles/
  {map_name}/
    {path_name}/
      {goal_id}.json               ← 通用条目
      {goal_id}-{goal_object}.json ← 可选的物体专属条目
```

条目包含 `body` 等讲解内容；`goal_object` 为可选物体上下文。

---

## 8. 服务器→机器人音频

音频与导航指令复用同一条机器人 WebSocket，不建立第二条连接。音频方向为服务器到机器人扬声器；机器人到服务器仍只传心跳、状态和指令回复。

```json
{
  "audio": {
    "type": "pcm",
    "sample": "16",
    "seq": 1,
    "data": "<base64-encoded PCM bytes>"
  }
}
```

固定格式：

| 参数 | 值 |
|---|---|
| 采样率 | 16,000 Hz（协议字段为字符串 `"16"`） |
| 声道 | 单声道 |
| 样本格式 | signed 16-bit little-endian（S16_LE） |
| 分片时长 | 20 ms |
| 每片原始大小 | 640 bytes（最后一片可以更短） |
| 发送节奏 | 每 20 ms 一片，按实时速度发送 |

`seq` 在每个新播报会话中从 1 递增，同一段 TTS 的相邻句子共用连续序号；被弹幕打断后保留原播报序号。不同来源保持各自会话约定。

MP3 文件或单句 TTS 在本端完整解码后才允许播放，但不会提前发送完整音频。发送采用单调时钟和单层定时循环，音频帧禁用可选的逐消息压缩，仍复用原来的 WebSocket 与 JSON 格式。暂停/停止不会添加未经定义的机器人清空命令。

句末按已发送 PCM 时长估算（包含延迟末包的时长）；发送回调仅代表本地写入完成，不代表机器人已播完。若录制发现句尾被截断或旧声音跨场景，必须调查机器人缓冲行为后再发布，不能靠猜测延迟掩盖问题。详情见 [准备式音频与诊断](prepared-audio-diagnostics.md)。
