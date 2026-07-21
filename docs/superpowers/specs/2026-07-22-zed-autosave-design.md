# Zed 自动保存设计

## 目标

为当前仓库启用 Zed 的延迟自动保存。用户停止输入 1000 毫秒后，Zed 自动保存已修改的文件。

## 实现范围

- 新增项目级配置文件 `.zed/settings.json`。
- 设置 `autosave.after_delay.milliseconds` 为 `1000`。
- 不修改用户的全局 Zed 配置。
- 不启用失焦或窗口切换自动保存。

## 配置

```json
{
  "autosave": {
    "after_delay": {
      "milliseconds": 1000
    }
  }
}
```

## 验证

- 确认配置文件是有效 JSON。
- 确认配置字段与 Zed 官方 `autosave` 设置格式一致。
- 确认 Git 变更仅包含预期的项目级 Zed 配置。
