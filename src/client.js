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

    // ── 启用状态 store：页面内多处（工具行/参考区/设置开关）共享，实时联动 ──
    // (Shared enabled-state store: toolbar, dock and the settings switch stay in sync live)
    var storeState = { enabled: true }
    var stateListeners = new Set()

    function publishState() {
      stateListeners.forEach(function (fn) { fn(storeState.enabled) })
    }

    /** 从 Host 拉一次启用状态（页面加载时调用；失败保持现状）。 */
    function refreshState() {
      return fetch(STATE_URL).then(function (res) { return res.json() }).then(function (d) {
        if (d !== null && typeof d === 'object' && typeof d.enabled === 'boolean' && d.enabled !== storeState.enabled) {
          storeState.enabled = d.enabled
          publishState()
        }
      }).catch(function () { /* keep last known state */ })
    }

    function subscribeState(fn) {
      stateListeners.add(fn)
      return function () { stateListeners.delete(fn) }
    }

    /** React 订阅当前启用状态（挂载时拉取一次 + 订阅后续变化）。 */
    function useEnabled() {
      var pair = React.useState(storeState.enabled)
      var enabled = pair[0]
      var setEnabled = pair[1]
      React.useEffect(function () {
        refreshState()
        return subscribeState(function (v) { setEnabled(v) })
      }, [])
      return enabled
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

    // ── 设置 → 插件 → 提示词优化：启用/停用开关 Tab ──
    // (Settings → Plugins → Prompt Optimizer tab with the on/off switch)
    function OptimizerSettingsTab() {
      var enabled = useEnabled()
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var errPair = React.useState(null)
      var error = errPair[0]
      var setError = errPair[1]
      var donePair = React.useState(false)
      var done = donePair[0]
      var setDone = donePair[1]

      function flip() {
        if (busy) return
        setBusy(true)
        setError(null)
        setDone(false)
        return fetch(SET_STATE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !enabled }),
        }).then(async (res) => {
          var d = null
          try { d = await res.json() } catch (e) { d = null }
          if (!res.ok || d === null || typeof d !== 'object' || d.ok !== true) {
            throw new Error((d !== null && typeof d.error === 'string' ? d.error : 'HTTP ' + res.status))
          }
          if (typeof d.enabled === 'boolean') {
            storeState.enabled = d.enabled
            publishState()
          }
          setDone(true)
        }).catch(function (e) {
          setError(String((e && e.message) || e))
        }).then(function () {
          setBusy(false)
        })
      }

      var rowStyle = {
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        padding: '6px 14px', height: '30px', borderRadius: '8px',
        border: '1px solid rgba(128,128,128,0.45)', background: 'transparent',
        color: 'inherit', fontSize: '13px', cursor: 'pointer',
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 2px', maxWidth: '760px' } },
        h('div', { style: { fontWeight: 600, fontSize: '14px' } }, 'Prompt Optimizer（提示词优化）'),
        h('div', { style: { fontSize: '12px', lineHeight: '1.7', opacity: 0.85 } },
          '在对话输入框工具行提供 ✨ 优化：用当前模型把草稿改写为更清晰、更具体的提示词，支持 ↩ 一键撤销、原文浮动参考。',
          h('div', {}, '当前状态：' + (enabled ? '✅ 已启用' : '⏸ 已停用')),
          h('div', {}, '停用后：输入框不再显示优化按钮，也不会发起任何模型调用；即时生效，无需重启 dsh。')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: flip,
            style: busy ? { ...rowStyle, opacity: 0.55, cursor: 'wait' } : rowStyle,
          }, busy ? '处理中…' : (enabled ? '停用插件' : '启用插件'))),
        done
          ? h('div', { style: { color: '#3f9e5f', fontSize: '12px' } },
            '已生效（无需重启）：' + (enabled ? '✨ 优化已恢复' : '✨ 优化已关闭，聊天输入框中的按钮将隐藏'))
          : null,
        error
          ? h('div', { style: { color: '#e5484d', fontSize: '12px', maxWidth: '560px', lineHeight: '1.5' } }, '操作失败：' + error)
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
