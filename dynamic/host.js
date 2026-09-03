/**
 * Prompt Optimizer - Host half (Host 端)
 * ======================================
 * 动态 Cordis 插件的 Host 部分：注册「prompt-opt」RPC，
 * 读取当前会话选中的模型，通过 llm.stream() 调用大模型优化提示词，
 * 只返回优化后的纯文本。
 *
 * 版本：v6（pkg-6）— 与 DSH 动态插件 prpt-1/pkg-6 源码一致
 * 用法：作为 cordis_define 的 code.host 传入（plain JS function body，返回 Plugin 对象）
 */

return {
  apply(ctx) {
    // 提示词优化专用 system 指令：要求模型直接输出优化后的提示词正文，不做任何解释
    // (Prompt-optimization system instruction: output only the refined prompt text, no commentary)
    const SYSTEM_PROMPT = [
      '你是一位专业的提示词（Prompt）优化专家。',
      '用户会给你一段原始提示词输入，请把它改写成一个更清晰、更具体、更有效的提示词。',
      '要求：',
      '1) 完整保留原意的所有要点，不丢失信息；',
      '2) 让指令更明确、目标更具体，可使用列表、分步骤等结构化表达；',
      '3) 如果需要，补充必要的约束、输出格式或上下文信息；',
      '4) 直接输出优化后的提示词正文本身，不要任何解释、前言、后记或代码块围栏；',
      '5) 使用与原文相同的语言。',
    ].join('\n')

    // 注册 Client 可调用的 RPC：优化一段提示词文本
    // (Register the Client-callable RPC that optimizes one prompt text)
    harness.handle('prompt-opt', async (args) => {
      const text = args && typeof args.text === 'string' ? args.text : ''
      if (!text.trim()) return { ok: false, error: '输入为空' }

      const llm = ctx.get('llm')
      if (llm === undefined) return { ok: false, error: 'LLM 服务不可用' }

      // 读取当前会话选中的 provider/model
      // (Read the current session model selection)
      let provider, model
      const agentDefaultModel = ctx.get('agentDefaultModel')
      if (agentDefaultModel !== undefined) {
        const sel = agentDefaultModel.currentSelection()
        if (sel && sel.provider && sel.model) {
          provider = sel.provider
          model = sel.model
        }
      }
      if (!provider || !model) return { ok: false, error: '无法确定当前模型' }

      try {
        let out = ''
        const stream = llm.stream({
          provider,
          model,
          maxTokens: 700,
          temperature: 0.3,
          system: SYSTEM_PROMPT,
          messages: [{
            id: 'prompt-opt-' + Math.random().toString(36).slice(2),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'prompt-optimizer' },
          }],
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') {
            out += chunk.text
          } else if (chunk.type === 'finish') {
            const reason = chunk.reason
            if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
              const fail = reason.failure
              return { ok: false, error: (fail && fail.message) || '模型调用失败' }
            }
          }
        }
        const optimized = out.trim()
        if (!optimized) return { ok: false, error: '模型未返回有效内容' }
        return { ok: true, text: optimized }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })
  },
}