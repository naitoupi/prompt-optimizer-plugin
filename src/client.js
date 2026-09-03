/**
 * Prompt Optimizer — Client half（可安装 dsh bundle 形态，v11，双语）
 * ================================================================
 * 由 dsh-client-modules 作为浏览器插件加载：包 manifest 声明 dsh.client 并
 * export ./client，页面通过 /plugins/prompt-optimizer-plugin/client.js 获取。
 *
 * 行为（交互规则表见 README）：
 *  - 输入框工具行（conversation.input.right）添加「✨ 优化」「↩ 撤销」按钮
 *  - 优化后输入框直接替换为优化文（发送即优化文）
 *  - 原文浮动展示在输入框上方（conversation.input.dock 参考区，只读）
 *  - 展开/收起全部由输入行为自动驱动；清空草稿时撤销按钮与参考区一并消失
 *  - 设置 → 插件 → 提示词优化：启用/停用开关 + 生成参数 + 可编辑优化指令
 *  - 界面文案跟随页面语言（<html lang> / navigator.language）自动切换中/英
 *
 * 通信：不再用动态插件的 host.call，改 fetch Host 的同源路由
 * （静态插件无法新增 ctx.remote 命名空间，见 src/host.js 头注释）。
 *
 * 本文件即浏览器 bundle（懒 CJS factory 产物），无构建步骤：仅 require('react')
 * （页面模块表提供），其余依赖都通过 ctx 服务与插槽 props 注入。
 */

window.__ModuleLoader__.load({
  id: 'prompt-optimizer-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var h = React.createElement

    /** 与 Host 半侧一致的端点。 */
    var OPTIMIZE_URL = '/plugins/prompt-optimizer-plugin/optimize'
    var STATE_URL = '/plugins/prompt-optimizer-plugin/state'
    var SET_STATE_URL = '/plugins/prompt-optimizer-plugin/set-state'
    var SETTINGS_URL = '/plugins/prompt-optimizer-plugin/settings'
    var PROMPT_URL = '/plugins/prompt-optimizer-plugin/prompt'

    // ── 界面语言：优先 <html lang>，其次 navigator.language；'en' | 'zh' ──
    // (UI language: <html lang> first, then navigator.language)
    function uiLang() {
      var el = typeof document !== 'undefined' && document.documentElement
        ? String(document.documentElement.lang || '') : ''
      if (el.toLowerCase().indexOf('en') === 0) return 'en'
      if (el.toLowerCase().indexOf('zh') === 0) return 'zh'
      var nav = typeof navigator !== 'undefined' && navigator.language ? String(navigator.language) : ''
      return nav.toLowerCase().indexOf('en') === 0 ? 'en' : 'zh'
    }

    /** 双语文案选择。 */
    function L(zh, en) {
      return uiLang() === 'en' ? en : zh
    }

    // ── 插件状态 store（页面内共享，实时联动）──
    // 内容 = Host 的 state 快照：{ enabled, settings: { reasoningEffort, maxTokens, temperature } }
    var storeState = {
      enabled: true,
      settings: { reasoningEffort: 'off', maxTokens: 1500, temperature: 0.1 },
    }
    var stateListeners = new Set()

    function publishState() {
      stateListeners.forEach(function (fn) { fn(storeState) })
    }

    /** 把 Host 返回的 { enabled, settings } 归一化后写入本地 store。 */
    function applyRemoteState(d) {
      if (d === null || typeof d !== 'object') return
      var settings = d.settings !== null && typeof d.settings === 'object' ? d.settings : {}
      var effort = settings.reasoningEffort
      var nextSettings = {
        reasoningEffort: effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max'
          ? effort : storeState.settings.reasoningEffort,
        maxTokens: Number.isFinite(settings.maxTokens) ? settings.maxTokens : storeState.settings.maxTokens,
        temperature: typeof settings.temperature === 'number' ? settings.temperature : storeState.settings.temperature,
      }
      storeState = {
        enabled: typeof d.enabled === 'boolean' ? d.enabled : storeState.enabled,
        settings: nextSettings,
      }
      publishState()
    }

    /** 从 Host 拉一次状态（页面加载/组件挂载时调用；失败保持现状）。 */
    function refreshState() {
      return fetch(STATE_URL).then(function (res) { return res.json() }).then(applyRemoteState)
        .catch(function () { /* keep last known state */ })
    }

    function subscribeState(fn) {
      stateListeners.add(fn)
      return function () { stateListeners.delete(fn) }
    }

    /** React 订阅当前状态快照（挂载时拉取一次 + 订阅后续变化）。 */
    function usePluginState() {
      var pair = React.useState(storeState)
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      React.useEffect(function () {
        refreshState()
        return subscribeState(function (s) { setSnapshot(s) })
      }, [])
      return snapshot
    }

    /** 便捷钩子：插件当前是否启用。 */
    function useEnabled() {
      return usePluginState().enabled
    }

    /** POST JSON 到 Host 端点并解析返回体（自动附带语言标记；HTTP/网络错误抛出）。 */
    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({}, body, { lang: uiLang() })),
      }).then(async (res) => {
        var data = null
        try { data = await res.json() } catch (e) { data = null }
        if (!res.ok || data === null || typeof data !== 'object' || data.ok !== true) {
          throw new Error(data !== null && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status)
        }
        return data
      })
    }

    /**
     * 调用 Host 优化端点。业务失败（ok:false）仍以 HTTP 200 应答并带 error
     * 字段；HTTP/网络错误在此抛出。返回 { ok: true, text } | { ok: false, error }。
     */
    function httpOptimize(text) {
      return fetch(OPTIMIZE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, lang: uiLang() }),
      }).then(async (res) => {
        var data = null
        try { data = await res.json() } catch (e) { data = null }
        if (!res.ok) {
          var msg = data !== null && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status
          throw new Error(msg)
        }
        if (data === null || typeof data !== 'object') throw new Error(L('响应格式错误', 'Malformed response'))
        return data
      })
    }

    // ── 设置 → 插件 → 提示词优化：启用开关 + 生成参数 + 优化指令 ──
    // (Settings → Plugins → Prompt Optimizer tab)
    function OptimizerSettingsTab() {
      var snap = usePluginState()
      var enabled = snap.enabled
      var settings = snap.settings

      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      // 分区反馈：开关区 / 生成参数区 / 优化指令区 各自在按钮下方显示提示
      var toggleMsgPair = React.useState(null)
      var toggleMsg = toggleMsgPair[0]
      var setToggleMsg = toggleMsgPair[1]
      var toggleErrPair = React.useState(null)
      var toggleErr = toggleErrPair[0]
      var setToggleErr = toggleErrPair[1]
      var paramsMsgPair = React.useState(null)
      var paramsMsg = paramsMsgPair[0]
      var setParamsMsg = paramsMsgPair[1]
      var paramsErrPair = React.useState(null)
      var paramsErr = paramsErrPair[0]
      var setParamsErr = paramsErrPair[1]
      var promptMsgPair = React.useState(null)
      var promptMsg = promptMsgPair[0]
      var setPromptMsg = promptMsgPair[1]
      var promptErrPair = React.useState(null)
      var promptErr = promptErrPair[0]
      var setPromptErr = promptErrPair[1]

      // 优化指令展示/编辑（懒加载：首次点“展开编辑”才拉取）
      var showPromptPair = React.useState(false)
      var showPrompt = showPromptPair[0]
      var setShowPrompt = showPromptPair[1]
      var promptPair = React.useState(null)
      var promptText = promptPair[0]
      var setPromptText = promptPair[1]
      var draftPair = React.useState('')
      var promptDraft = draftPair[0]
      var setPromptDraft = draftPair[1]
      var customPair = React.useState(false)
      var promptIsCustom = customPair[0]
      var setPromptIsCustom = customPair[1]
      var copyPair = React.useState('')
      var copyMsg = copyPair[0]
      var setCopyMsg = copyPair[1]

      function loadPromptOnce() {
        if (promptText !== null) return
        // 带语言标记读取：中文界面读中文默认模板，英文界面读英文模板
        fetch(PROMPT_URL + '?lang=' + uiLang()).then(function (res) { return res.json() }).then(function (d) {
          if (d !== null && typeof d === 'object' && d.ok === true && typeof d.prompt === 'string') {
            setPromptText(d.prompt)
            setPromptDraft(d.prompt)
            setPromptIsCustom(d.isCustom === true)
          } else {
            setPromptText('')
            setPromptDraft('')
            setPromptIsCustom(false)
          }
        }).catch(function () {
          setPromptText('')
          setPromptDraft('')
        })
      }

      function togglePrompt() {
        if (showPrompt) { setShowPrompt(false); return }
        setShowPrompt(true)
        loadPromptOnce()
      }

      function savePrompt() {
        if (promptText === null) { loadPromptOnce(); return }
        if (typeof promptDraft !== 'string' || promptDraft.trim() === '') {
          setPromptErr(L('指令内容不能为空', 'The instruction must not be empty'))
          return
        }
        return runTask(function () {
          return postJson(PROMPT_URL, { prompt: promptDraft }).then(function (d) {
            setPromptText(d.prompt)
            setPromptDraft(d.prompt)
            setPromptIsCustom(d.isCustom === true)
            setPromptMsg(L('优化指令已保存并即时生效', 'Instruction saved and applied instantly'))
            return d
          })
        }, setPromptMsg, setPromptErr)
      }

      function resetPrompt() {
        if (promptText === null) { loadPromptOnce(); return }
        return runTask(function () {
          return postJson(PROMPT_URL, { reset: true }).then(function (d) {
            setPromptText(d.prompt)
            setPromptDraft(d.prompt)
            setPromptIsCustom(false)
            setPromptMsg(L('已恢复默认优化指令', 'Restored the built-in default instruction'))
            return d
          })
        }, setPromptMsg, setPromptErr)
      }

      function copyPrompt() {
        if (typeof promptText !== 'string' || promptText === '') return
        function fallback() { setCopyMsg(L('复制失败', 'Copy failed')) }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(promptText).then(function () {
            setCopyMsg(L('已复制', 'Copied'))
            setTimeout(function () { setCopyMsg('') }, 2000)
          }).catch(fallback)
        } else {
          fallback()
        }
      }

      var effortPair = React.useState(settings.reasoningEffort)
      var effort = effortPair[0]
      var setEffort = effortPair[1]
      var tokensPair = React.useState(String(settings.maxTokens))
      var tokensStr = tokensPair[0]
      var setTokensStr = tokensPair[1]
      var tempPair = React.useState(String(settings.temperature))
      var tempStr = tempPair[0]
      var setTempStr = tempPair[1]
      // 远端值变化（保存/恢复默认/其他页面操作）时同步本地草稿
      React.useEffect(function () {
        setEffort(settings.reasoningEffort)
        setTokensStr(String(settings.maxTokens))
        setTempStr(String(settings.temperature))
      }, [settings.reasoningEffort, settings.maxTokens, settings.temperature])

      function runTask(task, setM, setE) {
        setBusy(true)
        setM && setM(null)
        setE && setE(null)
        return task()
          .then(function (d) { return d })
          .catch(function (e) {
            if (setE) setE(String((e && e.message) || e))
            return null
          })
          .then(function (result) { setBusy(false); return result })
      }

      function flip() {
        return runTask(function () {
          return postJson(SET_STATE_URL, { enabled: !enabled }).then(function (d) {
            applyRemoteState(d)
            setToggleMsg(L(
              '已生效（无需重启）：' + (d.enabled === true ? '✨ 优化已恢复' : '✨ 优化已关闭，聊天输入框中的按钮将隐藏'),
              'Applied instantly (no restart): ' + (d.enabled === true ? '✨ optimization restored' : '✨ optimization disabled; the composer buttons will hide')))
            return d
          })
        }, setToggleMsg, setToggleErr)
      }

      function saveSettings() {
        var tokens = parseInt(tokensStr, 10)
        var temp = parseFloat(tempStr)
        if (!Number.isFinite(tokens) || tokens < 64) {
          setParamsErr(L('最大输出 tokens 需为 ≥64 的整数', 'Max output tokens must be an integer ≥ 64'))
          return
        }
        if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
          setParamsErr(L('温度需在 0 ~ 2 之间', 'Temperature must be between 0 and 2'))
          return
        }
        return runTask(function () {
          return postJson(SETTINGS_URL, { reasoningEffort: effort, maxTokens: tokens, temperature: temp }).then(function (d) {
            applyRemoteState(d)
            setParamsMsg(L('生成参数已保存并立即生效', 'Generation parameters saved and applied instantly'))
            return d
          })
        }, setParamsMsg, setParamsErr)
      }

      function resetSettings() {
        return runTask(function () {
          return postJson(SETTINGS_URL, { reset: true }).then(function (d) {
            applyRemoteState(d)
            setParamsMsg(L(
              '已恢复默认参数（关闭思考 off / maxTokens 1500 / 温度 0.1）',
              'Restored default parameters (reasoning off / maxTokens 1500 / temperature 0.1)'))
            return d
          })
        }, setParamsMsg, setParamsErr)
      }

      var rowStyle = {
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        padding: '6px 14px', height: '30px', borderRadius: '8px',
        border: '1px solid rgba(128,128,128,0.45)', background: 'transparent',
        color: 'inherit', fontSize: '13px', cursor: 'pointer',
      }
      var inputStyle = {
        height: '28px', minWidth: '150px', borderRadius: '6px', boxSizing: 'border-box',
        padding: '0 8px', border: '1px solid rgba(128,128,128,0.4)',
        background: 'transparent', color: 'inherit', fontSize: '13px', fontFamily: 'inherit',
      }
      var fieldLabel = { display: 'block', fontSize: '12px', opacity: 0.85, marginBottom: '4px' }
      var fieldHint = { display: 'block', fontSize: '11px', opacity: 0.6, marginTop: '4px', lineHeight: '1.5' }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px', maxWidth: '760px' } },
        h('div', { style: { fontWeight: 600, fontSize: '14px' } }, L('Prompt Optimizer（提示词优化）', 'Prompt Optimizer')),
        h('div', { style: { fontSize: '12px', lineHeight: '1.7', opacity: 0.85 } },
          L('在对话输入框工具行提供 ✨ 优化：用当前模型把草稿改写为更清晰、更具体的提示词，支持 ↩ 一键撤销、原文浮动参考。',
            'Adds ✨ Optimize to the composer toolbar: rewrites your draft into a clearer, more specific prompt with the current model; ↩ undo and a floating original-text reference are included.'),
          h('div', {}, L('当前状态：' + (enabled ? '✅ 已启用' : '⏸ 已停用'), 'Current status: ' + (enabled ? '✅ Enabled' : '⏸ Disabled'))),
          h('div', {}, L('停用后：输入框不再显示优化按钮，也不会发起任何模型调用。', 'When disabled, the optimize button disappears and no model call is made.'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', {
            type: 'button', disabled: busy, onClick: flip,
            style: busy ? { ...rowStyle, opacity: 0.55, cursor: 'wait' } : rowStyle,
          }, busy ? L('处理中…', 'Working…') : (enabled ? L('停用插件', 'Disable plugin') : L('启用插件', 'Enable plugin')))),
        toggleMsg
          ? h('div', { style: { color: '#3f9e5f', fontSize: '12px' } }, toggleMsg)
          : null,
        toggleErr
          ? h('div', { style: { color: '#e5484d', fontSize: '12px', maxWidth: '560px', lineHeight: '1.5' } }, toggleErr)
          : null,

        h('div', {
          style: { borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '12px' },
        },
          h('div', { style: { fontWeight: 600, fontSize: '13px' } }, L('生成参数（点击优化时生效）', 'Generation parameters (used when optimizing)')),
          h('div', {},
            h('label', { style: fieldLabel }, L('思考强度（reasoningEffort）', 'Reasoning effort')),
            // colorScheme:'dark' 让原生下拉弹窗按深色渲染；option 显式给出
            // 深底亮字，避免深色主题下选项近乎白底白字"看不见"的 bug
            h('select', {
              value: effort,
              onChange: function (e) { setEffort(e.target.value) },
              style: { ...inputStyle, cursor: 'pointer', colorScheme: 'dark' },
            },
              h('option', { value: 'off', style: { background: 'var(--dsw-specific-menu, #1f1f1f)', color: 'var(--dsw-alias-label-primary, #eee)' } }, L('off — 关闭思考（最快，推荐）', 'off — no reasoning (fastest, recommended)')),
              h('option', { value: 'low', style: { background: 'var(--dsw-specific-menu, #1f1f1f)', color: 'var(--dsw-alias-label-primary, #eee)' } }, L('low — 轻度思考', 'low — light reasoning')),
              h('option', { value: 'high', style: { background: 'var(--dsw-specific-menu, #1f1f1f)', color: 'var(--dsw-alias-label-primary, #eee)' } }, L('high — 深度思考（更慢）', 'high — deep reasoning (slower)')),
              h('option', { value: 'max', style: { background: 'var(--dsw-specific-menu, #1f1f1f)', color: 'var(--dsw-alias-label-primary, #eee)' } }, L('max — 最强思考（最慢）', 'max — strongest reasoning (slowest)')),
            ),
            h('span', { style: fieldHint }, L('提示词改写通常不需要深度推理；off 速度快、额度不会被思考耗尽。', 'Prompt rewriting usually needs no deep reasoning; off is fast and won\u2019t exhaust the token budget on thinking.')),
          ),
          h('div', {},
            h('label', { style: fieldLabel }, L('最大输出 tokens', 'Max output tokens')),
            h('input', {
              type: 'number', min: 64, step: 64, value: tokensStr,
              onChange: function (e) { setTokensStr(e.target.value) },
              style: inputStyle,
            }),
            h('span', { style: fieldHint }, L('单次改写允许生成的最大 token 数（≥64）。', 'Maximum tokens allowed for one rewrite (≥ 64).')),
          ),
          h('div', {},
            h('label', { style: fieldLabel }, L('温度（temperature，0 ~ 2）', 'Temperature (0 ~ 2)')),
            h('input', {
              type: 'number', min: 0, max: 2, step: 0.05, value: tempStr,
              onChange: function (e) { setTempStr(e.target.value) },
              style: inputStyle,
            }),
            h('span', { style: fieldHint }, L('越低越稳定可复现（默认 0.1）；想要更多样化可调高。', 'Lower is more stable and reproducible (default 0.1); raise it for more variety.')),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '2px' } },
            h('button', {
              type: 'button', disabled: busy, onClick: saveSettings,
              style: { ...rowStyle, borderColor: 'rgba(96,125,255,0.65)', color: 'inherit' },
            }, busy ? L('保存中…', 'Saving…') : L('保存参数', 'Save parameters')),
            h('button', {
              type: 'button', disabled: busy, onClick: resetSettings,
              style: rowStyle,
            }, L('恢复默认', 'Reset to default')),
          ),
          paramsMsg
            ? h('div', { style: { color: '#3f9e5f', fontSize: '12px' } }, paramsMsg)
            : null,
          paramsErr
            ? h('div', { style: { color: '#e5484d', fontSize: '12px', lineHeight: '1.5' } }, paramsErr)
            : null,
        ),

        h('div', {
          style: { borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' },
        },
          h('div', { style: { fontWeight: 600, fontSize: '13px' } }, L('优化指令（system prompt，可编辑）', 'Instruction (system prompt, editable)')),
          h('div', { style: { fontSize: '12px', lineHeight: '1.7', opacity: 0.85 } },
            L('点击 ✨ 优化时模型收到的指令。当前使用：' + (promptIsCustom ? '自定义版本' : '内置默认版'),
              'The instruction the model receives when you click ✨. Currently using: ' + (promptIsCustom ? 'custom version' : 'built-in default')),
            h('div', {}, L('保存后立即生效；「恢复默认」即回到内置的标准优化指令。', 'Saving applies instantly; “Reset to default” restores the built-in standard instruction.'))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('button', { type: 'button', onClick: togglePrompt, style: rowStyle },
              showPrompt ? L('收起', 'Collapse') : L('展开编辑', 'Edit')),
            promptText !== null
              ? h('button', { type: 'button', onClick: copyPrompt, style: rowStyle }, L('复制', 'Copy'))
              : null,
            copyMsg
              ? h('span', { style: { color: '#3f9e5f', fontSize: '12px' } }, copyMsg)
              : null,
          ),
          showPrompt
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('textarea', {
                  value: promptDraft,
                  onChange: function (e) { setPromptDraft(e.target.value) },
                  spellCheck: false,
                  style: {
                    width: '100%', boxSizing: 'border-box', minHeight: '180px', resize: 'vertical',
                    padding: '10px 12px', borderRadius: '8px',
                    border: '1px solid rgba(128,128,128,0.35)',
                    background: 'rgba(128,128,128,0.06)', color: 'inherit',
                    fontSize: '12px', lineHeight: '1.6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  },
                }),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                  h('button', {
                    type: 'button', disabled: busy, onClick: savePrompt,
                    style: { ...rowStyle, borderColor: 'rgba(96,125,255,0.65)', color: 'inherit' },
                  }, busy ? L('保存中…', 'Saving…') : L('保存指令', 'Save instruction')),
                  h('button', { type: 'button', disabled: busy, onClick: resetPrompt, style: rowStyle }, L('恢复默认指令', 'Reset to default')),
                ),
                promptMsg
                  ? h('div', { style: { color: '#3f9e5f', fontSize: '12px' } }, promptMsg)
                  : null,
                promptErr
                  ? h('div', { style: { color: '#e5484d', fontSize: '12px', lineHeight: '1.5' } }, promptErr)
                  : null,
              )
            : null,
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      void refreshState()

      // 按会话保存「原文→优化文」历史栈，供工具行按钮与原文参考区共享
      // (Per-session original→optimized history stack shared by the toolbar and the draft reference dock)
      const historyBySession = new Map()
      const listenersBySession = new Map()
      const subscribe = (sessionId, fn) => {
        let set = listenersBySession.get(sessionId)
        if (!set) { set = new Set(); listenersBySession.set(sessionId, set) }
        set.add(fn)
        return () => { set.delete(fn) }
      }
      const notify = (sessionId) => {
        const set = listenersBySession.get(sessionId)
        if (set) for (const fn of set) fn()
      }
      const hasHistory = (sessionId) => {
        const s = historyBySession.get(sessionId)
        return !!s && s.length > 0
      }
      const peek = (sessionId) => {
        const s = historyBySession.get(sessionId)
        return s && s.length ? s[s.length - 1] : null
      }
      const push = (sessionId, original, optimized) => {
        let s = historyBySession.get(sessionId)
        if (!s) { s = []; historyBySession.set(sessionId, s) }
        s.push({ original, optimized })
        notify(sessionId)
      }
      const pop = (sessionId) => {
        const s = historyBySession.get(sessionId)
        if (!s || !s.length) return null
        const entry = s.pop()
        notify(sessionId)
        return entry
      }
      // 清空某会话的全部优化历史
      // (Clear the whole optimization history of one session)
      const clear = (sessionId) => {
        if (historyBySession.has(sessionId)) {
          historyBySession.delete(sessionId)
          notify(sessionId)
        }
      }
      // 从最新一条对比记录恢复原文并出栈
      // (Restore the original text from the latest compare entry and pop it)
      const revert = (sessionId, inputActions) => {
        const entry = pop(sessionId)
        if (entry) inputActions.setDraft(entry.original)
      }

      const btnBase = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 10px',
        height: '26px',
        borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.4)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      }
      const btnDisabled = { ...btnBase, opacity: 0.45, cursor: 'not-allowed' }

      // ── 工具行：优化 / 撤销 按钮（停用时整行隐藏）──
      // (Toolbar Optimize/Undo controls; hidden while the plugin is disabled)
      slots.inject('conversation.input.right', () => slots.register(
        { name: 'conversation.input.right', id: 'prompt-opt' },
        (props) => {
          const enabled = useEnabled()
          const { useInput, inputActions, sessionId } = props || {}
          // hooks 全部无条件执行（hooks 顺序稳定），再统一决定是否渲染
          const draft = typeof useInput === 'function' ? useInput((s) => s.draft) : undefined
          const phase = typeof useInput === 'function' ? useInput((s) => s.phase) : undefined
          const [busy, setBusy] = React.useState(false)
          const [err, setErr] = React.useState(null)
          const [notice, setNotice] = React.useState(null)
          const [undoable, setUndoable] = React.useState(!!sessionId && hasHistory(sessionId))
          React.useEffect(() => {
            if (!sessionId) return undefined
            return subscribe(sessionId, () => setUndoable(hasHistory(sessionId)))
          }, [sessionId])
          // 普通提示（如“已是最优，未改动”）几秒后自动消失
          React.useEffect(() => {
            if (!notice) return undefined
            const timer = setTimeout(() => setNotice(null), 3200)
            return () => clearTimeout(timer)
          }, [notice])
          // 发送（phase 离开 plain）→ 清掉上次失败留下的红字/提示
          React.useEffect(() => {
            if (phase !== undefined && phase !== 'plain') {
              setErr(null)
              setNotice(null)
            }
          }, [phase])
          // 输入框被清空 → 清空该会话历史；红字/提示一并消失
          React.useEffect(() => {
            if (sessionId && typeof draft === 'string' && draft.trim() === '') {
              clear(sessionId)
              setErr(null)
              setNotice(null)
            }
          }, [draft, sessionId])

          const ready = enabled && !!useInput && !!inputActions && !!sessionId
          const draftEmpty = !(typeof draft === 'string' && draft.trim().length > 0)
          const canOptimize = ready && !busy && !draftEmpty
          const showUndo = ready && undoable && !draftEmpty
          if (!ready) return h('div', null)

          const onOptimize = async () => {
            if (!canOptimize) return
            setBusy(true)
            setErr(null)
            setNotice(null)
            try {
              const res = await httpOptimize(draft)
              if (res && typeof res === 'object' && res.ok === true && typeof res.text === 'string' && res.text.trim()) {
                if (res.unchanged === true || res.text === draft) {
                  // 模型判定无需优化：不替换草稿、不入撤销栈，只给短暂提示
                  setNotice(L('无需优化：模型认为原文已是最优，未做改动', 'Already optimal: the model considered the original unchanged'))
                } else {
                  // 记录原文；输入框直接替换为优化文，发送即优化文
                  push(sessionId, draft, res.text)
                  inputActions.setDraft(res.text)
                }
              } else {
                setErr((res && res.error) || L('优化失败', 'Optimization failed'))
              }
            } catch (e) {
              setErr(String((e && e.message) || e))
            } finally {
              setBusy(false)
            }
          }
          const onUndo = () => { if (!busy) revert(sessionId, inputActions) }

          return h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('button', {
              key: 'opt',
              type: 'button',
              onClick: onOptimize,
              disabled: !canOptimize,
              style: canOptimize ? btnBase : btnDisabled,
              title: L('调用当前模型优化输入框中的文本，输入框替换为优化后的提示词，原文浮动展示在输入框上方',
                'Rewrite the composer draft with the current model; the draft becomes the optimized prompt and the original floats above the composer'),
            }, busy ? L('优化中…', 'Optimizing…') : '✨ 优化'),
            showUndo
              ? h('button', {
                  key: 'undo',
                  type: 'button',
                  onClick: onUndo,
                  disabled: busy,
                  style: busy ? btnDisabled : btnBase,
                  title: L('撤销最近一次优化，恢复原文本', 'Undo the last optimization and restore the original text'),
                }, '↩ 撤销')
              : null,
            notice
              ? h('span', {
                  key: 'notice',
                  style: {
                    color: '#8a8f98', fontSize: '12px', lineHeight: '1.45',
                    maxWidth: '300px', whiteSpace: 'normal', wordBreak: 'break-word',
                  },
                }, notice)
              : null,
            err
              ? h('span', {
                  key: 'err',
                  title: err + L('（点击可关闭此提示）', ' (click to dismiss)'),
                  onClick: () => setErr(null),
                  style: {
                    color: '#e5484d', fontSize: '12px', lineHeight: '1.45',
                    maxWidth: '420px', whiteSpace: 'normal', wordBreak: 'break-word',
                    overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer',
                    display: '-webkit-box', WebkitLineClamp: '3', WebkitBoxOrient: 'vertical',
                  },
                }, err)
              : null,
          )
        },
      ))

      // ── 原文参考区（停用时隐藏）──
      // (Original-draft reference dock; hidden while disabled)
      slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'prompt-opt-original', order: 5 },
        (props) => {
          const enabled = useEnabled()
          const { useInput, sessionId } = props || {}
          const draft = typeof useInput === 'function' ? useInput((s) => s.draft) : undefined
          const phase = typeof useInput === 'function' ? useInput((s) => s.phase) : undefined
          const [entry, setEntry] = React.useState(sessionId ? peek(sessionId) : null)
          const [hidden, setHidden] = React.useState(false)
          // 订阅历史栈：新优化入栈 → 展开；栈清空 → 自动隐藏
          React.useEffect(() => {
            if (!sessionId) return undefined
            return subscribe(sessionId, () => {
              const e = peek(sessionId)
              setEntry(e)
              if (e) setHidden(false)
            })
          }, [sessionId])
          // 输入框被清空 → 自动收起
          React.useEffect(() => {
            if (sessionId && typeof draft === 'string' && draft.trim() === '') setHidden(true)
          }, [draft, sessionId])
          // 发送（phase 离开 plain）→ 自动收起
          React.useEffect(() => {
            if (phase !== undefined && phase !== 'plain') setHidden(true)
          }, [phase])

          if (!enabled || !sessionId || !useInput || !entry || hidden) return null

          return h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: '6px', boxSizing: 'border-box',
              width: '100%', maxWidth: 'var(--dsh-composer-card-max-width)', margin: '0 auto',
              padding: '8px 12px', borderRadius: '10px',
              border: '1px dashed rgba(96,125,255,0.45)', background: 'rgba(96,125,255,0.06)',
              color: 'inherit', fontSize: '12px',
            },
          },
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { fontWeight: 600, fontSize: '12px', opacity: 0.9 } },
                L('📋 原文（优化前的输入框内容，仅作参考，不会随消息发送）',
                  '📋 Original (your text before optimizing; reference only — never sent with the message)')),
            ),
            h('div', { key: 'body', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.5', opacity: 0.75 } }, entry.original),
          )
        },
      ))

      // ── 设置 → 插件 → 提示词优化：开关 Tab ──
      // (Settings → Plugins → Prompt Optimizer tab)
      slots.inject('settings.plugins.tab', () => slots.register(
        { name: 'settings.plugins.tab', id: 'prompt-optimizer', order: 30, label: () => L('提示词优化', 'Prompt Optimizer') },
        OptimizerSettingsTab,
      ))
    }

    module.exports = { name: 'prompt-optimizer-plugin', inject: ['slots'], apply }
    return module.exports
  },
})
