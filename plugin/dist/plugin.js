// dsh-paper-studio-v3 —— 论文插件 V3（免编译纯 ESM）
//
// 定位：把「论文方案」（＝论文框架 + 方法论 + 工作流）做成**对话驱动、无面板**的 DSH 插件。
// 设计硬约束（来自 references/plugin-spec-v3.md，用户口述）：
//   · **不要面板**（易崩难做）⇒ 本插件不注册任何客户端 Slot / 路由 / 前端资产。
//   · **双模式**：用户模式（默认，**封闭**：只能使用，不得改插件自带内容）· 开发者模式（对「进入论文插件开发者模式」开放）。
//   · **意图判断**：「启用论文插件」「帮我写论文」等触发；误启与漏启都要有夹具（见 selftest）。
//   · **五种模式**：全代写 / 共同创作 / 辅助创作 / 润色 / 其他 —— 选项大写 + 一行小字解释 + **行为差异化**（不是措辞差异）。
//   · **模型协议**：模式选择用宿主的 `ask_user_question`（原生可点击选项）呈现，**不打字**；插件只把菜单与判据交给模型。
//
// 与既有资产的边界：**不复制论文方案的判据**。一切判据、门、模板、体裁、预算都在
// `paper-studio` 的 `references/pipeline.json`（唯一真源），本插件只做**编排与桥接**。
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-paper-studio-v3'
export const inject = ['tools']

// ───────────────────────────── 路径解析 ─────────────────────────────

/** 定位 paper-studio 根（含 bin/studio.cjs 与 references/pipeline.json）。多候选，缺则明确报缺。 */
function resolveRoot() {
  // 顺序即优先级：**环境变量 → 用户目录下的标准安装位 → 本机开发默认（最后）**。
  // 把机器特定路径放最后：在别的机器上它只是"不存在"，不影响前面的候选。
  const cands = [
    process.env.DSH_PAPER_STUDIO_ROOT,
    join(homedir(), '.agents', 'skills', 'paper-studio'),
    join(homedir(), '.dsh', 'skills', 'paper-studio'),
    join(homedir(), 'paper-studio'),
    '/opt/paper-studio',
    'E:\\DeepSeek\\skills\\paper-studio',   // 本机开发默认（最后兜底）
  ].filter(Boolean)
  for (const c of cands) {
    try { if (existsSync(join(c, 'bin', 'studio.cjs')) && existsSync(join(c, 'references', 'pipeline.json'))) return c } catch { /* 继续找 */ }
  }
  return null
}

/** hub 目录：跨会话持久（开发模式开关、使用计数）。落用户目录，不落插件安装目录（升级不丢）。 */
function hubDir() {
  const d = process.env.DSH_PAPER_HUB || join(homedir(), '.dsh', 'paper-studio')
  try { mkdirSync(d, { recursive: true }) } catch { /* 只读环境 */ }
  return d
}
function statePath() { return join(hubDir(), 'state.json') }

/** 开发模式开关：**默认封闭**（读不到文件也算封闭 —— 失败方向必须安全）。 */
function readState() {
  try {
    const j = JSON.parse(readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, ''))
    return { sealed: j.sealed !== false, unlock_phrase: String(j.unlock_phrase || ''), unlocks: Number(j.unlocks || 0) }
  } catch { return { sealed: true, unlock_phrase: '', unlocks: 0 } }
}
function writeState(patch) {
  const next = { ...readState(), ...patch }
  try { writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8') } catch { /* 忽略 */ }
  return next
}

const DEVELOPER_PHRASE = '进入论文插件开发者模式'

// ───────────────────────────── CLI 桥接 ─────────────────────────────

/**
 * 跑 paper-studio CLI。返回 {ok, exit_code, stdout, stderr, cmd}，**绝不吞退出码**。
 *
 * ★ 为什么用**文件描述符捕获**而不是 `execFile` 的管道：实测在受限执行环境里，
 *   子进程的 **piped stdio 会打不开**（表现为 status=2 且 stdout/stderr 全空，极像"CLI 挂了"），
 *   而把子进程的 stdout/stderr 指到一个**文件 fd** 两端都能跑；顺带不再受 maxBuffer 限制。
 */
function runStudio(root, argv, cwd) {
  return new Promise((done) => {
    const cli = join(root, 'bin', 'studio.cjs')
    const log = join(tmpdir(), `paper-studio-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
    let fd
    try { fd = openSync(log, 'w') } catch (e) { return done({ ok: false, exit_code: 2, stdout: '', stderr: '无法创建捕获文件：' + String((e && e.message) || e), cmd: 'studio.cjs ' + argv.join(' ') }) }
    const settle = (code, spawnError) => {
      let text = ''
      try { closeSync(fd) } catch { /* 已关 */ }
      try { text = readFileSync(log, 'utf8') } catch { /* 读不到就空 */ }
      try { rmSync(log, { force: true }) } catch { /* 忽略 */ }
      const code2 = spawnError ? 2 : (typeof code === 'number' ? code : 1)
      done({ ok: code2 === 0, exit_code: code2, stdout: text, stderr: spawnError || '', cmd: 'studio.cjs ' + argv.join(' ') })
    }
    let child
    try {
      child = spawn(process.execPath, [cli, ...argv], { cwd: cwd || root, windowsHide: true, stdio: ['ignore', fd, fd] })
    } catch (e) { return settle(2, 'spawn 抛错：' + String((e && e.message) || e)) }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } settle(124, '超时（600 秒）') }, 600000)
    child.on('error', (e) => { clearTimeout(timer); settle(2, 'spawn 失败：' + String((e && e.message) || e)) })
    child.on('close', (code) => { clearTimeout(timer); settle(code, '') })
  })
}

// ───────────────────────────── 五种写作模式（行为差异，不是措辞差异）─────────────────────────────

/** 每个模式：给用户的一行小字 + **行为差异**（决定下一步问什么、谁做决定、产出边界）。 */
const MODES = [
  {
    key: 'full', label: '全代写模式',
    blurb: '你只给方向与目标（加作者/邮箱/单位），其余全部由插件与联网自行完成',
    behavior: '只问 4 项（方向/目标 + 作者 + 邮箱 + 单位）后**不再弹选项直接开写**；数据/材料/文献由插件自选；**必须告知：进不了实验室 ⇒ 不适合研发型或需自有实验数据的论文**',
    next_ask: ['题目或方向、目标（投什么刊/什么体裁）', '作者姓名', '通讯邮箱', '单位/机构'],
  },
  {
    key: 'co', label: '共同创作模式',
    blurb: '你给想法思路与作者信息；数据、图表、文献可由你提供，或由插件去找后再交你选',
    behavior: '**每步都有人为环节**：方向 → 数据来源（你给 / 我去取 / 你给我我去取）→ 图表（你给 / 我生成）→ 文献（我搜 → **你勾选**）；可做研发型创作',
    next_ask: ['方向与核心想法', '数据从哪来（三选一）', '图表谁做', '文献是否要我先搜再交你勾选'],
  },
  {
    key: 'assist', label: '辅助创作模式',
    blurb: '你出想法，插件给框架、思路与专业性意见，不代写',
    behavior: '**不产出正文**；产出＝框架 + 思路 + 专业意见（含风险与缺口清单）；交付物是「你该怎么写」而不是「我替你写了」',
    next_ask: ['想法与要解决的问题', '已有材料', '目标期刊/体裁', '最担心哪一块（决定意见的侧重点）'],
  },
  {
    key: 'polish', label: '润色模式',
    blurb: '你给已写好的论文，插件负责润色、修改，使其更完善更专业',
    behavior: '**只动表达与结构，不动研究内容本身**；产出＝改后稿 + **逐处改动理由**（走改动账本，缺 kind/reason 拒收）；不得改数据、结论、事实、引用对象',
    next_ask: ['稿子路径', '是中文转英文还是同语润色', '目标期刊的格式要求', '哪些段落不许动'],
  },
  {
    key: 'other', label: '其他',
    blurb: '不限思路，自由发挥，由当前对话的模型结合插件内容实时判断',
    behavior: '**不套固定流程**；由当前对话模型 + 插件素材**实时判断**怎么做；这是「不做选择题」的出口',
    next_ask: ['直接说你想要什么'],
  },
]

/** 交给模型的菜单协议：用 ask_user_question 呈现，每项一行小字；「其他」允许自由填写。 */
function modeMenu() {
  return {
    how_to_show: '用 ask_user_question 呈现（宿主原生可点击选项，用户不用打字）；每项 label 用大写模式名，description 用该模式的 blurb；multi_select=false',
    confirm_first: '若意图判断为「可能是论文请求但不确定」，先问一句确认，**不要**直接弹模式菜单（防误启）',
    options: MODES.map((m) => ({ label: m.label, description: m.blurb })),
    after_choice: '选定后**只按该模式的 next_ask 提问**（全代写只问 4 项后直接开写）；每个问题都给选项与一行解释；**收齐必要信息后先建目标再开写**（见 autonomy）',
    // ★ 自动推进（用户要求内置，2026-10-14）：把"写完"做成**持久目标**，这样不靠用户每步说「继续」。
    //   为什么放在插件协议里而不是只写文档：目标不建，长任务就会**每步停下等催**（实测发生过）。
    autonomy: {
      first: '收齐该模式要求的必要信息后，**第一件事是建持久目标**：调宿主的 create_goal，objective 写成「按 <模式> 把这篇论文写完并跑门交付」+ 收尾条件（例如"完成后停"）。',
      then: '此后**逐轮自动推进**：每轮至少落一个阶段（骨架 → 检索与核实 → 协议章节 → 正文各章 → 跑门 → 声明），并把进展落账；**不要**在阶段之间停下等用户说继续。',
      blocked: '只有当"继续"需要**用户才有的东西**（如作者/单位/邮箱、选刊、是否允许某类操作）时才停；停下时要**一次问清**、并说明其余部分我会继续做。',
      done: '全部阶段完成（含跑门与声明）后，把目标标记 complete 并给出最终交付与"未完成/做不到"清单。',
      why: '反面案例：长任务若无目标，写三步就停，用户要反复催「继续」——本项即为消除该摩擦而内置。',
    },
    differentiation: MODES.map((m) => ({ mode: m.label, 行为差异: m.behavior })),
  }
}

// ───────────────────────────── 意图判断（可机检）─────────────────────────────
//
// 为什么要有这段**确定性**判据：规格要求「意图判断有夹具（该启不启 / 不该启误启都测）」。
// 若意图判断只写在 SKILL.md 里靠模型自觉，就只能靠声明、**无法回归** ⇒ 把可判的部分做成纯函数 + 夹具。
// 分工：本函数判「**是不是论文请求**」（粗筛，宁可 need_clarify）；
//      五种模式的选择仍由模型用 `ask_user_question` 与用户交互决定（那是价值判断，不是字符串匹配）。

const PAPER_STRONG = [
  /启用论文插件/, /论文插件/, /帮我写论文/, /写(一篇|个)?论文/, /论文(写作|润色|修改|改稿|投稿|排版)/,
  /改(一下|改)?论文/, /润色(一下)?(这|该|本)?(篇)?(论文|稿件|摘要|引言|方法|讨论)/, /审稿(意见|回复|人)/,
  /rebuttal/i, /\bpaper\b/i, /\bmanuscript\b/i, /\babstract\b/i, /投稿(前|体检|准备)/, /参考文献(格式|规范)/,
  /(论文|稿件|手稿)(的)?(结构|框架|逻辑|贡献|创新点)/, /(摘要|引言|方法|结果|讨论|结论)(部分|这一节|怎么写)/,
]
const PAPER_NEGATIVE = [
  /写(一段|个|点)?代码/, /代码(审查|重构|审查)/, /写(一篇|个)?(小说|文案|朋友圈|周报|日报|邮件|简历|作文)/,
  /(股票|基金|选股|行情|K线)/, /(天气|路况|机票|酒店)/, /(翻译|总结)这篇(文章|新闻)/, /(爬虫|逆向|抓包)/,
  /(画|做)(一张|个)?(海报|logo|图标)/i,
]
const PAPER_WEAK = [/写/, /改/, /润色/, /结构/, /逻辑/, /意见/, /看看(我)?(这)段/, /给点(意见|建议)/]
const PAPER_CTX = [/论文/, /稿子?/, /手稿/, /初稿/, /定稿/, /草稿/, /摘要/, /引言/, /文献/, /投稿/, /期刊/, /\bpaper\b/i, /\bmanuscript\b/i, /这段(话|文字)/]
// ★ 夹具抓到的漏判：原来只认「润色 → 论文」这种**相邻词序**，而「这篇稿子帮我润色一下」是倒序 ⇒ 漏判。
//   改为**动作词 × 对象共现**（与词序无关），这才是该判据的正确抽象。
const PAPER_ACT = /(润色|修改|改写|改稿|校订|校对|翻译)/
const PAPER_OBJ = /(论文|稿子?|手稿|初稿|定稿|草稿|摘要|引言|文献|\bpaper\b|\bmanuscript\b)/i

/** 纯函数：判定一条用户消息是不是论文请求。返回 {is_paper, score, matched, need_clarify, reason}。 */
function classifyIntent(text) {
  const t = String(text || '')
  if (!t.trim()) return { is_paper: false, score: 0, matched: [], need_clarify: true, reason: '空输入 ⇒ 必须问，不要猜' }
  const neg = PAPER_NEGATIVE.find((r) => r.test(t))
  const strong = PAPER_STRONG.filter((r) => r.test(t)).map(String)
  const weak = PAPER_WEAK.filter((r) => r.test(t)).map(String)
  const ctx = PAPER_CTX.filter((r) => r.test(t)).map(String)
  const coOccur = PAPER_ACT.test(t) && PAPER_OBJ.test(t)   // 动作词 × 对象共现（与词序无关）
  let score = 0
  if (strong.length || coOccur) score = 3
  else if (weak.length && ctx.length) score = 2
  else if (ctx.length) score = 1
  else if (weak.length) score = 1                              // 只有动作词、没有对象 ⇒ **拿不准**（问一句），不是"不是"
  // **否定守卫优先**：这一条是"不该启误启"的夹具来源。
  const negWins = !!neg && !/论文|稿子?|手稿|paper|manuscript/i.test(t)
  const is_paper = !negWins && score >= 2
  const need_clarify = !negWins && score === 1
  return {
    is_paper, score, matched: { strong, weak, context: ctx, co_occurrence: coOccur, negative: neg ? [String(neg)] : [] }, need_clarify,
    reason: negWins ? `命中否定守卫（${neg}）且无论文语境 ⇒ 不启用`
      : coOccur ? '动作词与论文对象共现（与词序无关）'
        : score >= 3 ? '命中强触发（论文相关词）'
          : score === 2 ? '弱触发 + 论文语境共存'
            : score === 1 ? '只提到论文语境或只有动作词、缺对象 ⇒ 先问一句'
              : '没有论文迹象 ⇒ 不启用',
  }
}

/** 意图判据的夹具（**该启 / 不该启 / 拿不准**三类都要有）—— 被 selftest 与 action=intent 共用。 */
const INTENT_CASES = [
  { text: '启用论文插件', expect: 'paper' },
  { text: '帮我写论文', expect: 'paper' },
  { text: '这篇稿子帮我润色一下，投 Applied Intelligence', expect: 'paper' },
  { text: '审稿意见回来了，帮我写 rebuttal', expect: 'paper' },
  { text: '我这段引言逻辑不太顺，给点意见', expect: 'paper' },
  { text: '论文的贡献点怎么写得可数可核', expect: 'paper' },
  { text: '今天天气怎么样', expect: 'not' },
  { text: '帮我写一段代码实现快速排序', expect: 'not' },
  { text: '帮我写个周报', expect: 'not' },
  { text: '看看这只股票最近怎么样', expect: 'not' },
  { text: '帮我写个爬虫抓一下这个网站', expect: 'not' },
  { text: '论文', expect: 'clarify' },
  { text: '帮我改一下', expect: 'clarify' },
]


const STUDIO_ACTIONS = ['modes', 'intent', 'route', 'gates', 'intake', 'draft', 'scaffold', 'genre', 'sections', 'verify', 'stylecheck', 'polish', 'revise', 'figures', 'profile', 'coach', 'audit', 'state', 'lessons', 'method', 'handoff', 'crosscheck', 'docx', 'selftest']

const PAPER_STUDIO_TOOL = {
  name: 'paper_studio',
  description: '论文插件 V3 的唯一使用入口（用户模式）：① action=modes 取五种写作模式的菜单与差异化判据（**用 ask_user_question 呈现，不要打字**）；② action=intent 用**确定性判据**粗筛「这是不是论文请求」（配 text 参数；防误启，拿不准返回 need_clarify）；③ 其余 action 原样桥接已冻结的 paper-studio CLI（route/gates/intake/draft/verify/stylecheck/polish/revise/figures/profile/coach/audit/state…），把 stdout 与**退出码**一并返回。判据、门、模板、体裁、预算全在 paper-studio 的 references/pipeline.json（唯一真源），本插件不复制。用户模式下本工具**只能使用**，不能改插件自带内容。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: STUDIO_ACTIONS, description: '要执行的动作；modes 返回模式菜单，intent 判意图（需 text），其余桥接到 CLI 同名子命令' },
      args: { type: 'array', items: { type: 'string' }, description: '原样追加给 CLI 的参数（如 ["--file","稿.md","--genre","research"]），不经过再解释' },
      cwd: { type: 'string', description: 'CLI 的工作目录（默认 = paper-studio 根）；稿件在别处时传它，便于相对路径' },
      text: { type: 'string', description: 'action=intent 时要判定的用户原话' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

// ───────────────────────────── 工具 2：paper_dev（开发者模式）─────────────────────────────

/** 允许读写的资产根（相对 paper-studio 根）：**白名单**，其余一律拒。 */
const DEV_ROOTS = ['references', 'bin', 'SKILL.md', 'DESIGN.md', 'docs', 'plugin/dist', 'plugin/skill', 'plugin/hub', 'plugin/package.json', 'plugin/cordis.patch.yml']

const PAPER_DEV_TOOL = {
  name: 'paper_dev',
  description: '论文插件**开发者模式**（默认封闭）：list 按分类列出工作流/框架/模型/数据/脚本资产（带路径与一句话说明）· read 读某资产 · write 改某资产（**封闭时拒绝**，并给出解锁指引）· unlock 用用户原话「进入论文插件开发者模式」解锁 · seal 重新封闭 · status 看当前模式。写操作仅限白名单资产根内，越界（含 ../ 穿越）一律拒。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'list', 'read', 'write', 'unlock', 'seal'], description: '要执行的动作' },
      path: { type: 'string', description: '相对 paper-studio 根的资产路径（read/write 用），如 "references/pipeline.json"' },
      content: { type: 'string', description: '写入内容（write 用）' },
      phrase: { type: 'string', description: '用户原话（unlock 用）；必须与约定话术一致才解锁' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

// ───────────────────────────── 结果渲染 ─────────────────────────────

const textOut = (s) => [{ type: 'text', text: String(s) }]
const clip = (s, n = 12000) => (s.length > n ? s.slice(0, n) + `\n…（已截断，共 ${s.length} 字符；完整内容请用 args 缩小范围或读文件）` : s)

// ───────────────────────────── 插件入口 ─────────────────────────────

function applyInner(ctx) {
  const root = resolveRoot()
  const register = (spec) => { try { ctx.tools.register(spec) } catch { /* 保持插件可加载：注册失败不留半态 */ } }

  register({
    ...PAPER_STUDIO_TOOL,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' }, action: { type: 'string' }, exit_code: { type: 'integer' },
          stdout: { type: 'string' }, stderr: { type: 'string' }, note: { type: 'string' },
          menu: { type: 'object', description: 'action=modes 时的模式菜单协议' },
        },
        required: ['ok', 'action'],
        additionalProperties: false,
      },
      // ★ 兼容性设计（真机换来的）：`additionalProperties: false` 下**新增字段**必须等宿主**重新导入模块**才生效
      //   （实测：bundle 装载失败时 `set_bundle enabled=true` 会重新装载 ⇒ 当场生效；但**已装载**的模块不会重新导入）。
      //   所以 intent 的判定结果**放进已声明的 `note`**（字符串 + JSON 代码块）而不是新开字段 ⇒ 新旧 schema 都接受、改完当场可用。
      render: (_args, v) => textOut(v && v.menu ? JSON.stringify(v.menu, null, 2) : [(v && v.stdout) || '', v && v.stderr ? '\n[stderr]\n' + v.stderr : '', v && v.note ? '\n' + v.note : ''].join('')),
      // ★ 真机冒烟抓到的坑：宿主对 `presentationMeta` 做 lossless-JSON 校验，
      //   返回 `{ exitCode: undefined }` 会被判「non-lossless JSON」而整个工具调用失败。
      //   规则：**只放 JSON 可表示的值**；没有就不放这个键。同一份 meta 也供 presentResult 用。
      presentationMeta: (_a, v) => {
        const m = {}
        if (v && typeof v.exit_code === 'number') m.exitCode = v.exit_code
        const head = String((v && (v.stdout || v.stderr)) || '')
        if (head) m.head = head.slice(0, 4000)
        return m
      },
    },
    presentResult: (_args, res) => {
      const meta = (res && res.meta) || {}
      const out = { card: 'terminal', title: 'paper_studio', output: String(meta.head || '') }
      if (typeof meta.exitCode === 'number') out.exitCode = meta.exitCode
      return out
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args || {}
      const action = String(a.action || '')
      if (!STUDIO_ACTIONS.includes(action)) return { ok: false, action, note: `前提层错误：未知 action「${action}」；合法值：${STUDIO_ACTIONS.join('/')}` }
      if (action === 'modes') return { ok: true, action, menu: modeMenu() }
      if (action === 'intent') {
        const judge = classifyIntent(a.text)
        // 判定结果只放在已声明的 `note` 里（见 schema 处注释：新增字段要等模块重新导入，note 不必）
        const structured = '```json\n' + JSON.stringify(judge, null, 2) + '\n```'
        return { ok: true, action, note: judge.reason + (judge.need_clarify ? ' ⇒ **先问一句再决定**（不猜）' : '') + '\n' + structured }
      }
      if (!root) return { ok: false, action, note: '前提层错误：找不到 paper-studio 根（设 DSH_PAPER_STUDIO_ROOT，或把 paper-studio 放到 ~/.agents/skills/paper-studio）' }
      const extra = Array.isArray(a.args) ? a.args.map(String) : []
      const r = await runStudio(root, [action, ...extra], a.cwd)
      return { ok: r.ok, action, exit_code: r.exit_code, stdout: clip(r.stdout), stderr: clip(r.stderr), note: `$ ${r.cmd}` }
    },
  })

  register({
    ...PAPER_DEV_TOOL,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' }, sealed: { type: 'boolean' }, action: { type: 'string' },
          listing: { type: 'array', items: { type: 'object' } }, content: { type: 'string' },
          written: { type: 'string' }, note: { type: 'string' },
        },
        required: ['ok', 'sealed', 'action'],
        additionalProperties: false,
      },
      render: (_args, v) => textOut(
        v && v.listing ? v.listing.map((x) => `- ${x.path} — ${x.what}`).join('\n')
          : v && v.content ? v.content
            : (v && v.note) || '' ),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args || {}
      const st = readState()
      const action = String(a.action || '')
      const guide = '（进入开发者模式：在对话里说「' + DEVELOPER_PHRASE + '」，我会先弹出确认再解锁；用户模式下插件自带内容只读，这是设计如此，不是出错）'

      if (action === 'status') return { ok: true, sealed: st.sealed, action, note: st.sealed ? '当前：**用户模式**（封闭）' : '当前：**开发者模式**（已解锁）' }
      if (action === 'seal') { writeState({ sealed: true, unlock_phrase: '' }); return { ok: true, sealed: true, action, note: '已重新封闭（用户模式）' } }
      if (action === 'unlock') {
        const phrase = String(a.phrase || '').trim()
        if (phrase !== DEVELOPER_PHRASE) return { ok: false, sealed: true, action, note: `解锁失败：需要用户的明确原话「${DEVELOPER_PHRASE}」，当前给的是「${phrase || '（空）'}」` }
        writeState({ sealed: false, unlock_phrase: phrase, unlocks: st.unlocks + 1 })
        return { ok: true, sealed: false, action, note: `已进入开发者模式（第 ${st.unlocks + 1} 次）。可 list/read/write 白名单资产；改完请 action=seal 或让我跑 audit 自检` }
      }
      if (!root) return { ok: false, sealed: st.sealed, action, note: '前提层错误：找不到 paper-studio 根', }

      if (action === 'list') {
        const listing = []
        const describe = (p) => {
          if (/pipeline\.json$/.test(p)) return '唯一真源：任务类型/阶段/门/体裁/契约（判据只在这里）'
          if (/templates\.json$/.test(p)) return '模板与章节骨架（篇幅预算、必答问题、证据义务）'
          if (/lessons-from-first-draft\.md$/.test(p)) return '真教训库（L-1…），每条带出处与可否机检'
          if (/market-parity\.md$/.test(p)) return '市面对齐取证与缺口优先级'
          if (/plugin-spec-v3\.md$/.test(p)) return 'V3 规格真源（用户口述 + 设计决策）'
          if (/audit-.*\.md$/.test(p)) return '出厂审查报告（可复跑方法在其中）'
          if (/SKILL\.md$/.test(p)) return '技能说明：触发语、子命令用法、红线'
          if (/bin[\\/]/.test(p)) return '可执行脚本（门执行器、风格检查、润色、档案、教训、审查…）'
          return '插件资产'
        }
        const walk = (abs, rel) => {
          let entries = []
          try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue
            const r = rel ? rel + '/' + e.name : e.name
            const full = join(abs, e.name)
            if (e.isDirectory()) walk(full, r)
            else listing.push({ path: r, what: describe(r), what_bytes: (() => { try { return statSync(full).size } catch { return 0 } })() })
          }
        }
        for (const r of ['references', 'bin', 'SKILL.md']) walk(join(root, r), r)
        return { ok: true, sealed: st.sealed, action, listing, note: `共 ${listing.length} 个资产（白名单根：${DEV_ROOTS.join(' · ')}）` }
      }

      // read / write 都要先过白名单与穿越检查（**先判安全，再判模式**）
      const rel = String(a.path || '').replace(/\\/g, '/')
      if (!rel) return { ok: false, sealed: st.sealed, action, note: '前提层错误：read/write 需要 path' }
      const abs = resolve(root, rel)
      const insideRoot = abs === resolve(root) || abs.startsWith(resolve(root) + sep)
      const whitelisted = DEV_ROOTS.some((d) => rel === d || rel.startsWith(d + '/'))
      if (!insideRoot || !whitelisted) return { ok: false, sealed: st.sealed, action, note: `拒收：「${rel}」不在白名单资产根内（或试图越界）—— 白名单：${DEV_ROOTS.join(' · ')}` }

      if (action === 'read') {
        try { return { ok: true, sealed: st.sealed, action, content: clip(readFileSync(abs, 'utf8'), 20000), note: `读到 ${rel}（${st.sealed ? '用户模式：只读' : '开发者模式'}）` } }
        catch (e) { return { ok: false, sealed: st.sealed, action, note: '读失败：' + String((e && e.message) || e) } }
      }
      if (action === 'write') {
        if (st.sealed) return { ok: false, sealed: true, action, note: `**用户模式：写入被拒**（插件自带内容只读）${guide}` }
        if (typeof a.content !== 'string') return { ok: false, sealed: st.sealed, action, note: '前提层错误：write 需要 content（字符串）' }
        try {
          mkdirSync(dirname(abs), { recursive: true })
          const before = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
          writeFileSync(abs, a.content, 'utf8')
          return { ok: true, sealed: false, action, written: rel, note: `已写入 ${rel}（${before.length} → ${a.content.length} 字符）。建议随后跑 paper_studio action=audit 自检` }
        } catch (e) { return { ok: false, sealed: st.sealed, action, note: '写失败：' + String((e && e.message) || e) } }
      }
      return { ok: false, sealed: st.sealed, action, note: `前提层错误：未知 action「${action}」` }
    },
  })

  // 开发者模式的**写操作**再走一道原生审批（不可逆动作不靠自觉）——形状照官方范式，失败不影响插件加载。
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      const args = (exec && exec.arguments) || {}
      if (name !== 'paper_dev' || args.action !== 'write') return next && next()
      return { kind: 'ask', reason: 'paper_dev write 会改动插件自带资产', displayReason: `即将写入 ${args.path} —— 请确认这是你要的改动` }
    })
  } catch { /* 宿主未提供该事件时忽略 */ }
}

// ───────────────────────────── 入口（总兜底）─────────────────────────────
//
// ★ 为什么要有这一层：历史上（2026-10-13）插件抛错会把界面带崩（连续 6 次白屏）。
//   内部各处虽已各自 try/catch，但"**apply 永不向宿主抛错**"必须是**保证**而不是推理 ——
//   哪怕 ctx 形状异常（没有 tools / register 抛错 / 只读环境），也只降级为"本插件不工作"，绝不拖垮宿主。
export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (e) {
    try { console.error('[dsh-paper-studio-v3] apply 失败，已吞掉（不影响宿主）：' + String((e && e.message) || e)) } catch { /* 连 console 都不可用也认了 */ }
  }
}

// 导出给 selftest 用（不依赖宿主即可验证行为）
export const __test__ = { resolveRoot, hubDir, readState, writeState, modeMenu, MODES, STUDIO_ACTIONS, DEV_ROOTS, DEVELOPER_PHRASE, PAPER_STUDIO_TOOL, PAPER_DEV_TOOL, classifyIntent, INTENT_CASES }
