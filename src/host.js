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
 * 版本：v8 — v7 语义不变，新增“启用/停用”开关（方案 B，免重启）：
 * 状态持久化在 <dsh-home>/prompt-optimizer-state.json，可在
 * 设置 → 插件 → 提示词优化 Tab 切换；停用时 ✨ 关闭、不再调用模型。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 同源优化端点（与 client 半侧保持一致）。 */
const OPTIMIZE_PATH = '/plugins/prompt-optimizer-plugin/optimize'

/** 同源状态端点：GET 读启用状态；POST 写启用状态。 */
const STATE_PATH = '/plugins/prompt-optimizer-plugin/state'
const SET_STATE_PATH = '/plugins/prompt-optimizer-plugin/set-state'
const SETTINGS_PATH = '/plugins/prompt-optimizer-plugin/settings'

/** 同源只读端点：返回内置的默认优化指令（system prompt）。 */
const PROMPT_PATH = '/plugins/prompt-optimizer-plugin/prompt'

/** 解析 dsh home（env 优先，缺省用用户目录下的 .dsh）。 */
function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) return process.env.DSH_HOME.trim()
  const base = process.env.USERPROFILE || process.env.HOME || '.'
  return join(base, '.dsh')
}

const STATE_FILE = join(dshHome(), 'prompt-optimizer-state.json')

// ── 持久化 state：{ enabled, reasoningEffort?, maxTokens?, temperature? } ──
// 未显式保存的生成参数回落到 Loader 行 config（见 apply 里的 rowOpts），
// 行 config 又回落到内置 DEFAULTS——形成：UI 保存值 > profile patch > 内置默认。
// (Persisted UI overrides only; unset generation params fall back to the Loader
// row config, which in turn falls back to the built-in DEFAULTS)

function normalizeEffort(value, fallback) {
  return value === 'off' || value === 'low' || value === 'high' || value === 'max' ? value : fallback
}

function normalizeMaxTokens(value, fallback) {
  return Number.isSafeInteger(value) && value >= 64 ? value : fallback
}

function normalizeTemperature(value, fallback) {
  return typeof value === 'number' && value >= 0 && value <= 2 ? value : fallback
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return {}
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (raw === null || typeof raw !== 'object') return {}
    const state = {}
    if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled
    if (normalizeEffort(raw.reasoningEffort, null) !== null) state.reasoningEffort = raw.reasoningEffort
    if (normalizeMaxTokens(raw.maxTokens, null) !== null) state.maxTokens = raw.maxTokens
    if (normalizeTemperature(raw.temperature, null) !== null) state.temperature = raw.temperature
    if (typeof raw.prompt === 'string' && raw.prompt.trim() !== '' && raw.prompt.length <= MAX_PROMPT_BYTES) {
      state.prompt = raw.prompt
    }
    return state
  } catch (e) {
    return {}
  }
}

/** 把生效后的完整 settings 快照落盘（enabled、各参数与可选的 prompt 覆盖按当前内存值保存）。 */
function saveState(enabled, settings, promptOverride) {
  try {
    mkdirSync(dshHome(), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      enabled,
      ...settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...promptOverride === undefined ? {} : { prompt: promptOverride },
      savedAt: Date.now(),
    }), 'utf8')
  } catch (e) {
    // ignore: in-memory values still apply for this process
  }
}

/** 自定义指令长度上限（与请求体上限一致，留足余量）。 */
const MAX_PROMPT_BYTES = 32 * 1024

/** 校验自定义指令：合法则返回原值，否则 null。 */
function normalizePrompt(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (value.length > MAX_PROMPT_BYTES) return null
  return value
}

/** 内置优化指令模板（默认原典版，英文；设置页可用「恢复默认指令」回到本版）。 */
const SYSTEM_PROMPT = [
  'You are a professional prompt-optimization expert.',
  'You will be given an original prompt. Rewrite it into a clearer, more specific, and more effective prompt.',
  'Requirements:',
  '1) Preserve every point of the original meaning; do not lose information;',
  '2) Make the instructions clearer and the goals more specific; use lists, steps, or other structured formats when helpful;',
  '3) Add necessary constraints, output format, or context when needed;',
  '4) Output only the optimized prompt text itself—no explanations, prefaces, afterwords, or code fences;',
  '5) Use the same language as the original text;',
  '6) Only rewrite when there is real room for improvement: if the original is already a clear, specific, actionable prompt with nothing substantive to fix, return it verbatim; do not change things just for the sake of changing;',
  '7) If the original is not a prompt task (for example ordinary prose or casual content that cannot be improved), return it verbatim; do not invent instructions or content;',
  '8) Minimize changes: fix only genuine unclarity, incompleteness, or vagueness; keep the user\'s wording, structure, and intent; avoid pointless rewording;',
  '9) For identical input, keep the output stable; do not keep switching phrasing or structure;',
  '10) Never output empty content or replies like “cannot optimize/no content”—returning the original verbatim is a valid “no change” result.',
].join('\n')

/** 按请求语言（'en' | 'zh'）选择提示文案。 */
function pick(lang, zh, en) {
  return lang === 'en' ? en : zh
}

/** 从请求体提取语言标记（缺省中文）。 */
function langOf(payload) {
  return payload !== null && typeof payload === 'object' && payload.lang === 'en' ? 'en' : 'zh'
}

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

/**
 * 单次流式改写：累加正文与思考文本，记录 finish 原因。
 * reasoningEffort 显式传给适配器（'off' | 'low' | 'high' | 'max'）：
 * 提示词改写是聚焦重写任务，不需要深度推理；不传会让 API 侧自行深思考，
 * 既慢又会把输出额度吃光（finish=max-tokens、零正文）。默认关掉思考。
 */
async function streamOnce(llm, selection, text, maxTokens, temperature, reasoningEffort, systemPrompt) {
  let out = ''
  let reasoning = ''
  let finishKind = null
  let finishFailure = null
  const stream = llm.stream({
    provider: selection.provider,
    model: selection.model,
    maxTokens,
    temperature,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    system: systemPrompt,
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
    } else if (chunk.type === 'reasoning-delta') {
      reasoning += chunk.text
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason
      finishKind = reason && reason.kind ? reason.kind : null
      if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
        finishFailure = reason.failure
      }
    }
  }
  return { out, reasoning, finishKind, finishFailure }
}

/** 可配置项的默认值；可用 profile patch 按 id 覆盖（见 README）。 */
const DEFAULTS = Object.freeze({
  reasoningEffort: 'off',   // 提示词改写不需要深度推理：off 最快且不会耗尽额度
  maxTokens: 1500,          // 关掉思考后足够覆盖一次高质量改写
  temperature: 0.1,         // 低温 → 结果更稳定、可复现；想要更“有创意”再调高
})

/** 归一化空白后比较，判断模型是否实质上未改动原文（避免“硬优化”）。 */
function essentiallySame(optimized, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  return norm(optimized) === norm(text)
}

/**
 * 核心优化逻辑：用选中模型改写文本。
 * 用可配置的推理强度/额度/温度执行；遇 finish=max-tokens 空返回时自动扩容
 * 重试一次；最终失败按真实 finish 原因给出可操作提示。
 */
async function runOptimize(ctx, text, opts, systemPrompt, lang) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { ok: false, error: pick(lang, 'LLM 服务不可用', 'LLM service is unavailable') }
  }
  const selection = defaultModelOf(ctx)
  if (selection === null) {
    return { ok: false, error: pick(lang, '无法确定当前模型', 'Unable to determine the current model') }
  }
  const reasoningEffort = opts.reasoningEffort
  const maxTokens = opts.maxTokens
  const temperature = opts.temperature
  try {
    // 首轮用配置额度；max-tokens 空返回时第二轮扩容重试（兜底）。
    const attempts = [
      { maxTokens },
      { maxTokens: Math.max(maxTokens * 4, 8192) },
    ]
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]
      const r = await streamOnce(llm, selection, text, attempt.maxTokens, temperature, reasoningEffort, systemPrompt)
      const optimized = r.out.trim()
      if (optimized) {
        // 模型判断“无需优化”时会把原文原样返回：标记 unchanged，让客户端
        // 提示用户而不是替换草稿（也避免撤销栈被“无改动”污染）。
        if (essentiallySame(optimized, text)) {
          return { ok: true, text: text, unchanged: true }
        }
        return { ok: true, text: optimized }
      }
      if (r.finishKind === 'error' || r.finishKind === 'aborted') {
        const fail = r.finishFailure
        return { ok: false, error: (fail && fail.message) || pick(lang, '模型调用失败', 'Model call failed') }
      }
      if (r.finishKind === 'max-tokens' && i < attempts.length - 1) {
        // 额度耗尽且零正文：扩容重试
        continue
      }
      // 最终失败：按真实原因给提示
      const modelTag = pick(lang,
        `（模型：${selection.provider}/${selection.model}，reasoningEffort=${reasoningEffort ?? 'unset'}，finish=${r.finishKind ?? 'unknown'}）`,
        `(model: ${selection.provider}/${selection.model}, reasoningEffort=${reasoningEffort ?? 'unset'}, finish=${r.finishKind ?? 'unknown'})`)
      if (r.finishKind === 'max-tokens') {
        return {
          ok: false,
          error: pick(lang,
            '模型在输出正文前耗尽了输出额度（finish=max-tokens'
              + (r.reasoning.trim() ? `，本次思考约 ${r.reasoning.length} 字符` : '')
              + '）。已自动扩容重试仍失败：请在设置中把思考强度调高（low/high）或增大 maxTokens。' + modelTag,
            'The model exhausted its output budget before producing text (finish=max-tokens'
              + (r.reasoning.trim() ? `, ~${r.reasoning.length} characters spent on reasoning` : '')
              + '). An automatic retry with a larger budget still failed: raise the reasoning effort (low/high) or increase maxTokens in Settings. ' + modelTag),
        }
      }
      // finish=stop（或未知）且零正文：无指令/无任务类草稿
      return {
        ok: false,
        error: pick(lang,
          '模型未返回有效内容：这段草稿缺少可执行的指令或目标（如“请帮我…”“改写成…”）。请在草稿中补充任务要求后重试。' + modelTag,
          'The model returned no usable content: this draft lacks an actionable instruction or goal (e.g. “Please help me to…”, “Rewrite it as…”). Add a clear task to the draft and try again. ' + modelTag),
      }
    }
    return { ok: false, error: pick(lang, '模型未返回有效内容', 'The model returned no usable content') }
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

/**
 * 插件配置（可选，loader 传入 apply 的第二参）。当前运行形态默认全部使用
 * DEFAULTS；想调整可在 profile 的 cordis.patch.yml 里按 id 覆盖本行并给
 * config（见 README「可调参数」）。字段做宽松校验，非法时回退默认值。
 */
function resolveConfig(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const reasoningEffort = cfg.reasoningEffort === 'low' || cfg.reasoningEffort === 'high'
    || cfg.reasoningEffort === 'max' || cfg.reasoningEffort === 'off'
    ? cfg.reasoningEffort : DEFAULTS.reasoningEffort
  const maxTokens = Number.isSafeInteger(cfg.maxTokens) && cfg.maxTokens >= 64
    ? cfg.maxTokens : DEFAULTS.maxTokens
  const temperature = typeof cfg.temperature === 'number' && cfg.temperature >= 0 && cfg.temperature <= 2
    ? cfg.temperature : DEFAULTS.temperature
  return { reasoningEffort, maxTokens, temperature }
}

export function apply(ctx, config) {
  const rowOpts = resolveConfig(config)
  // 运行态 state：持久化 UI 覆盖值（enabled 默认开；生成参数缺省→回落行 config）
  const state = loadState()
  const enabledOf = () => state.enabled === false ? false : true
  // 生效参数 = UI 保存值（优先）→ 行 config → DEFAULTS
  const effectiveOf = () => ({
    reasoningEffort: state.reasoningEffort !== undefined ? state.reasoningEffort : rowOpts.reasoningEffort,
    maxTokens: state.maxTokens !== undefined ? state.maxTokens : rowOpts.maxTokens,
    temperature: state.temperature !== undefined ? state.temperature : rowOpts.temperature,
  })
  // 生效指令 = UI 自定义（优先）→ 内置默认优化指令
  const promptOf = () => state.prompt !== undefined ? state.prompt : SYSTEM_PROMPT
  const snapshot = () => ({ enabled: enabledOf(), settings: effectiveOf() })
  // 双保险：module 级 inject 之外再用 ctx.inject 等一次，保证注册发生在
  // webServer 服务可用之后（ctx.inject 在服务已就绪时同步执行）。
  ctx.inject(['webServer'], (web) => {
    const server = web.get('webServer')
    if (server === undefined || typeof server.register !== 'function') return

    const disposers = []

    // 优化端点（停用时拒绝调用，避免误触产生模型费用）
    disposers.push(server.register({
      kind: 'exact',
      path: OPTIMIZE_PATH,
      handler: async (req, res) => {
        try {
          const payload = await readJsonBody(req)
          const lang = langOf(payload)
          if (!enabledOf()) {
            sendJson(res, 200, {
              ok: false,
              error: pick(lang, '插件已停用：请到 设置 → 插件 → 提示词优化 开启后再试', 'Plugin is disabled: enable it under Settings → Plugins → Prompt Optimizer first'),
            })
            return
          }
          const text = payload !== null && typeof payload.text === 'string' ? payload.text : ''
          if (!text.trim()) {
            sendJson(res, 400, { ok: false, error: pick(lang, '输入为空', 'Input is empty') })
            return
          }
          const result = await runOptimize(ctx, text, effectiveOf(), promptOf(), lang)
          // 业务失败仍以 200 应答：客户端按 { ok: false, error } 展示原因，
          // 避免把可读错误混入 fetch 的 HTTP 异常分支。
          sendJson(res, 200, result)
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }))

    // 读启用状态与生效参数
    disposers.push(server.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        const snap = snapshot()
        sendJson(res, 200, { ok: true, enabled: snap.enabled, settings: snap.settings })
      },
    }))

    // 写启用状态（免重启生效；供 设置 → 插件 → 提示词优化 的开关调用）
    disposers.push(server.register({
      kind: 'exact',
      path: SET_STATE_PATH,
      handler: async (req, res) => {
        try {
          const payload = await readJsonBody(req)
          state.enabled = payload !== null && payload.enabled === true
          saveState(state.enabled, effectiveOf(), state.prompt)
          const snap = snapshot()
          sendJson(res, 200, { ok: true, enabled: snap.enabled, settings: snap.settings })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }))

    // 优化指令：GET 读当前生效指令（含是否自定义）；POST 保存自定义或 reset 恢复默认
    disposers.push(server.register({
      kind: 'exact',
      path: PROMPT_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '方法不支持 / Method not supported' })
            return
          }
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, prompt: promptOf(), isCustom: state.prompt !== undefined })
            return
          }
          const payload = await readJsonBody(req)
          const lang = langOf(payload)
          if (payload === null) throw new Error(pick(lang, '请求体格式错误', 'Invalid request body'))
          if (payload.reset === true) {
            delete state.prompt
            saveState(enabledOf(), effectiveOf(), state.prompt)
            sendJson(res, 200, { ok: true, prompt: promptOf(), isCustom: false })
            return
          }
          const next = normalizePrompt(payload.prompt)
          if (next === null) throw new Error(pick(lang, '指令内容不能为空（最多 32 KiB）', 'The instruction must not be empty (max 32 KiB)'))
          if (next === SYSTEM_PROMPT) {
            // 与内置默认完全相同 → 视为未自定义：清掉覆盖，保持“默认版”状态
            // （修复：恢复默认后即使再点“保存指令”，也不该变成“自定义版本”）
            delete state.prompt
            saveState(enabledOf(), effectiveOf(), state.prompt)
            sendJson(res, 200, { ok: true, prompt: SYSTEM_PROMPT, isCustom: false })
            return
          }
          state.prompt = next
          saveState(enabledOf(), effectiveOf(), state.prompt)
          sendJson(res, 200, { ok: true, prompt: state.prompt, isCustom: true })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }))

    // 更新生成参数（reasoningEffort / maxTokens / temperature，支持部分更新；
    // reset:true 清空 UI 覆盖、回落到 profile patch / 内置默认）
    disposers.push(server.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: async (req, res) => {
        try {
          const payload = await readJsonBody(req)
          const lang = langOf(payload)
          if (payload === null) throw new Error(pick(lang, '请求体格式错误', 'Invalid request body'))
          if (payload.reset === true) {
            delete state.reasoningEffort
            delete state.maxTokens
            delete state.temperature
          } else {
            if (payload.reasoningEffort !== undefined) {
              state.reasoningEffort = normalizeEffort(payload.reasoningEffort, rowOpts.reasoningEffort)
            }
            if (payload.maxTokens !== undefined) {
              state.maxTokens = normalizeMaxTokens(payload.maxTokens, rowOpts.maxTokens)
            }
            if (payload.temperature !== undefined) {
              state.temperature = normalizeTemperature(payload.temperature, rowOpts.temperature)
            }
          }
          saveState(enabledOf(), effectiveOf(), state.prompt)
          const snap = snapshot()
          sendJson(res, 200, { ok: true, enabled: snap.enabled, settings: snap.settings })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }))

    ctx.effect(() => () => { for (const d of disposers) { try { d() } catch (e) { /* best effort */ } } },
      'prompt-optimizer-plugin:routes')
  })
}
