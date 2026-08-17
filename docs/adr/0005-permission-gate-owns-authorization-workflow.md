---
status: accepted
---

# PermissionGate 统一管理授权流程

`PermissionGate` 是工具执行前唯一的授权 Module，对外负责 `authorize()`，并提供在模型流期间暂缓确认界面的能力。它集中处理权限策略结论、授权记忆、确认队列、持久授权和最终允许或拒绝结果；Agent、CLI 和工具都不再自行判断授权状态。

工具通过权限描述提供授权建议，但不操作 Session 或配置；Prompter 只展示界面并返回用户选择；Session 和 Settings 只负责各自数据的保存与恢复。这个 seam 保持调用方接口小，并让新增工具无需在 Agent 或 CLI 中增加工具类型分支。
