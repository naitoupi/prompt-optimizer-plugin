/**
 * Prompt Optimizer — Client half（可安装 dsh bundle 形态，v7）
 * ============================================================
 * 由 dsh-client-modules 作为浏览器插件加载：包 manifest 声明 dsh.client 并
 * export ./client，页面通过 /plugins/prompt-optimizer-plugin/client.js 获取。
 *
 * 行为与 v6 完全一致（交互规则表见 README）：
 *  - 输入框工具行（conversation.input.right）添加「✨ 优化」「↩ 撤销」按钮
 *  - 优化后输入框直接替换为优化文（发送即优化文）
 *  - 原文浮动展示在输入框上方（conversation.input.dock 参考区，只读）
 *  - 展开/收起全部由输入行为自动驱动；清空草稿时撤销按钮与参考区一并消失
 *
 * 与 v6 的唯一差异：不再用动态插件的 host.call('prompt-opt')，改为 fetch
 * Host 注册的同源路由 POST /plugins/prompt-optimizer-plugin/optimize
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

    /** 与 Host 半侧一致的优化端点。 */
    var OPTIMIZE_URL = '/plugins/prompt-optimizer-plugin/optimize'

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

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

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

      // ── 工具行：优化 / 撤销 按钮 ──
      // (Toolbar Optimize/Undo controls)
      slots.inject('conversation.input.right', () => slots.register(
        { name: 'conversation.input.right', id: 'prompt-opt' },
        (props) => {
          const { useInput, inputActions, sessionId } = props || {}
          if (!useInput || !inputActions) return React.createElement('div', null)
          const draft = useInput((s) => s.draft)
          const [busy, setBusy] = React.useState(false)
          const [err, setErr] = React.useState(null)
          const [undoable, setUndoable] = React.useState(hasHistory(sessionId))
          React.useEffect(() => subscribe(sessionId, () => setUndoable(hasHistory(sessionId))), [sessionId])
          // 发送（phase 离开 plain）→ 清掉上次失败留下的红字提醒，避免“模型未返回
          // 有效内容”一直残留在输入工具行旁
          // (Once the draft enters the submit pipeline the stale error text clears)
          const phase = useInput((s) => s.phase)
          React.useEffect(() => {
            if (phase !== 'plain') setErr(null)
          }, [phase])
          // 输入框被清空 → 清空该会话优化历史：撤销按钮与原文参考区一并消失；
          // 红字提醒也一并消失
          // (Clearing the draft clears the session history, so Undo and the reference
          // dock both disappear; the stale error text clears too)
          React.useEffect(() => {
            if (typeof draft === 'string' && draft.trim() === '') {
              clear(sessionId)
              setErr(null)
            }
          }, [draft])
          const draftEmpty = !(typeof draft === 'string' && draft.trim().length > 0)
          const canOptimize = !busy && !draftEmpty

          const onOptimize = async () => {
            if (!canOptimize) return
            setBusy(true)
            setErr(null)
            try {
              const res = await httpOptimize(draft)
              if (res && typeof res === 'object' && res.ok === true && typeof res.text === 'string' && res.text.trim()) {
                if (res.text !== draft) {
                  // 记录原文；输入框直接替换为优化文，发送即优化文
                  // (Record original; replace draft with the optimized text only, so submit sends the optimized prompt)
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
          // 撤销按钮仅在「有历史」且「草稿非空」时显示
          // (The Undo button shows only when there is history and the draft is not empty)
          const showUndo = undoable && !draftEmpty

          return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement('button', {
              key: 'opt',
              type: 'button',
              onClick: onOptimize,
              disabled: !canOptimize,
              style: canOptimize ? btnBase : btnDisabled,
              title: '调用当前模型优化输入框中的文本，输入框替换为优化后的提示词，原文浮动展示在输入框上方',
            }, busy ? '优化中…' : '✨ 优化'),
            showUndo
              ? React.createElement('button', {
                  key: 'undo',
                  type: 'button',
                  onClick: onUndo,
                  disabled: busy,
                  style: busy ? btnDisabled : btnBase,
                  title: '撤销最近一次优化，恢复原文本',
                }, '↩ 撤销')
              : null,
            err
              ? React.createElement('span', {
                  key: 'err',
                  style: { color: '#e5484d', fontSize: '12px', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, err)
              : null,
          )
        },
      ))

      // ── 原文参考区：浮动在输入框卡片上方，展开/收起全部由输入行为自动驱动 ──
      // (Original-draft reference dock above the composer card; expand/collapse is fully driven by input behavior)
      slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'prompt-opt-original', order: 5 },
        (props) => {
          const { useInput, sessionId } = props || {}
          const [entry, setEntry] = React.useState(peek(sessionId))
          const [hidden, setHidden] = React.useState(false)
          // 订阅历史栈：新优化入栈 → 展开；栈清空 → 自动隐藏
          // (Subscribe to the history stack: a new optimization expands, an empty stack hides)
          React.useEffect(() => subscribe(sessionId, () => {
            const e = peek(sessionId)
            setEntry(e)
            if (e) setHidden(false)
          }), [sessionId])
          // 输入框被清空 → 自动收起
          // (Auto-collapse when the input draft is cleared)
          const draft = useInput((s) => s.draft)
          React.useEffect(() => {
            if (typeof draft === 'string' && draft.trim() === '') setHidden(true)
          }, [draft])
          // 发送（phase 离开 plain）→ 自动收起
          // (Auto-collapse once the draft enters the submit pipeline)
          const phase = useInput((s) => s.phase)
          React.useEffect(() => {
            if (phase !== 'plain') setHidden(true)
          }, [phase])

          if (!entry || hidden) return null

          return React.createElement('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              boxSizing: 'border-box',
              width: '100%',
              maxWidth: 'var(--dsh-composer-card-max-width)',
              margin: '0 auto',
              padding: '8px 12px',
              borderRadius: '10px',
              border: '1px dashed rgba(96,125,255,0.45)',
              background: 'rgba(96,125,255,0.06)',
              color: 'inherit',
              fontSize: '12px',
            },
          },
            React.createElement('div', {
              key: 'head',
              style: { display: 'flex', alignItems: 'center', gap: '8px' },
            },
              React.createElement('span', { style: { fontWeight: 600, fontSize: '12px', opacity: 0.9 } }, '📋 原文（优化前的输入框内容，仅作参考，不会随消息发送）'),
            ),
            React.createElement('div', {
              key: 'body',
              style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.5', opacity: 0.75 },
            }, entry.original),
          )
        },
      ))
    }

    module.exports = { name: 'prompt-optimizer-plugin', inject: ['slots'], apply }
    return module.exports
  },
})
