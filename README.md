# Normify for Codex

[English](README_EN.md) | 简体中文

版本：0.6.0。
本仓库直接支持Codex。
无需独立适配仓库或DSH宿主。

Normify让架构随源码演进。
AI分析模块与接口。
本地引擎校验、编译和渲染。
用户逐层查看交互架构图。

- 31个本地MCP工具。
- 架构生成与伴随开发技能。
- 架构规则与源码漂移检测。
- 计划态、激活与变更收尾。
- 双语说明、API直连与多树。
- 单文件HTML交互架构图。

## 一键安装

先安装Node.js 22及以上。
Node安装包需包含npm。
还需安装本地Codex CLI。
安装器会自动查找CLI。
本次验证CLI版本0.146.0。

获取本仓库：

```powershell
git clone https://github.com/RaraAlu/dsh-normify.git
cd dsh-normify
```

### Windows

双击根目录的 `install.cmd`。
也可执行以下命令：

```powershell
.\install.ps1
```

### macOS与Linux

```sh
sh install.sh
```

安装器依次完成：

1. 检查Node、npm与Codex。
2. 按锁文件安装依赖。
3. 编译引擎并检查工具契约。
4. 握手验证31个MCP工具。
5. 备份配置与已有托管技能。
6. 注册MCP并安装两个技能。
7. 记录安装回执。

安装后开启新的Codex会话。
安装器不会修改无关MCP。
它拒绝覆盖未托管技能。
它拒绝覆盖用户修改的技能。
它保留用户停用的服务。
注册失败时回滚配置与技能。
备份位于配置目录的：
`backups/normify-codex/`。

### 迁移旧适配层

先检查旧技能有无用户修改。
确认后执行迁移命令：

```powershell
.\install.ps1 --migrate
```

macOS与Linux使用：

```sh
sh install.sh --migrate
```

迁移只接受完整的托管安装。
它保留原有架构存储根。
它不会迁移或信任提醒钩子。
移动仓库后也需重新迁移。
请保留此仓库与Node安装路径。
MCP使用绝对路径启动。

### 自定义路径

```powershell
.\install.ps1 --codex-executable "C:\tools\codex.exe" --codex-home "D:\codex" --skills-root "C:\Users\me\.agents\skills" --storage-root "D:\architecture"
```

也可设置 `CODEX_CLI_PATH`。
配置根默认使用 `CODEX_HOME`。
未设置时使用 `~/.codex/`。
结构数据默认放在配置根下：
`normify/normify-<项目名>/`。
技能默认放在 `~/.agents/skills/`。
自定义技能根只改变复制位置。
Codex仍需自行发现该目录。

已装依赖时可直接注册：

```powershell
npm run install:codex
npm run verify:codex
```

验证命令检查Codex实际发现。
它检查技能与31个工具。
它不会调用云端模型。
它不修改无关服务配置。
报告保存在 `reports/`。
可用 `--output` 指定报告。

## 在Codex中使用

MCP服务名：`normify`。

生成架构时使用技能：

```text
用 $normify-gen 整理当前仓库架构。
只读源码，校验后生成交互图。
```

伴随开发时使用技能：

```text
用 $normify-dev 管理本次开发。
先检查架构规则，再实现和收尾。
```

源码证据需传绝对 `repoRoot`。
用 `project` 选择存储项目。
也可用绝对 `dir` 指定数据目录。
该目录名需以 `normify-` 开头。
生成架构不授权修改源码。
架构校验不替代产品测试。
不要伪造指纹或验收证据。

## 工具与数据

| 类别 | 主要能力 |
| --- | --- |
| 项目与模块 | 初始化、读取、批量写入、移动 |
| 依赖与规则 | 反查依赖、架构预检、规则维护 |
| 源码证据 | 指纹计算、刷新、漂移检测 |
| 变更治理 | 开单、更新、查询、零错误收尾 |
| 可视化 | 布局、编译、索引与交互图 |
| 帮助 | 字段说明与实时参数树 |

先调用 `normify_help` 查看参数。
主题 `tools` 列出所有工具。
主题 `flow` 说明伴随流程。
主题 `tool:<工具名>` 展开参数。

引擎保留原有数据格式。
它按L1、L2、L3执行校验。
任何错误都会阻断编译。
警告仍需如实汇报。

| 路径 | 内容 |
| --- | --- |
| `modules/` | 模块契约与源码证据 |
| `policy.yml` | 架构规则 |
| `renders/` | 分层布局数据 |
| `normify_changes/` | 变更记录 |
| `tree.json` | 编译后的模块树 |
| `outline.md` | 架构索引 |
| `api-index.json` | API索引 |
| `receipt.json` | 冻结与校验回执 |
| `normify.html` | 单文件交互架构图 |

## 提醒钩子

钩子默认不随安装器安装。
它每八次成功编辑提醒一次。
它隔离会话与仓库计数。
它不自动修改架构或源码。
它不统计shell写文件。
它不监听外部编辑器保存。

先审阅钩子源码与命令。
然后安装钩子：

```powershell
npm run install:hooks
```

在Codex的 `/hooks` 中信任它。
脚本变更后需再次审阅。
安装器不会开启停用的hooks。
用户确认审阅后也可执行：

```powershell
npm run install:hooks -- --trust-installed
```

钩子只是提醒，不是自动门禁。
原生hooks需支持当前协议。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run check
npm test
npm pack --dry-run
```

测试使用临时配置与目录。
MCP测试实际执行全部工具。
安装测试使用本地Codex CLI。
缺少CLI时测试明确跳过。
原生钩子测试使用本地响应夹具。
它不连接云端模型。
引擎测试保留原有回归覆盖。
CI覆盖Windows与Linux。
CI使用Node.js 22和24。

| 目录 | 职责 |
| --- | --- |
| `src/engine/` | 框架无关引擎 |
| `src/tools.ts` | 工具注册与业务逻辑 |
| `src/stdio.mjs` | Codex MCP入口 |
| `src/server.mjs` | 协议与跨进程锁 |
| `scripts/` | 安装、验证与CLI发现 |
| `skills/` | 两个Codex技能 |
| `lib/` | 随仓库提供的编译产物 |

MCP只向stdout写协议消息。
运行日志使用stderr。
旧宿主入口仅供兼容回归。
当前安装不使用DSH配置。
旧规范与发行说明保留历史。
接入行为以本说明和源码为准。

## 参考与许可

- [生成技能](skills/normify-gen/SKILL.md)
- [开发技能](skills/normify-dev/SKILL.md)
- [原版引擎工作流](skills/normify-gen/references/upstream-skill.md)
- [历史规范](docs/SPEC.zh-CN.md)
- [变更记录](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)
- [安全说明](SECURITY.md)
- [OpenAI Docs](https://developers.openai.com/learn/docs-mcp)

本项目保留上游MIT许可。
原作者：yan-mc。
许可全文见 [LICENSE](LICENSE)。
