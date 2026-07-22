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
  心跳字段: navigation.goal_status / task.goal_status: going → done

阶段 B — 对准 (Alignment)
  云台识别目标物体 (goal_object) → 对准
  心跳字段: task.object_status: going → done

两个状态同时为 done → 触发播报
```

`goal_object` 驱动的是阶段 B。它告诉机器人"到了之后看什么"，与底盘导航解耦。

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
task.goal_status === 'done' AND task.object_status === 'done'
```

触发时，从心跳中提取：
- `map.name` → 地图
- `task.path_file` → 路径名
- `task.goal_id` → 目标点 ID

三者组合查询知识库：`data/flatfiles/{map}/{path}/{goal_id}.json`

---

## 6. goal_object 在服务端的完整流向

```
巡游清单 item.goal_object
  ↓
robot.sendSetGoal({ path_name, goal_id, goal_object })   — 告知机器人对准目标
  ↓
机器人心跳 task.goal_object                               — 回声确认
  ↓
LLM 改写上下文                                            — 让模型知道当前画面中是什么物体
  ↓
TTS 播报（对 goal_object 感知的口播内容）
```

> **注意：** `goal_object` 不参与知识库查询。KB 查询键是 `(map, path, goal_id)`。`goal_object` 作为上下文传给 LLM，让改写更有针对性（如"镜头里是一辆车"）。

---

## 7. 知识库结构

```
data/flatfiles/
  {map_name}/
    {path_name}/
      {goal_id}.json      ← { "body": "...", "mp3_file": "...", "goal_object": "car" }
```

`goal_object` 在 KB 中是可选的描述性元数据，可用于 LLM 上下文补充。
