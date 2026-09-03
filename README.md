# Prompt Optimizer 插件存档（v6 / pkg-6）

在 DeepSeek Harness（DSH）对话输入框旁提供「提示词优化」能力：
点 ✨ 优化后用当前模型改写草稿，输入框直接替换为优化文（发送即优化文），
原文浮动展示在输入框上方作为只读参考，可一键撤销恢复。

## 交互规则（v6 最终行为）

| 操作 | 结果 |
|------|------|
| 输入原文 → ✨ 优化 | 输入框替换为优化文；上方浮现「📋 原文」参考区；「↩ 撤销」出现 |
| 清空输入框草稿 | 撤销按钮 + 原文参考区**一并自动消失**（v6 修复） |
| 点击发送 | 参考区自动收起；发送内容 = 输入框草稿 = 纯优化文 |
| 点 ↩ 撤销 | 恢复最近一次优化前的原文（历史栈可逐级回退） |
| 重新输入新内容 | 旧撤销按钮不复活，界面回到干净初始状态 |

展开（显示参考区）唯一触发：点 ✨ 优化成功。
收起（隐藏参考区）触发：输入框清空 / 进入发送流程（phase ≠ plain）。
参考区内无任何按钮，纯只读。

## 文件说明

- `host.js` — Host 端：`prompt-opt` RPC，读取当前会话模型，经 `llm.stream()` 优化文本
- `client.js` — Client 端：工具行按钮 + 原文参考区 + 自动展开/收起逻辑

两文件均为纯 JavaScript（无 JSX/TS/import），可原样作为
`cordis_define` 的 `code.host` / `code.client` 传入。

## 恢复方法（存档回灌到任意 DSH 实例）

1. 读入 `host.js` 内容 → `cordis_define(plugin: {kind:'new', idPrefix:'prpt'}, code: {host: <内容>, client: <client.js内容>})`
2. 用返回的 `pluginId` / `packageId` 调 `cordis_run(mode:'run')`
3. 在授权弹窗点「允许」后按钮即出现在输入框工具行

## 依赖的 DSH 能力（已实测可用）

- Host：`llm`（`ctx.get('llm')`）、`agentDefaultModel.currentSelection()`、`harness.handle`
- Client：`slots` 插槽 `conversation.input.right`（工具行按钮）、`conversation.input.dock`（参考区）、
  `useInput`（draft/phase）、`inputActions.setDraft`、`host.call`

## 版本历史

| 版本 | 变更 |
|------|------|
| v6（当前存档） | 修复：清空草稿时撤销按钮+参考区一起消失；语义=清空输入即放弃本次优化 |
| v5 | 参考区去掉手动按钮，展开/收起全由输入行为自动驱动 |
| v4 | 输入框只放优化文（发送即优化文），原文浮动展示在输入框上方 |
| v3 | 原文+优化文在编辑区内上下两段（发送会带原文，已废弃） |
| v2 | 输入框上方 dock 对比面板（超界，已废弃） |
| v1 | 仅替换草稿+撤销（无对比展示） |