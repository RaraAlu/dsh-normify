---
name: normify-gen
description: 生成并维护Normify架构树。执行规则校验与漂移检查。需要架构治理时使用。不用于普通示意图。
---

# Normify 架构生成

## 使用边界

先读取仓库指引。
用户指令优先。
仅生成架构时只读源码。
修改源码需对应任务授权。
只向结构目录写入架构数据。
不要伪造指纹与验收结果。

## 接入

MCP 服务名：`normify`。
工具名包含 `normify_` 前缀。
先确认工具连接。
缺少工具时停止写入。
不要用提示词代替引擎校验。

使用绝对仓库路径。
将其传入 `repoRoot` 参数。
结构目录必须以 `normify-` 开头。
用 `dir` 指定结构目录。
也可用 `project` 指定项目名。
项目名映射到服务存储根。
不要跨项目复用同一结构目录。

## 生成流程

先分析模块边界与叶子API。
根据用户需求定义依赖规则。
先生成计划态，再执行实现。
现有模块需核对源码证据。
只在叶子声明API。
仅记录父节点与出向依赖。
不要手写派生子节点。
描述同时填写中文与英文。

| 步骤 | 工具 |
| --- | --- |
| 初始化 | `normify_project_init` |
| 查看参数 | `normify_help` |
| 写入模块 | `normify_module_upsert` |
| 批量写入 | `normify_module_batch` |
| 设置规则 | `normify_policy_upsert` |
| 写入布局 | `normify_layout_upsert` |
| 检测漂移 | `normify_sync` |
| 校验 | `normify_validate` |
| 编译 | `normify_build` |
| 渲染 | `normify_render` |

写入参数按实时schema填写。
指纹必须使用引擎计算。
计划态允许尚未实现的源码。
不要激活未实现模块。
增量修改后仍需全项目校验。
错误必须归零。
警告必须汇报。
交付时报告真实产物路径。

## 详细参考

需要字段与布局细节时读取：
[上游工作流](references/upstream-skill.md)。
该参考保留原版内容。
上游许可见参考目录。
其DSH接入说明不适用。
接入遵循本技能说明。
参数以实时schema为准。
伴随开发使用 `$normify-dev`。
