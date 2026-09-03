# Prompt Optimizer — DSH 可安装插件（v7 / bundle）

在 DeepSeek Harness（DSH）对话输入框旁提供「提示词优化」能力：
点 ✨ 优化后用当前默认模型改写草稿，输入框直接替换为优化文（发送即优化文），
原文浮动展示在输入框上方作为只读参考，可一键撤销恢复。

v7 与 v6 功能一致，但把「动态热加载双端插件（cordis_define / cordis_run）」
改造成 **可安装的 dsh bundle 插件**：以 npm 包形态装进 profile，随 `dsh web`
启动自动加载，不再需要每次让模型把代码注入进程。

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
| v7（当前） | 静态 bundle：host/client 双半同包 + cordis.patch.yml，`dsh plugin add` 安装、随启动加载；v6 动态体归档到 `dynamic/` |
| v6 | 动态插件最终行为（修复：清空草稿时撤销按钮+参考区一起消失）；交互规则沿用至今 |
| v5 | 参考区去掉手动按钮，展开/收起全由输入行为自动驱动 |
| v4 | 输入框只放优化文（发送即优化文），原文浮动展示在输入框上方 |
| v3 | 原文+优化文在编辑区内上下两段（发送会带原文，已废弃） |
| v2 | 输入框上方 dock 对比面板（超界，已废弃） |
| v1 | 仅替换草稿+撤销（无对比展示） |

## 开发与调试

- 改 `src/host.js` 或 `src/client.js` 后：`dsh plugin --profile web add ./prompt-optimizer-plugin` 重装一次
  （link 安装下即更新链接目标），然后重启 `dsh web`。
- Host 路由可直测：`curl -X POST http://127.0.0.1:3080/plugins/prompt-optimizer-plugin/optimize -H 'content-type: application/json' -d '{"text":"帮我写个函数"}'`
- 浏览器端日志可在 DevTools 里看 `window.__ModuleLoader__` 装载与 fetch 调用。
