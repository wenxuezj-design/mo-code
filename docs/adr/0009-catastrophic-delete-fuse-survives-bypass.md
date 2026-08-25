---
status: accepted
---

# 灾难删除熔断不被 bypass 跳过

mo-code 对能够明确识别的文件系统根目录和当前用户 Home 目录递归删除启用灾难删除熔断。`default`、`acceptEdits` 和 `bypassPermissions` 都必须逐次确认且不能记忆，`dontAsk` 与 `plan` 则直接拒绝。

该熔断只覆盖最明确、影响最大的两类目标，不额外保护整个主工作目录。普通模式中的工作目录删除仍按修改型 Shell 处理；`bypassPermissions` 下则尊重用户主动跳过权限的选择。这个范围与 Claude Code 的核心行为一致，同时避免扩展成完整的删除风险分类器。

首批识别 `rm` 的递归删除以及 `find ... -delete`。即使整条 Shell 因未知选项、重定向、续行或复合语法被降为 `unknown`，只要仍能确认 root/Home 的递归删除目标，就保留这部分事实供熔断使用，而不是随完整分析结果一起丢弃。`find -L ... -delete` 还可能沿目录内符号链接到达 root/Home；本阶段不遍历目录，直接把它标记为潜在灾难删除并采用同一熔断。
