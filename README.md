# dsh-summary-index

[![CI](https://github.com/TLNing260310/dsh-summary-index/actions/workflows/ci.yml/badge.svg)](https://github.com/TLNing260310/dsh-summary-index/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/TLNing260310/dsh-summary-index?include_prereleases)](https://github.com/TLNing260310/dsh-summary-index/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 给 DSH 的压缩摘要加一层**确定性锚点、可寻址指针与探针评估**，但不接管压缩后端。

`dsh-summary-index` 是一个宿主侧 DSH 插件。它不实现 `ctx.compaction`，不替换
`dsh-context-zip`、`dsh-minimal-context` 或任何压缩后端，也不注册裸的
`search` / `read` 工具。它只做四件事：

1. 观察已提交的标准 `compaction/summary` 会话事件；
2. 从被遮蔽的原始事件中确定性地提取 P0 字面量，并生成带事件号指针的结构化存根；
3. 用确定性守卫和探针检查五段式、Anchors 覆盖、指针可达性和原文可读性；
4. 提供只读工具 `sumidx_search` / `sumidx_read` / `sumidx_probe`，并在下一次
   pre-step 注入一张紧凑的索引卡或隔离告警卡。

## AI Demo 声明

> 这是一个由 AI 辅助完成、用于验证插件机制的 alpha/demo 项目，不是生产级安全组件，
> 也不应作为唯一的数据完整性保障。它已经做了故障隔离和测试，但仍可能存在未知的使用
> bug、DSH 版本兼容问题和边界行为。

- 欢迎提交 issue 报告崩溃、漏索引、误隔离、上下文压缩后工具调用失败等问题；
- 欢迎提交 PR 修复 bug、补充测试、增加 DSH 版本适配或改进探针；
- 提交日志前请移除凭据、完整会话原文和其它敏感数据。

**状态：可运行实现 + 纯函数测试 + DSH 0.2.1 工具注册集成测试。**


开发环境验证：DSH API 包 `0.2.1-rc.2`、Node `24.21.0`。代码只使用标准
`session/event`、`agent/pre-step`、`defineTool` 和 `createUserMessage` API；peer
范围覆盖 0.1.5 到 0.2.x，并同时支持 session format v3/v4 的 producer source。

详细审计记录见 [docs/audit-2026-11-01.zh.md](docs/audit-2026-11-01.zh.md)。

---

## 借鉴思路与本插件实现

本项目借鉴的是公开的设计思路，不包含这些项目的代码。具体落地由本插件独立实现：

| 来源/思路 | 借鉴点 | 本插件实际实现 |
|---|---|---|
| Factory 的 probe evaluation 讨论 | 不用摘要相似度，改测摘要能否支撑任务 | 确定性 pointer/index-search/event-read/source-range/replacement 探针 + recall 问题包 |
| TracSum 的可溯源摘要讨论 | 摘要需要能回到来源 | 每个 P0 anchor 带 DSH 原生 sourceSeq；五段式带 section source pointers；不声称做语义蕴含 |
| dsh-context-zip 的五段式/history 实践 | 最小交接骨架与按段/事件回查 | 标准 compaction/summary 观察器 + DSH session event seq 原生寻址 |
| dsh-minimal-context 的阈值思路 | 小片段不值得建索引 | 把阈值实现为索引准入参数，不伪装成压缩触发参数 |
| dsh-argp 的确定性守卫哲学 | LLM 提议，代码裁定 | 代码提取 P0 anchor，缺失或断指针则 quarantine |
| dsh-ctxopt-compaction 的诊断保留 | 长工具输出不能只保头尾 | head/middle/tail 采样；一旦采样就显式 quarantine |
| DSH 官方 API | 插件、工具、会话、配置机制 | Schemastery Config、defineTool、session/event、agent/pre-step、session native seq |

---

## 插件机制

包入口导出：

~~~js
export const name = 'dsh-summary-index'
export const inject = ['tools']
export const Config = z.object({ /* Schemastery */ })
export function apply(ctx, config) { /* ... */ }
~~~

- `inject: ['tools']` 让 Cordis 只等待工具服务；没有隐藏的 service 注入。
- `Config` 由 DSH loader 校验，默认值与运行时 `normalizeConfig` 保持一致。
- `package.json.dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh plugin add` 会根据
  已安装 manifest 自动把包加入 `dsh.profile.bundles`。
- 不注册 `ctx.compaction`，不插入或替换任何 agent preset 的 compaction row。
- 当前测试针对 `@deepseek-ai/dsh-*@0.2.1-rc.2` 和 Node 24 执行。
- `inject: false` 可关闭 pre-step 索引卡，只保留工具化召回。

---

## 先读：非接管式守卫的边界

DSH 的 `compaction/summary` 是**已提交事件**，`session/event` 是 fire-and-forget
观察通道，不能回滚、否决或修改这次压缩。因此锚点缺失就拒绝提交存根，在本插件中
被实现为：

- **拒绝该存根进入可信索引（quarantine）**；
- 保存完整的确定性命中/缺失诊断；
- 在下一次 pre-step 注入隔离告警和 P0 salvage anchors；
- 让模型知道摘要不完整，必须通过 `sumidx_read` 回查原始事件。

这不会假装压缩没有发生。若必须让压缩后端在提交前失败，只能替换或包装压缩后端，
那会违背本插件不接管压缩链路的目标。

---

## 设计要点

### 1. 分层共存，而不是抢压缩服务

| 已有层 | 本插件的做法 |
|---|---|
| 压缩后端（context-zip / minimal-context 等） | 不注册 `compaction`、不替换 `summarize()`，仅监听标准 `compaction/summary` |
| DSH session log | 不直接 `session.append()`；只通过 `agent/pre-step` 返回一次性索引消息 |
| 工具命名空间 | 只注册 `sumidx_*`，不注册裸的 `search` / `read` |
| 事件通道 | `session/event` 只读观察；`agent/pre-step` 只做有界注入 |
| HTTP / UI | 不注册路由或客户端模块 |
| 存储 | 独立 append-only JSONL：`DSH_HOME/dsh-summary-index/v1/sessions/...` |

`dsh-plugin.naming.json` 声明坐标、包名、Loader ID、工具名、事件通道、HTTP 路由
和冲突策略，便于发布前交给 DSH 冲突治理工具检查。当前 `registryOwner` 使用本地值
`local`；发布到社区 registry 前请改为实际的 registry owner 和 coordinate。

### 2. 五段式骨架 + 锚点守卫

插件解析五段，支持英文、中文和常见 Markdown 装饰：

- Goal and intent / 目标与意图
- Decisions / 关键决策
- Current state / 当前状态
- Next steps / 下一步
- Anchors / 锚点

同时由代码从原始事件中提取高信号字面量：

- UUID、邮箱、完整/上下文提交号、工单号；
- URL、IPv4/IPv6、host:port；
- 绝对/相对路径、带扩展名文件；
- 错误码（`ENOENT`、`E11000`、`HTTP 500`、`TOOL_NOT_STARTED` 等）；
- CLI 参数、环境变量/蛇形大写键、点分配置键；
- 版本号、函数/符号名、反引号内的原子字面量。

每个锚点都带 `value`、`kind`、`sourceSeq`、`sourceType` 和 `required`。sourceSeq
就是 DSH 原生 session event 序号，不依赖任何其他压缩插件的私有段号。
### 3. 以探针而非相似度评判

本插件不计算 ROUGE、BLEU 或摘要相似度。每次压缩后运行确定性探针：

- `pointer`：锚点 sourceSeq 是否存在，且原文仍包含精确字面量；
- `index-search`：`sumidx_search` 能否从字面量找回所属条目；
- `event-read`：`sumidx_read` 能否从 seq 找到可读原文；
- `source-range`：所有 `shadowedSeqs` 是否仍可读；
- `replacement-pointer`：摘要后的 replacement 是否覆盖记录的遮蔽范围。

`sumidx_probe action=questions` 还会生成可重复的模型级 recall 问题包。问题包不会
自动调用模型；确定性探针负责准入，问题包负责后续 harness 评估。

### 4. 显式 P0–P3 留存

| 级别 | 实现 |
|---|---|
| P0 | 决策/约束进入五段式；标识符、路径、错误码、网络值、验证状态进入 anchors 与 validation facts |
| P1 | 五段式存根 + section source pointers + 每条 anchor 的 source seq |
| P2 | 不复制原始工具输出；仅保留通过/失败、错误码和诊断 snippet |
| P3 | 不持久化；重复草稿和已覆盖探索路径被忽略 |

### 5. 小压缩不建索引

`summarizeMinChars` 和 `summarizeMinNodes` 是索引准入阈值，不是压缩触发阈值。
本插件不拥有压缩后端，无法决定何时压缩；过小的分片不会产生索引条目。默认分别为
512 字符和 2 个源事件。
---

## 工具

### `sumidx_search`

在当前会话的摘要索引中做本地词法检索，默认只返回 admitted 条目。

~~~text
sumidx_search query="ENOENT" status=all limit=8
~~~

返回条目 id、准入状态、摘要 seq、匹配锚点及 `sourceSeq`。它不搜索原始历史；
原始历史使用 `sumidx_read action=search`。

### `sumidx_read`

只读读取，不会重新执行任何工具。

~~~text
sumidx_read action=entry entry_id="sumidx:<id>"
sumidx_read action=search entry_id="sumidx:<id>" query="550e8400"
sumidx_read action=event entry_id="sumidx:<id>" seq=42 offset=0 limit=12000
~~~

`action=event` 只允许读取该条目 `shadowedSeqs` 或 `summarySeq` 中的 seq，避免绕过
索引边界读取会话任意位置。

### `sumidx_probe`

~~~text
sumidx_probe action=status
sumidx_probe action=run entry_id="sumidx:<id>" limit=24
sumidx_probe action=questions entry_id="sumidx:<id>" limit=12
~~~

`status` 展示条目和探针概况；`run` 重新运行确定性可达性探针；`questions` 生成
模型级 recall 问题包。
---

## 准入模式

| guardMode | 行为 |
|---|---|
| `enforce`（默认） | 五段必须完整；所有确定性 P0 字面量必须出现在 Anchors 段；源指针可解析；源扫描不得截断 |
| `compat` | 五段缺失只警告；P0 字面量允许出现在摘要任意位置；缺字面量、断指针、源截断仍隔离 |
| `observe` | 只生成诊断，全部 admitted；不建议用于高可靠自动化 |

隔离原因码包括 `summary-empty`、`shadowed-seqs-missing`、`source-events-missing`、
`source-scan-truncated`、`anchor-extraction-truncated`、`anchor-not-in-summary`、
`anchor-not-in-anchors-section`、`anchor-pointer-unresolvable`、
`five-section-incomplete` 和 `probe-failed`。

被隔离的条目仍保留在 append-only 审计存储中，可通过
`sumidx_search status=all` 或 `sumidx_probe action=status` 查看。
---

## 配置

| 键 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | true | 总开关 |
| `guardMode` | enforce | enforce / compat / observe |
| `inject` | true | 是否在 pre-step 注入一次性索引卡；false 时完全工具化 |
| `injectMaxChars` | 1800 | 注入卡字符上限 |
| `injectMaxAnchors` | 14 | 注入卡 anchor 上限 |
| `summarizeMinChars` | 512 | 索引准入最小源字符数 |
| `summarizeMinNodes` | 2 | 索引准入最小 shadowed surface 事件数 |
| `maxAnchors` | 256 | P0 anchor 上限；超出时隔离 |
| `maxEventChars` | 500000 | 单事件扫描上限；超出时采样并隔离 |
| `maxTotalSourceChars` | 12000000 | 源范围扫描上限；超出时隔离 |
| `maxSectionChars` | 4000 | 每段持久化预览上限 |
| `probeLimit` | 24 | 存档探针采样 anchor 数 |
| `backfillLimit` | 8 | 新装后回填最近压缩数 |
| `maxReadChars` | 12000 | 单次读取窗口上限 |
| `maxSearchResults` | 12 | 搜索结果上限 |
| `maxTrackedSessions` | 256 | 内存中保留的活跃 session 状态上限 |
| `maxStoreReadBytes` | 67108864 | 启动读取 JSONL 窗口上限 |
| `maxEntryBytes` | 2097152 | 单条索引记录上限 |
| `indexRoot` | `DSH_HOME/dsh-summary-index/v1` | 自定义存储根；相对路径按 DSH_HOME 解析 |
示例配置：

~~~yaml
- insert:
    - id: summary-index
      name: 'dsh-summary-index'
      config:
        enabled: true
        guardMode: enforce
        inject: true
        summarizeMinChars: 512
        summarizeMinNodes: 2
        injectMaxChars: 1800
        probeLimit: 24
~~~

---

## 安装与启用

本包声明了 `dsh.bundle.patch`，因此用 DSH 插件 CLI 安装时，CLI 会自动把包加入
`dsh.profile.bundles` 并应用 `cordis.patch.yml`，不需要手工改 agent preset。

### 方式 A：从 npm registry 安装并注册

npmjs 发布后，推荐一条命令完成下载和注册：

```powershell
dsh plugin --profile <profile> add dsh-summary-index
```

> 当前首先可用的是下面的 GitHub Release / GitHub spec 方式。npmjs 首次发布需要维护者
> 的 npm 登录或仓库 `NPM_TOKEN` secret；`package.json` 和 publish workflow 已准备好。

### 方式 B：从 GitHub Release tarball 安装并注册

```powershell
dsh plugin --profile <profile> add `
  https://github.com/TLNing260310/dsh-summary-index/releases/download/v0.1.0/dsh-summary-index-0.1.0.tgz
```

### 方式 C：从 GitHub 仓库 spec 安装并注册

```powershell
dsh plugin --profile <profile> add github:TLNing260310/dsh-summary-index
```

### 方式 D：本地开发 tarball

```powershell
dsh plugin --profile <profile> add `
  file:D:/AI_work_project/dsh-summary-index/dist/dsh-summary-index-0.1.0.tgz
```

`dsh plugin` 实际在 profile 目录调用 pnpm，并按安装后的 manifest 自动 reconcile
bundle 列表；当前包同时带有 `dsh.bundle.patch` 和 `cordis.patch.yml`，所以会插入：

```yaml
- insert:
    - id: summary-index
      name: 'dsh-summary-index'
```

### 直接用 npm 下载

npm 可以直接从 GitHub Release 下载本包，无需等待 npm registry 发布：

```powershell
npm install --global github:TLNing260310/dsh-summary-index
# 或
npm install --global `
  https://github.com/TLNing260310/dsh-summary-index/releases/download/v0.1.0/dsh-summary-index-0.1.0.tgz
```

`npm install` 只负责下载；DSH profile 注册仍建议使用：

```powershell
dsh plugin --profile <profile> add github:TLNing260310/dsh-summary-index
```

npmjs 发布后，也可以直接 `npm install --global dsh-summary-index`。对于
Electron 管理的 `desktop` profile，请使用 DSH Desktop 的插件管理器界面。

### 验证、升级与卸载

```powershell
dsh --profile <profile> --dump-config
dsh plugin --profile <profile> update dsh-summary-index
dsh plugin --profile <profile> remove dsh-summary-index
```

安装后重启 DSH 会话。运行中的旧会话不会被追溯注入；最近压缩可通过
`backfillLimit` 回填。插件只安装 observer 和三个只读工具，不修改 DSH 自身代码，
不插入或替换任何 compaction backend。

## 存储与隐私

- 默认路径：`$DSH_HOME/dsh-summary-index/v1/sessions/<hashed-session>/entries.jsonl`；
- 目录按 0700、文件按 0600 创建（Windows 上为尽力而为）；
- JSONL 只追加，检索工具只读；写入由进程内每会话队列串行化并 fsync；
- 会话 id 经 SHA-256 和文件名清洗，防止路径穿越；
- 索引保存摘要段、anchor、source seq、validation snippet，不复制整段工具输出；
- 明显 token / JWT / 私钥 / 密码式键值在索引 snippet 和注入卡中替换为 [REDACTED]；
- `sumidx_read action=event` 读取会话原本已记录的事件，可能含敏感内容，仅应在可信
  会话中使用。

---

## 与其他压缩插件共存

- 只消费标准 `compaction/summary`；任何发出该事件的压缩后端都可共存。
- 不调用 `dsh-context-zip` 的 `history_*` 工具，也不依赖 `dsh-minimal-context` 的
  私有配置；指针直接使用 DSH 原生 session event seq。
- 如果某个压缩插件没有提交标准 `compaction/summary`，本插件不会看到它。
- 如果事件缺少 `shadowedSeqs`，条目会被隔离为 `shadowed-seqs-missing`，绝不伪造指针。

---

## 已知限制

1. 不能回滚已提交压缩。隔离是索引准入层的拒绝，不是后端事务回滚。
2. 原文读取依赖 live session store。进程重启后若 raw session 未加载，
   `sumidx_read action=event` 会提示不可用；索引中的 seq 仍作为指针保留。
3. 精确匹配大小写敏感。模型把 `ENOENT` 改写成 `enoent` 会被判为缺失，这是为了
   不悄悄接受标识符变形。
4. anchor 提取是规则型的，可能漏取或过取；诊断会报告提取数、截断和敏感值抑制数。
5. 模型级探针不自动执行；确定性探针负责准入，问题包需要 harness 或人工执行。
6. `sumidx_search` 不跨会话；只搜索当前 agent session 的索引。
7. `observe` 模式只记录，不隔离，不适合自动化安全边界。

## 开发与测试

~~~bash
npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run
~~~

测试覆盖五段式中英文解析、确定性 anchor 提取、tool-call/result 关联、enforce /
compat 准入、截断与指针探针、JSONL 并发写入、损坏行容忍、路径穿越防护、真实
defineTool 注册、session/event 观察、pre-step 单次注入、malformed compaction、索引
目录不可用时的内存降级、session 淘汰后重载，以及三个只读工具。

当前测试针对 DSH API 包 `0.2.1-rc.2` 执行。完整审计记录见
[docs/audit-2026-11-01.zh.md](docs/audit-2026-11-01.zh.md)；提交问题请使用
[GitHub Issues](https://github.com/TLNing260310/dsh-summary-index/issues)，安全敏感
内容请使用 private security advisory。

## 参与贡献

这是一个 AI 辅助完成的 demo，非常欢迎真实用户报告使用问题和提交 PR：

- Bug / 兼容性 / 安装问题：[GitHub Issues](https://github.com/TLNing260310/dsh-summary-index/issues)
- 设计讨论：[GitHub Discussions](https://github.com/TLNing260310/dsh-summary-index/discussions)
- 贡献流程：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全敏感报告：请使用 GitHub private security advisory，不要在公开 issue 中放凭据或完整会话原文。

提交前请附上 DSH 版本、插件版本、安装方式、压缩后端、复现步骤和经过脱敏的
`sumidx_probe action=status` 输出。欢迎在 PR 中补充测试、版本适配和探针改进。

## License

MIT
