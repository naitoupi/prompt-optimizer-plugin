/**
 * Prompt Optimizer — Client half（可安装 dsh bundle 形态，v8）
 * ============================================================
 * 由 dsh-client-modules 作为浏览器插件加载：包 manifest 声明 dsh.client 并
 * export ./client，页面通过 /plugins/prompt-optimizer-plugin/client.js 获取。
 *
 * 行为（交互规则表见 README）：
 *  - 输入框工具行（conversation.input.right）添加「✨ 优化」「↩ 撤销」按钮
 *  - 优化后输入框直接替换为优化文（发送即优化文）
 *  - 原文浮动展示在输入框上方（conversation.input.dock 参考区，只读）
 *  - 展开/收起全部由输入行为自动驱动；清空草稿时撤销按钮与参考区一并消失
 *  - 设置 → 插件 → 提示词优化：启用/停用开关（v8，免重启）
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

    /** POST JSON 到 Host 端点并解析返回体（HTTP/网络错误抛出）。 */
    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
        body: JSON.stringify({ text }),
      }).then(async (res) => {
        var data = null
        try { data = await res.json() } catch (e) { data = null }
        if (!res.ok) {
          var msg = data !== null && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status
          throw new Error(msg)
        }
        if (data === null || typeof data !== 'object') throw new Error('响应格式错误')
        return data
      })
    }

    // ── 设置 → 插件 → 提示词优化：启用开关 + 生成参数 ──
    // (Settings → Plugins → Prompt Optimizer tab: on/off switch + generation params)
    function OptimizerSettingsTab() {
      var snap = usePluginState()
      var enabled = snap.enabled
      var settings = snap.settings

      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var msgPair = React.useState(null)
      var msg = msgPair[0]
      var setMsg = msgPair[1]
      var errPair = React.useState(null)
      var error = errPair[0]
      var setError = errPair[1]

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

      function busyWrap(task) {
        setBusy(true)
        setError(null)
        setMsg(null)
        return task()
          .then(function (d) { return d })
          .catch(function (e) {
            setError(String((e && e.message) || e))
            return null
          })
          .then(function (result) { setBusy(false); return result })
      }

      function flip() {
        return busyWrap(function () {
          return postJson(SET_STATE_URL, { enabled: !enabled }).then(function (d) {
            applyRemoteState(d)
            setMsg('已生效（无需重启）：' + (d.enabled === true ? '✨ 优化已恢复' : '✨ 优化已关闭，聊天输入框中的按钮将隐藏'))
            return d
          })
        })
      }

      function saveSettings() {
        var tokens = parseInt(tokensStr, 10)
        var temp = parseFloat(tempStr)
        if (!Number.isFinite(tokens) || tokens < 64) {
          setError('最大输出 tokens 需为 ≥64 的整数')
          return
        }
        if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
          setError('温度需在 0 ~ 2 之间')
          return
        }
        return busyWrap(function () {
          return postJson(SETTINGS_URL, { reasoningEffort: effort, maxTokens: tokens, temperature: temp }).then(function (d) {
            applyRemoteState(d)
            setMsg('生成参数已保存并立即生效')
            return d
          })
        })
      }

      function resetSettings() {
        return busyWrap(function () {
          return postJson(SETTINGS_URL, { reset: true }).then(function (d) {
            applyRemoteState(d)
            setMsg('已恢复默认参数（关闭思考 off / maxTokens 1500 / 温度 0.1）')
            return d
          })
        })
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
        h('div', { style: { fontWeight: 600, fontSize: '14px' } }, 'Prompt Optimizer（提示词优化）'),
        h('div', { style: { fontSize: '12px', lineHeight: '1.7', opacity: 0.85 } },
          '在对话输入框工具行提供 ✨ 优化：用当前模型把草稿改写为更清晰、更具体的提示词，支持 ↩ 一键撤销、原文浮动参考。',
          h('div', {}, '当前状态：' + (enabled ? '✅ 已启用' : '⏸ 已停用')),
          h('div', {}, '停用后：输入框不再显示优化按钮，也不会发起任何模型调用。')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', {
            type: 'button', disabled: busy, onClick: flip,
            style: busy ? { ...rowStyle, opacity: 0.55, cursor: 'wait' } : rowStyle,
          }, busy ? '处理中…' : (enabled ? '停用插件' : '启用插件'))),

        h('div', {
          style: { borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '12px' },
        },
          h('div', { style: { fontWeight: 600, fontSize: '13px' } }, '生成参数（点击优化时生效）'),
          h('div', {},
            h('label', { style: fieldLabel }, '思考强度（reasoningEffort）'),
            h('select', {
              value: effort,
              onChange: function (e) { setEffort(e.target.value) },
              style: { ...inputStyle, cursor: 'pointer' },
            },
              h('option', { value: 'off' }, 'off — 关闭思考（最快，推荐）'),
              h('option', { value: 'low' }, 'low — 轻度思考'),
              h('option', { value: 'high' }, 'high — 深度思考（更慢）'),
              h('option', { value: 'max' }, 'max — 最强思考（最慢）'),
            ),
            h('span', { style: fieldHint }, '提示词改写通常不需要深度推理；off 速度快、额度不会被思考耗尽。'),
          ),
          h('div', {},
            h('label', { style: fieldLabel }, '最大输出 tokens'),
            h('input', {
              type: 'number', min: 64, step: 64, value: tokensStr,
              onChange: function (e) { setTokensStr(e.target.value) },
              style: inputStyle,
            }),
            h('span', { style: fieldHint }, '单次改写允许生成的最大 token 数（≥64）。'),
          ),
          h('div', {},
            h('label', { style: fieldLabel }, '温度（temperature，0 ~ 2）'),
            h('input', {
              type: 'number', min: 0, max: 2, step: 0.05, value: tempStr,
              onChange: function (e) { setTempStr(e.target.value) },
              style: inputStyle,
            }),
            h('span', { style: fieldHint }, '越低越稳定可复现（默认 0.1）；想要更多样化可调高。'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '2px' } },
            h('button', {
              type: 'button', disabled: busy, onClick: saveSettings,
              style: { ...rowStyle, borderColor: 'rgba(96,125,255,0.65)', color: 'inherit' },
            }, busy ? '保存中…' : '保存参数'),
            h('button', {
              type: 'button', disabled: busy, onClick: resetSettings,
              style: rowStyle,
            }, '恢复默认'),
          ),
        ),

        msg
          ? h('div', { style: { color: '#3f9e5f', fontSize: '12px' } }, msg)
          : null,
        error
          ? h('div', { style: { color: '#e5484d', fontSize: '12px', maxWidth: '560px', lineHeight: '1.5' } }, error)
          : null,
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
                  setNotice('无需优化：模型认为原文已是最优，未做改动')
                } else {
                  // 记录原文；输入框直接替换为优化文，发送即优化文
                  push(sessionId, draft, res.text)
                  inputActions.setDraft(res.text)
                }
              } else {
                setErr((res && res.error) || '优化失败')
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
              title: '调用当前模型优化输入框中的文本，输入框替换为优化后的提示词，原文浮动展示在输入框上方',
            }, busy ? '优化中…' : '✨ 优化'),
            showUndo
              ? h('button', {
                  key: 'undo',
                  type: 'button',
                  onClick: onUndo,
                  disabled: busy,
                  style: busy ? btnDisabled : btnBase,
                  title: '撤销最近一次优化，恢复原文本',
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
                  title: err + '（点击可关闭此提示）',
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
              h('span', { style: { fontWeight: 600, fontSize: '12px', opacity: 0.9 } }, '📋 原文（优化前的输入框内容，仅作参考，不会随消息发送）'),
            ),
            h('div', { key: 'body', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.5', opacity: 0.75 } }, entry.original),
          )
        },
      ))

      // ── 设置 → 插件 → 提示词优化：开关 Tab ──
      // (Settings → Plugins → Prompt Optimizer tab)
      slots.inject('settings.plugins.tab', () => slots.register(
        { name: 'settings.plugins.tab', id: 'prompt-optimizer', order: 30, label: () => '提示词优化' },
        OptimizerSettingsTab,
      ))
    }

    module.exports = { name: 'prompt-optimizer-plugin', inject: ['slots'], apply }
    return module.exports
  },
})
