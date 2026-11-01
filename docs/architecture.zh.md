# dsh-summary-index 架构

## 1. 不冲突的挂载点

插件只声明：

~~~js
export const name = 'dsh-summary-index'
export const inject = ['tools']
~~~

它不实现 `ctx.compaction`，不注册压缩服务，不修改 agent preset 的 compaction row，
也不使用裸工具名。运行时只注册：

- `sumidx_search`
- `sumidx_read`
- `sumidx_probe`

并观察两个事件通道：

- `session/event`，过滤 `compaction/summary`；
- `agent/pre-step`，返回一次性索引/告警消息。

## 2. 一次压缩后的数据流

~~~text
compaction backend
  -> session/event('compaction/summary')
  -> read session.eventAt(seq) for every shadowedSeq
  -> normalize model-visible text, correlate tool calls/results
  -> parse five sections
  -> deterministic anchor extraction
  -> guard: sections + Anchors coverage + pointer validity + source caps
  -> run probes: pointer / index-search / event-read / source-range / replacement
  -> append JSONL entry to DSH_HOME/dsh-summary-index/v1
  -> on next agent/pre-step: inject one admitted or quarantine card
  -> tools query the index and read original events by seq
~~~

关键事实：`compaction/summary` 已经在后端提交。观察者不能回滚或否决它。因此守卫
拒绝的是索引准入（quarantine），不是压缩事务本身。被隔离的摘要不会被当作可信索引，
但仍会生成一张包含缺失 P0 rescue values 和 source seq 的告警卡。
## 3. 条目结构

每个 compaction 最多生成一个 `sumidx.entry/v1`：

~~~json
{
  "schema": "sumidx.entry/v1",
  "id": "sumidx:<compactionId>",
  "sessionId": "...",
  "compactionId": "...",
  "summarySeq": 120,
  "shadowedSeqs": [86, 88, 91],
  "summary": {
    "sections": {
      "goal": "...",
      "decisions": "...",
      "currentState": "...",
      "nextSteps": "...",
      "anchors": "..."
    },
    "present": { "goal": true, "decisions": true },
    "missing": []
  },
  "sectionPointers": { "decisions": [88, 91] },
  "anchors": [
    {
      "id": "a1",
      "kind": "path",
      "value": "src/index.mjs",
      "sourceSeq": 86,
      "sourceType": "assistant/message",
      "required": true,
      "inSummary": true,
      "inAnchorsSection": true
    }
  ],
  "validationFacts": [
    { "seq": 88, "toolName": "read_file", "outcome": "failed", "errorCode": "ENOENT" }
  ],
  "admission": {
    "status": "quarantined",
    "mode": "enforce",
    "reasonCodes": ["anchor-not-in-anchors-section"],
    "missingAnchors": []
  },
  "probes": {
    "total": 19,
    "passed": 18,
    "failed": 0,
    "pending": 1,
    "criticalFailed": 0
  }
}
~~~

摘要正文只保存预览；原始工具输出不进入索引。读取原文时使用条目的 seq 指针访问 live
session store。
## 4. 守卫与探针

守卫是纯函数，不调用模型：

1. 五段是否存在；
2. anchor 提取是否因 `maxAnchors` 截断；
3. 每个 required anchor 是否出现在摘要全文；
4. enforce 模式下是否出现在 `Anchors` 段；
5. 每个 anchor 的 `sourceSeq` 是否存在且原文精确包含字面量；
6. `shadowedSeqs` 是否完整可读；
7. 单事件/总源扫描是否触发采样或截断。

探针在此之上加入检索可达性：

- `pointer`：source seq 内容包含 anchor；
- `index-search`：searchEntries 能从字面量找回条目；
- `event-read`：原文读取可包含该字面量；
- `source-range`：所有 shadowed seq 仍可读；
- `replacement-pointer`：summary 后紧邻的 replacement 覆盖记录的 range。

`replacement-pointer` 在 `compaction/summary` 刚提交时可能为 pending，因为 DSH 会在此后
追加 replacement。它不影响首次准入；`sumidx_probe action=run` 会在之后重新检查。

## 5. 并发与故障策略

- 写入按 session 串行化，JSONL 每条一次 write + fsync；
- append-only 避免读改写竞争；
- 损坏行忽略并计数，不丢弃其余有效条目；
- store 读取有字节窗口上限，超过时只加载尾部窗口并告警；
- 索引失败不影响压缩或 step：观察者只记录 warning，pre-step 注入失败原样返回 decision；
- 工具注册冲突由 DSH 直接报错，不静默覆盖。

## 6. 与其它压缩插件

兼容性边界是标准 `compaction/summary` 事件，而不是某个插件的内部 API。插件不调用
`history_*`，也不需要修改 context-zip 或 minimal-context 的任何配置。若未来 event
payload 改变，只有 `normalizeSourceEvents`、`buildIndexEntry` 和探针适配层需要更新。
