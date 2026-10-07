# 贡献指南

本仓库以Codex为主要宿主。
保留31个工具与原有数据格式。
引擎源码位于 `src/engine/`。
MCP入口位于 `src/stdio.mjs`。
技能位于 `skills/`。
安装脚本位于 `scripts/`。

## 本地验证

使用Node.js 22及以上。
原生安装测试需要Codex CLI。

```powershell
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run check
npm test
npm pack --dry-run
```

测试必须使用临时目录。
不要写入真实用户配置。
清理前核对绝对目标路径。
缺少CLI时保留跳过记录。
不要伪造人工或自动验收。

## 修改约定

MCP仅向stdout写协议消息。
日志使用stderr。
安装器先备份，再执行替换。
拒绝覆盖用户修改的技能。
安装失败时保留回滚证据。
不要向仓库提交用户配置。
同步提交相关编译产物。
安装行为变化需更新主说明。
历史规范仅记录原版设计。

## 提交约定

标题与正文使用中文。
正文采用Markdown结构。
仅暂存本目标相关文件。
记录真实命令与验证结果。
不要添加署名或工具声明。
