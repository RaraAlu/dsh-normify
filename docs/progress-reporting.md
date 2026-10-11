# 只读进展汇报

进度询问触发证据汇总。
看图请求不等于进度询问。
仅明确看图时打开网页。

## 安装与触发

Codex原生事件为`UserPromptSubmit`。
安装前核验本机能力。
安装器备份既有配置。
它保留编辑提醒等旧钩子。
它拒绝覆盖用户改动。
它只信任本次精确哈希。

```powershell
node scripts/install-progress-hook.mjs --codex-home C:\Users\zhang\.codex --cwd C:\Rust\mjwarp-rs --trust-installed
```

询问“当前开发进度”时触发。
询问“下一步做什么”也触发。
脚本忽略无关、引用及否定。
文本筛选不理解所有同义句。
复杂提问仍需代理独立判断。
钩子只注入汇报证据。
代理负责回答与明确看图。
脚本不启动浏览器。

只读命令也能独立运行：

```powershell
node scripts/progress-report.mjs --root C:\Users\zhang\.codex\normify --project mjwarp-rs --repo-root C:\Rust\mjwarp-rs
```

## 确定性快照

汇报采用固定规则版本。
它绑定Git提交与工作区指纹。
工作区指纹包含索引与差异。
汇报禁用Git文件监视器。
文件启用清理过滤器时停止。
这避免执行仓库自定义命令。
它也包含未跟踪文件内容。
它不读取Git忽略文件。
凭据文件另用内容哈希绑定。
它绑定Normify输入内容。
它核对读取前后快照。
发生改动时拒绝固化。
相同输入产生相同快照编号。
汇报分列阶段与无阶段记录。
记录数量不代表完成百分比。

图谱适配器只读SQLite。
自动查询仅查进行与就绪项。
其他任务标记未查询源码。
它不启动CLI遥测。
它不初始化、迁移或刷新索引。
它逐项核对请求文件哈希。
目录范围与限额须显式报告。
缺索引或类型不兼容报未知。
图谱调用关系不充当任务前置。

## 验收凭据

汇报不从文案推断通过。
使用`--evidence`指定结构凭据。
钩子默认只查一个文件：
`.normify/progress-evidence.json`。
缺文件时保留未验收缺口。
路径必须位于仓库内部。
脚本拒绝符号链接与路径逃逸。
凭据结构如下：

```json
{
  "schema_version": 1,
  "records": [{
    "task_id": "2026-10-12-example",
    "repo_head": "完整提交哈希",
    "workspace_sha256": "汇报给出的工作区哈希",
    "platform": "windows-nvidia",
    "configuration": "g01-full-release",
    "captured_at": "2026-10-12T04:00:00.000Z",
    "result": "failed"
  }]
}
```

记录结果支持`passed`与`failed`。
凭据路径建议加入Git忽略。
否则凭据会改变工作区指纹。
这会让自身记录落入历史。
凭据哈希仍参与汇报快照。
`not_run`表示未执行。
同平台同配置采用最新记录。
同一时刻失败优先。
新失败不能借旧通过洗白。
快照不匹配时标记历史。
凭据只表达已有记录。
它不证明全配置覆盖。
缺凭据时报告未验收。
架构收尾不充当产品验收。

默认钩子不扫描验收文档。
没有结构凭据时保留此缺口。
代理只补查相关验收文件。
不要为了汇报自动运行测试。

## 只读边界

禁止构建、渲染与状态写入。
禁止关闭变更或刷新模块。
禁止产品测试与网页自动打开。
只读汇报不代表质量门禁。
钩子读取失败不阻断开发。
它提示最小范围只读核查。

原生事件参考[OpenAI Docs](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)。
