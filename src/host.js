/**
 * Prompt Optimizer — Host half（可安装 dsh bundle 形态，v7）
 * ==========================================================
 * 以普通 Loader 插件身份运行在 dsh profile 的 Host 进程里（不再是动态 cordis
 * 沙箱代码体）。加载时机由 Loader 控制，卸载时自动清理注册的路由。
 *
 * 暴露一个同源 HTTP 端点给浏览器端调用：
 *   POST /plugins/prompt-optimizer-plugin/optimize   body: { "text": "..." }
 * 流程：读当前默认模型（agentDefaultModel）→ llm.stream() 改写 → 返回 JSON：
 *   { ok: true, text } | { ok: false, error }
 *
 * 说明：静态插件不能新增 ctx.remote 命名空间（那是仓库内生成的 API 组装），
 * 因此 client→host 通信走 webserver 路由（与官方文档推荐、社区已验证的
 * 0.1.2-rc.1 树外双端 bundle 一致），不再是 v6 的 harness.handle / host.call。
 *
 * 版本：v7 — 与 v6 行为一致，仅传输层从动态 invoke 换成 HTTP 路由。
 */

/** 同源优化端点（与 client 半侧保持一致）。 */
const OPTIMIZE_PATH = '/plugins/prompt-optimizer-plugin/optimize'

/** 提示词优化专用 system 指令：要求模型直接输出优化后的提示词正文，不做任何解释。 */
const SYSTEM_PROMPT = [
  '你是一位专业的提示词（Prompt）优化专家。',
  '用户会给你一段原始提示词输入，请把它改写成一个更清晰、更具体、更有效的提示词。',
  '要求：',
  '1) 完整保留原意的所有要点，不丢失信息；',
  '2) 让指令更明确、目标更具体，可使用列表、分步骤等结构化表达；',
  '3) 如果需要，补充必要的约束、输出格式或上下文信息；',
  '4) 直接输出优化后的提示词正文本身，不要任何解释、前言、后记或代码块围栏；',
  '5) 使用与原文相同的语言；',
  '6) 无论原文是否包含明确的“请…”式指令，都必须输出一个可用的改写/润色版本；',
  '7) 严禁返回空内容、占位符（如“…”）或“无法优化/没有内容”之类的回复。',
].join('\n')

/** 请求体上限（64 KiB），防止异常客户端撑爆内存。 */
const MAX_BODY_BYTES = 64 * 1024

/** 写一个 JSON 响应（handler 拥有完整响应生命周期）。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body, 'utf8'),
  })
  res.end(body)
}

/** 读取并解析 JSON 请求体；空/超大/非法返回 null。 */
async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch (e) {
    return null
  }
}

/** 读当前「默认 Agent 模型」选择；拿不到返回 null。 */
function defaultModelOf(ctx) {
  const agentDefaultModel = ctx.get('agentDefaultModel')
  if (agentDefaultModel === undefined || typeof agentDefaultModel.currentSelection !== 'function') return null
  let sel
  try {
    sel = agentDefaultModel.currentSelection()
  } catch (e) {
    return null
  }
  if (sel !== null && typeof sel === 'object' && typeof sel.provider === 'string' && typeof sel.model === 'string') {
    return { provider: sel.provider, model: sel.model }
  }
  return null
}

/** 核心优化逻辑：用选中模型改写文本。空返回（finish 成功但无 text-delta）时给出可操作的提示。 */
async function runOptimize(ctx, text) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { ok: false, error: 'LLM 服务不可用' }
  }
  const selection = defaultModelOf(ctx)
  if (selection === null) {
    return { ok: false, error: '无法确定当前模型' }
  }
  try {
    let out = ''
    let finishKind = null
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      maxTokens: 1024,
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
        finishKind = reason && reason.kind ? reason.kind : null
        if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
          const fail = reason.failure
          return { ok: false, error: (fail && fail.message) || '模型调用失败' }
        }
      }
    }
    const optimized = out.trim()
    if (!optimized) {
      // 实测：当草稿只是陈述、没有可执行的“请…”指令（或内容被模型判定无
      // 任务可优化）时，模型会以成功 finish 返回空文本。提示用户补充目标
      // 即可，而不是让他们以为功能坏了。
      return {
        ok: false,
        error: '模型未返回有效内容：这段草稿缺少可执行的指令或目标（如“请帮我…”“改写成…”）。请在草稿中补充任务要求后重试，或把光标移到其他草稿上再点优化。'
          + `（模型：${selection.provider}/${selection.model}，finish=${finishKind ?? 'unknown'}）`,
      }
    }
    return { ok: true, text: optimized }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export const name = 'prompt-optimizer-plugin'

/**
 * 硬依赖：让 Loader 等到 webserver 服务就绪后再 apply（本 bundle 层加载早于
 * webserver 行；bundle 加载时 webServer 未就绪，直接注册会静默丢失路由）。
 * 其余服务（llm / agentDefaultModel）在每次请求时惰性读取。
 */
export const inject = ['webServer']

export function apply(ctx) {
  // 双保险：module 级 inject 之外再用 ctx.inject 等一次，保证注册发生在
  // webServer 服务可用之后（ctx.inject 在服务已就绪时同步执行）。
  ctx.inject(['webServer'], (web) => {
    const server = web.get('webServer')
    if (server === undefined || typeof server.register !== 'function') return

    const dispose = server.register({
      kind: 'exact',
      path: OPTIMIZE_PATH,
      handler: async (req, res) => {
        try {
          const payload = await readJsonBody(req)
          const text = payload !== null && typeof payload.text === 'string' ? payload.text : ''
          if (!text.trim()) {
            sendJson(res, 400, { ok: false, error: '输入为空' })
            return
          }
          const result = await runOptimize(ctx, text)
          // 业务失败仍以 200 应答：客户端按 { ok: false, error } 展示原因，
          // 避免把可读错误混入 fetch 的 HTTP 异常分支。
          sendJson(res, 200, result)
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    })

    ctx.effect(() => dispose, 'prompt-optimizer-plugin:optimize-route')
  })
}
