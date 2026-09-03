# Prompt Optimizer — DSH 可安装插件（v9 / bundle）

在 DeepSeek Harness（DSH）对话输入框旁提供「提示词优化」能力：
点 ✨ 优化后用当前默认模型改写草稿，输入框直接替换为优化文（发送即优化文），
原文浮动展示在输入框上方作为只读参考，可一键撤销恢复。

v8+ 亮点：**设置 → 插件 → 提示词优化** Tab 内可一键**启用/停用**，并直接调整
**生成参数**（思考强度 / maxTokens / 温度）——免重启，即时生效。

v7 起把「动态热加载双端插件（cordis_define / cordis_run）」改造成
**可安装的 dsh bundle 插件**：以 npm 包形态装进 profile，随 `dsh web`
启动自动加载，不再需要每次让模型把代码注入进程。

## 设置页（v8/v9）

打开 **设置 → 插件** 页 → 切到「提示词优化」Tab：

- **启用/停用**：停用后对话输入框不再显示 ✨ 按钮，Host 也拒绝优化调用（不会产生模型费用）；
- **生成参数**：思考强度（off/low/high/max）、最大输出 tokens、温度——点「保存参数」立即生效；
- 「恢复默认」= off / 1500 / 0.1；
- 全部**免重启**；状态持久化在 `~/.dsh/prompt-optimizer-state.json`；
- 已经在其他标签页打开的对话页面，刷新一次即可同步状态。

## 交互规则（与 v6 相同）

| 操作 | 结果 |
|------|------|
| 输入原文 → ✨ 优化 | 输入框替换为优化文；上方浮现「📋 原文」参考区；「↩ 撤销」出现 |
| 清空输入框草稿 | 撤销按钮 + 原文参考区**一并自动消失** |
| 点击发送 | 参考区自动收起；发送内容 = 输入框草稿 = 纯优化文 |
| 点 ↩ 撤销 | 恢复最近一次优化前的原文（历史栈可逐级回退） |
| 重新输入新内容 | 旧撤销按钮不复活，界面回到干净初始状态 |

展开唯一触发：点 ✨ 优化成功。收起触发：输入框清空 / 进入发送流程（phase ≠ plain）。
参考区内无任何按钮，纯只读。

## 包结构（installable bundle，无需构建步骤）

```
prompt-optimizer-plugin/
├── package.json        # 声明 dsh.bundle.patch + dsh.client + exports ./client
├── cordis.patch.yml    # bundle 层：插入一行 Loader 条目挂载 Host 半
├── src/
│   ├── host.js         # Host 半：注册 /plugins/prompt-optimizer-plugin/optimize 路由，
│   │                   #   惰性读 llm / agentDefaultModel，llm.stream() 改写后回 JSON
│   └── client.js       # 浏览器 bundle（window.__ModuleLoader__.load），无 JSX/无编译：
│                       #   require('react') + 插槽注入，fetch 上面的 Host 路由
└── dynamic/            # v6 动态代码体存档（历史 cordis_define 回灌用，不再需要）
```

关键点：

- **双半同包**：`dsh.bundle.patch` 提供 Host 层；`dsh.client` + `exports["./client"]`
  让 dsh-client-modules 把 `src/client.js` 当作浏览器插件服务（加载路径
  `/plugins/prompt-optimizer-plugin/client.js`），两者都随一条 Loader 行激活。
- **RPC 不走 ctx.remote**：`ctx.remote` 只暴露仓库内生成的 /remote 命名空间，
  树外插件无法新增；因此 client→host 用 webserver 同源路由
  （`POST /plugins/prompt-optimizer-plugin/optimize`，Host 半注册），
  这是 0.1.2-rc.1 下官方文档 + 社区已验证的树外双端写法。
- **host.js 依赖**：`inject: ['webServer']` 确保 webserver 就绪后再注册路由；
  `llm` / `agentDefaultModel` 每次请求时 `ctx.get()` 惰性读取。
- **client.js 依赖**：`inject: ['slots']`；工具行按钮与参考区的
  `useInput` / `inputActions` / `sessionId` 来自 ui-conversation 插槽标准 props。

## 安装到 profile（推荐 web）

环境要求：已安装 `dsh`（0.1.2-rc.1）与 `pnpm`（`dsh plugin` 内部调用 pnpm）。

```sh
# 方式 A：本地 checkout（开发迭代最快）
cd <本仓库父目录>
dsh plugin --profile web add ./prompt-optimizer-plugin

# 方式 B：git 仓库（需要仓库根目录即本包，pnpm ≥10 需先放行 prepare）
dsh plugin --profile web add git+https://github.com/naitoupi/prompt-optimizer-plugin.git

# 方式 C：tarball（本包无构建步骤，npm pack 即可分发）
npm pack
dsh plugin --profile web add ./prompt-optimizer-plugin-0.7.0.tgz
```

首次运行 `dsh plugin` 会初始化 profile；安装成功后它把本包追加进
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。
然后**重启 `dsh web`**（客户端模块表在启动时扫描），输入框工具行即出现
「✨ 优化」。

验证装载（无需重启即可看到层）：

```sh
dsh --profile web --dump-config   # 应出现 "# == prompt-optimizer-plugin" 层与 prompt-optimizer 行
```

## 原理说明（为什么是 bundle 而不是动态插件）

- `docs/user/develop/practice/dynamic-cordis.md`：cordis_define/cordis_run 挂载的
  是**内存中的模型临时插件**，进程退出即消失——即 v6 的“热加载”用法。
- 要持久化：把插件做成声明 `dsh.bundle` 的 npm 包（配置层），用
  `dsh plugin --profile <name> add <spec>` 装进 profile
  （`docs/user/develop/basic/publish.md`）。
- 双半打包（Host `src/` + 浏览器 `./client`、`dsh.client` 声明）与无重建生效：
  `docs/cookbook/adding-a-settings-card.md` # Packaging 一节。

## 依赖的 DSH 能力

- Host：`ctx.get('webServer').register`、`ctx.get('llm').stream`、`ctx.get('agentDefaultModel').currentSelection`
- Client：`slots` 插槽 `conversation.input.right`（工具行按钮）、`conversation.input.dock`（参考区）、
  `useInput`（draft/phase）、`inputActions.setDraft`、同源 `fetch`

## 版本历史

| 版本 | 变更 |
|------|------|
| v0.10.0 | 优化指令支持编辑：展开编辑 → 保存自定义指令即时生效；「恢复默认指令」一键回到内置标准版；当前使用中显示“自定义/内置默认” |
| v0.9.2 | 设置页新增「默认优化指令」展示：只读显示内置 system prompt（可复制），来源为 host 单一端点 |
| v0.9.1 | 修复深色主题下思考强度下拉框选项"看不见"：option 显式深底亮字 + colorScheme dark |
| v0.9.0 | 设置页新增「生成参数」：思考强度 / maxTokens / 温度可视化调整，保存即生效；参数优先级：UI 保存值 > profile patch > 内置默认 |
| v0.8.0 | 新增「启用/停用」开关：设置 → 插件 → 提示词优化 Tab；停用即隐藏 ✨ 按钮、拒绝调用；免重启、即时生效 |
| v0.7.6 | 抑制随机与“硬优化”：temperature 默认 0.1；系统指令要求最小化改动、同输入稳定；无需优化时原样返回并提示“已是最优” |
| v0.7.5 | 提速：默认显式关闭模型思考（reasoningEffort:'off'，提示词改写不需要深度推理），并开放 reasoningEffort/maxTokens/temperature 三项可调参数（profile patch 按 id 覆盖） |
| v0.7.4 | 修复真实根因（finish=max-tokens 空返回）：模型思考把输出额度耗尽、正文未开始；遇 max-tokens 空返回自动扩容重试一次，失败按真实 finish 原因提示 |
| v0.7.3 | 错误红字不再单行硬截断：可换行显示（最多 3 行），悬停看全文、点击可手动关闭 |
| v0.7.2 | 修复：出现错误红字后点击发送/清空输入框时，红字提醒未消失；现与参考区一致随发送/清空自动清除 |
| v0.7.1 | 修复“模型未返回有效内容”：强化 system 指令，要求模型对无指令草稿也必须输出改写版；空返回时给出可操作提示（补充“请帮我…”类任务再试） |
| v7（当前） | 静态 bundle：host/client 双半同包 + cordis.patch.yml，`dsh plugin add` 安装、随启动加载；v6 动态体归档到 `dynamic/` |
| v6 | 动态插件最终行为（修复：清空草稿时撤销按钮+参考区一起消失）；交互规则沿用至今 |
| v5 | 参考区去掉手动按钮，展开/收起全由输入行为自动驱动 |
| v4 | 输入框只放优化文（发送即优化文），原文浮动展示在输入框上方 |
| v3 | 原文+优化文在编辑区内上下两段（发送会带原文，已废弃） |
| v2 | 输入框上方 dock 对比面板（超界，已废弃） |
| v1 | 仅替换草稿+撤销（无对比展示） |

## 可调参数（可选）

默认值面向“快且稳”：`reasoningEffort: off`（提示词改写不做深度推理）、
`maxTokens: 1500`、`temperature: 0.1`（低温度 → 结果更可复现）。

**优先在设置页调整**（设置 → 插件 → 提示词优化，UI 保存后立即生效并持久化）。

如需“开箱默认值”（例如给所有 profile / 部署方下发默认参数），也可以在
`$DSH_HOME/profiles/web/cordis.patch.yml` 里按 id 覆盖本插件行并给出 config
（覆盖需要重述整行）——它作为**回落默认**：UI 未保存过对应参数时生效：

```yaml
- id: prompt-optimizer
  name: prompt-optimizer-plugin
  config:
    reasoningEffort: low   # off | low | high | max
    maxTokens: 2048
    temperature: 0.2
```

参数优先级：**UI 保存值 > profile patch config > 内置默认**（UI 点“恢复默认”可回到后两者）。

## 开发与调试

- 改 `src/host.js` 或 `src/client.js` 后：`dsh plugin --profile web add ./prompt-optimizer-plugin` 重装一次
  （link 安装下即更新链接目标），然后重启 `dsh web`。
- Host 路由可直测：`curl -X POST http://127.0.0.1:3080/plugins/prompt-optimizer-plugin/optimize -H 'content-type: application/json' -d '{"text":"帮我写个函数"}'`
- 浏览器端日志可在 DevTools 里看 `window.__ModuleLoader__` 装载与 fetch 调用。
