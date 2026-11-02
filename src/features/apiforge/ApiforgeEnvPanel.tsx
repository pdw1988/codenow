/**
 * APIForge 环境配置面板，技术方案 §2.7。
 *
 * 密码只在内存（store 不持久化），连库复用「我的连接」+ openLiveSession ——
 * 不另写一套连接逻辑（技术方案「共享层」约束）。
 */
import { useCallback, useEffect, useMemo, useState, type ClipboardEventHandler } from 'react'
import { App as AntdApp } from 'antd'
import { Band, Btn, Cb, Fld, Hint, Lbl, Row, Sel, Stack } from '../../components/ui'
import { useApiforgeStore } from '../../store/useApiforgeStore'
import { useDbConnStore } from '../../store/useDbConnStore'
import { useDbPassStore } from '../../store/useDbPassStore'
import { useUiStore } from '../../store/useUiStore'
import { openLiveSession } from '../../lib/dbLive'
import { sessionMismatch } from '../../lib/apiforge/dbSession'
import { credErr, loadPass } from '../../lib/dbCred'
import { canPersistPass, dbKindOf, type DbConn } from '../../types/dbconn'
import { isTauri } from '../../storage'
import { configToYml, type CiReportFormat } from '../../lib/apiforge/ci/config'
import { describeOrder, effectiveMethodOrder, normalizeMethodOrder } from '../../lib/apiforge/runner/order'
import { maskToken, parseAuthPaste } from '../../lib/apiforge/http/parseTokenText'
import type { AssertMode, EnvProfile } from '../../lib/apiforge/types'
import { ENV_PROFILES_MAX, evictedBy } from '../../lib/apiforge/envProfiles'
import { checkBrowser } from '@pro'
import { pageCredDelete, pageCredGet, pageCredSet } from '../../lib/apiforge/page/pageCred'
import { download } from './download'
import { ApfFold, ChoiceCards, type ChoiceCardItem } from './apiforgeBits'
import {
  ADVANCED_TOGGLE_SHOWN,
  ASSERT_MODE_SHOWN,
  METHOD_ORDER_SHOWN,
  scanKinds,
  soloVueId,
  viewShown,
} from '../../lib/apiforge/views'

/** CI/CD 折叠暂时藏起（用户 2026-10-20：已有功能跑细了再放出来） */
const CI_SHOWN: boolean = false

const TIMEOUT_DEFAULT = 10000
const TIMEOUT_MIN = 1000

/** 超时输入：打字时允许暂时为空，失焦再校验——空或非法回 10000，小于 1000 抬到 1000 */
function TimeoutField({ value, onCommit }: { value: number; onCommit: (ms: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(String(value))
  }
  const commit = () => {
    const n = Math.round(Number(draft))
    const ms = draft.trim() && Number.isFinite(n) && n > 0 ? Math.max(TIMEOUT_MIN, n) : TIMEOUT_DEFAULT
    setDraft(String(ms))
    if (ms !== value) onCommit(ms)
  }
  return (
    <Fld
      className="apf-env-narrow"
      type="number"
      min={TIMEOUT_MIN}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

export function ApiforgeEnvPanel() {
  const { message } = AntdApp.useApp()
  const env = useApiforgeStore((s) => s.env)
  const patchEnv = useApiforgeStore((s) => s.patchEnv)
  const learnedN = Object.keys(useApiforgeStore((s) => s.learnedExpectations)).length
  const conns = useDbConnStore((s) => s.items)
  const reloadConns = useDbConnStore((s) => s.reload)
  const dbSession = useUiStore((s) => s.dbSession)
  const setDbSession = useUiStore((s) => s.setDbSession)
  const [connecting, setConnecting] = useState(false)
  /** 连接时用的密码：跟 env.password 分开，避免顺手把登录密码当成库密码 */
  const [dbPassword, setDbPassword] = useState('')

  /**
   * 选中连接 / 首屏把记住的密码回填进密码框。
   *
   * 本页文案一直写着「密码可以记进系统凭据（我的连接页），这里每次现输也行」，
   * 但代码从来没接 loadPass——在「我的连接」勾过记住的用户，每次开应用、每次切
   * 连接都还得重打一遍。口径跟 DbConnect.fillFrom 一致：进程里这次记住的先用，
   * 没有再问本机凭据，且只有非生产才问（生产不记是老规矩，loadPass 内部分闸）。
   * 读失败只 warning 不吞——不然用户以为没存上，其实是读不出来。
   */
  const fillPass = useCallback((c: DbConn) => {
    const mem = useDbPassStore.getState().peek(c)
    if (mem) {
      setDbPassword(mem)
      return
    }
    if (!canPersistPass(c.env) || !isTauri()) return
    void loadPass(c, c.env)
      .then((p) => {
        if (p) setDbPassword(p)
      })
      .catch((e) => {
        void message.warning(`读不出记住的密码：${credErr(e)}`)
      })
  }, [message])

  useEffect(() => {
    // 首屏回填：env blob 里存着上次选的连接，连接列表到了才有得填（reloadConns
    // 是 async 的）。.then 回调里 setState，不在 effect 体内同步 set——oxlint 的
    // react(set-state-in-effect) 不拦这条。
    void reloadConns().then(() => {
      const c = useDbConnStore.getState().items.find((x) => x.id === useApiforgeStore.getState().env.connId)
      if (c) fillPass(c)
    })
  }, [reloadConns, fillPass])

  const selectedConn = conns.find((c) => c.id === env.connId) ?? null
  /** 连着的不是下拉里选的那条：跑用例时按未连库处理，这里得说清楚 */
  const mismatch = sessionMismatch(dbSession, env.connId)
  const liveSession = mismatch ? null : dbSession

  const connect = async () => {
    const conn = conns.find((c) => c.id === env.connId)
    if (!conn) {
      void message.warning('先选一条「我的连接」')
      return
    }
    setConnecting(true)
    try {
      await openLiveSession(conn, dbPassword)
      void message.success(`已连接 ${dbKindOf(conn.kind).toUpperCase()}，接口调试会自动对比数据库变化`)
    } catch (e) {
      void message.error(String(e))
    } finally {
      setConnecting(false)
    }
  }

  // 折叠头上的当前值摘要：折起 ≠ 看不见配置了什么。只数真补了值的——
  // 字段名打了值还没写的行不进计数（那一行只是编辑中的痕迹）
  const manualN = Object.values(env.sampleValues ?? {}).filter((v) => v.trim()).length
  const varN = Object.entries(env.vars ?? {}).filter(([, v]) => v.trim()).length
  const profileN = useApiforgeStore((s) => s.envProfiles).length
  const showAdvanced = useApiforgeStore((s) => s.showAdvanced)
  // 纯页面工程藏接口那套（登录接口、连库、数据准备…），纯接口藏页面测试；没扫描全显示
  const scan = useApiforgeStore((s) => s.scan)
  const kinds = useMemo(() => scanKinds(scan), [scan])
  const apis = kinds.apis
  // 只数当前扫描里的工程：projectBaseUrls 还存着以前扫过的别的目录，跟这次无关
  const overrideN = (scan?.projects ?? []).filter((p) => env.projectBaseUrls?.[p.projectId]?.trim()).length
  // FTL 页面没单独配地址时用默认 Base URL、用「页面测试」里的工号；Vue 工程两样都在按工程覆盖里
  const ftlPages = !scan || scan.projects.some((p) => !p.vue && (p.pages ?? []).length > 0)
  // 只有一个 Vue 工程：跟 FTL 一样用默认 Base URL，工号放「页面测试」里
  const soloVue = useMemo(() => {
    const id = soloVueId(scan)
    const p = id ? scan?.projects[0] : undefined
    return p?.vue ? { projectId: p.projectId, defaultUser: p.vue.defaultUser } : null
  }, [scan])
  // 单个工程用默认地址就够；填过覆盖的照常显示，免得藏起来还在生效
  const perProject =
    !scan ||
    scan.projects.length > 1 ||
    (scan.projects.some((p) => p.vue) && !soloVue) ||
    overrideN > 0
  // 别的页点「去设置」跳来：只在打开时取一次，展开对应折叠并滚过去
  const [focusAt] = useState(() => useApiforgeStore.getState().envFocus)
  useEffect(() => {
    if (!focusAt) return
    document.getElementById(`apf-env-${focusAt}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    useApiforgeStore.getState().setEnvFocus(null)
  }, [focusAt])

  return (
    <Stack className="apf-envform">
      {apis && ADVANCED_TOGGLE_SHOWN && (
      <div className="apf-advtoggle">
        <Cb checked={showAdvanced} onChange={(on) => useApiforgeStore.getState().setShowAdvanced(on)}>
          显示高级功能
        </Cb>
        <Hint>
          只跑查询接口。关着时不显示，全部接口都跑；存过的内容都在。
        </Hint>
      </div>
      )}

      {/* ── 第一层 · 主链路：地址 → 登录 → 连库。这三块配好就能跑，常驻平铺 ── */}
      {(apis || ftlPages || !!soloVue) && (
      // 按工程那栏藏了时，「去设置」跳到这里
      <div id={perProject ? undefined : 'apf-env-baseUrl'}>
        <Lbl>Base URL（默认服务根地址）</Lbl>
        <Fld
          value={env.baseUrl}
          onChange={(e) => patchEnv({ baseUrl: e.target.value })}
          placeholder="http://localhost:8080"
          big
        />
      </div>
      )}

      {apis && (
      <>
      {/* 认证只留粘 Token：登录接口、JSONPath、头名 / 前缀都不让选，粘整行请求头自动认 */}
      <div id="apf-env-auth">
        <ManualTokenRow />
        <Hint>浏览器登录系统后按 F12，在任一接口请求里复制带 Token 的那一行请求头（如 Authorization: Bearer xxx）整行粘进来。过期了再粘一次。接口不校验登录（如直连服务端口）就留空。</Hint>
      </div>

      <div>
        <Lbl>数据库验证连接（复用「我的连接」）</Lbl>
        {/* 一条连接都没存时下拉是空的，给条去处，别让人对着空框找 */}
        {conns.length === 0 ? (
        <Row>
          <Hint>还没有保存的连接。先去「我的连接」新建一条再回来选；不连库也能跑，只是不比对数据库变化。</Hint>
          <Btn onClick={() => useUiStore.getState().setActiveTab('dbconns')}>去新建连接</Btn>
        </Row>
        ) : (
        <Row>
          <Sel
            value={env.connId}
            onChange={(connId) => {
              patchEnv({ connId })
              // 选「不连库」就真断开会话，否则跑用例还会拿旧连接比对
              if (!connId) setDbSession(null)
              const c = conns.find((x) => x.id === connId)
              // 切连接跟着换密码框：换一条没记住过的连接还留着你上一条的密码，
              // 连错了只会报「认证失败」，白排查一轮
              if (c) fillPass(c)
              else setDbPassword('')
            }}
            options={[
              { value: '', label: dbSession ? '不连库（只看 HTTP）' : '选择连接…' },
              ...conns.map((c) => ({
                value: c.id ?? '',
                label: `${c.name || c.host}${c.db ? `/${c.db}` : ''}（${dbKindOf(c.kind)}）`,
              })),
            ]}
          />
          <Fld
            type="password"
            value={dbPassword}
            onChange={(e) => setDbPassword(e.target.value)}
            placeholder="库密码（记住过的会自动回填）"
          />
          <Btn variant="primary" onClick={() => void connect()} disabled={connecting}>
            {connecting ? '连接中…' : dbSession ? '重连' : '连接并读取'}
          </Btn>
        </Row>
        )}
      </div>
      {liveSession && <Hint>✓ 已连 {liveSession.kind.toUpperCase()}，跑用例会对比数据库变化</Hint>}
      {selectedConn && !dbSession && (
        <Band tone="warn" title="还没连上库">
          点「连接并读取」；不连也能跑，只是不比对数据库。
        </Band>
      )}
      {mismatch && selectedConn && (
        <Band tone="warn" title="已连的是另一条连接">
          点「重连」连上选中的这条，不然跑用例不比对数据库。
        </Band>
      )}
      </>
      )}

      {/* ── 第二层 · 细节折叠：环境组在最前（它一切换，下面所有折叠的值都会跟着变） ── */}
      <div className="apf-env-sec">更多设置</div>
      <div className="apf-env-folds">
      <ApfFold title="环境组" summary={profileN ? `${profileN} 组` : undefined}>
        <EnvGroupRows />
        <Hint>把当前整套配置存成一组，点组名切换。密码不保存；切换后 Token 要重新粘。</Hint>
      </ApfFold>

      {/* ── 第二层 · 细节折叠：数据准备默认全自动，出问题才需要打开这里 ── */}
      {apis && (
      <ApfFold
        title="数据准备"
        summary={!env.autoPrepare ? '已关' : `自动${manualN ? ` · 补值 ${manualN} 项` : ''}`}
      >
        <Cb checked={!!env.autoPrepare} onChange={(on) => patchEnv({ autoPrepare: on })}>
          跑之前自动准备数据
        </Cb>
        <Hint>
          查询接口先借库里现成的一行回填 id，借不到再造；改 / 删接口先造一行给它改。跑完只删自己造的。
          只给正常用例准备，每一步记在数据日志里。连上库才生效。
        </Hint>

        <div>
          <Lbl>手工补值</Lbl>
          <ManualValueRows />
          <Hint>
            程序造不出来的值（别的服务生成的 id、缓存里的值）按「字段名 + 值」补上，只对正常用例生效。
            字段名填接口的参数名或 body 字段名；跟接口对不上时，数据日志会提醒。
          </Hint>
        </div>
      </ApfFold>
      )}

      {/* 变量只给场景 / 数据驱动用，两页藏着时跟着藏 */}
      {showAdvanced && viewShown('scenario', kinds) && (
        <ApfFold title="变量" summary={varN ? `${varN} 项` : '未配置'}>
          <EnvVarRows />
          <Hint>在场景和数据驱动里用 {'{{变量名}}'} 引用。变量会保存到本机，别放密码。</Hint>
        </ApfFold>
      )}

      {apis && (
        <ApfFold title="请求超时" summary={`${env.timeoutMs} ms`}>
          <TimeoutField value={env.timeoutMs} onCommit={(ms) => patchEnv({ timeoutMs: ms })} />
          <Hint>单位毫秒，默认 10000。接口慢、一跑就超时再调大。</Hint>
        </ApfFold>
      )}

      {apis && showAdvanced && ASSERT_MODE_SHOWN && (
        <ApfFold
          title="进阶：断言严格度"
          summary={env.assertMode === 'observe' ? '观察（默认）' : learnedN ? `严格 · ${learnedN} 条期望` : '严格'}
        >
          <ChoiceCards<AssertMode>
            label="断言严格度"
            items={ASSERT_MODES}
            value={env.assertMode}
            onChange={(assertMode) => patchEnv({ assertMode })}
          />
          <Hint>
            库变更期望不用手填：先在观察模式下跑一场，报告页会把稳定的变更学成期望（如 t_user +1），采纳后随
            apiforge.yml 导出给 CI。
          </Hint>
        </ApfFold>
      )}

      {/* ── 第三层 · 特殊形态才需要：多工程端口差异 / 顺序编排 / CI 无头 ── */}
      {kinds.pages && (
        <div id="apf-env-pageTest">
          <PageTestFold defaultOpen={focusAt === 'pageTest'} login={ftlPages} soloVue={soloVue} />
        </div>
      )}

      {perProject && (
      <div id="apf-env-baseUrl">
        <ApfFold
          title="按工程覆盖 Base URL"
          summary={overrideN ? `${overrideN} 个工程已覆盖` : '全部用默认地址'}
          // 纯 Vue 工程地址和工号只在这里配，默认展开
          defaultOpen={focusAt === 'baseUrl' || (!apis && !ftlPages)}
        >
          <ProjectBaseUrlOverrides />
        </ApfFold>
      </div>
      )}

      {apis && showAdvanced && (
        <ApfFold title="只跑查询接口" summary={env.readOnlyRun ? '已开' : '关（全部接口都跑）'}>
          <Cb checked={!!env.readOnlyRun} onChange={(on) => patchEnv({ readOnlyRun: on })}>
            跑批只跑查询接口
          </Cb>
          <Hint>
            给 sit / uat 用：全自动回归、Controller 跑批只发查询接口（GET，或 query / list / get 这类开头的
            POST），提交、审批、推送等写接口整个跳过，数据准备也不造数。认不准的一律当写跳过。单接口「▶
            发送」照常发，只是也不造数。
          </Hint>
        </ApfFold>
      )}

      {apis && showAdvanced && METHOD_ORDER_SHOWN && (
        <ApfFold title="执行顺序编排" summary={describeOrder(env.methodOrder)}>
          <MethodOrderRow />
        </ApfFold>
      )}

      {apis && showAdvanced && CI_SHOWN && (
        <ApfFold
          title="CI/CD 无头运行"
          summary={learnedN ? `已学 ${learnedN} 条期望` : undefined}
        >
          <CiPanel />
        </ApfFold>
      )}
      </div>
    </Stack>
  )
}

/**
 * 执行顺序编排（PRD v0.6 模块 4.20）：跑批按 HTTP 方法分组先后，
 * 默认 POST→GET→PUT→PATCH→DELETE——新增先跑建出数据，查询/修改/删除才有对象。
 * 签片 ◀ ▶ 调序；只改组间先后，GET 并发 3 / 写全局串行的红线不在这里碰。
 * 折在「执行顺序编排」块里：标题和当前顺序在折叠头上，这里只留正文。
 */
function MethodOrderRow() {
  const env = useApiforgeStore((s) => s.env)
  const patchEnv = useApiforgeStore((s) => s.patchEnv)
  const order = effectiveMethodOrder(env.methodOrder)
  const isCustom = normalizeMethodOrder(env.methodOrder).length > 0

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    patchEnv({ methodOrder: next })
  }

  return (
    <div>
      <p className="apf-hint">
        当前：{describeOrder(env.methodOrder)}。新增先跑建出数据，查询/修改/删除才有对象；
        没提到的自定义方法排在最后。
      </p>
      <Row>
        {order.map((m, i) => (
          <span key={m} className="apf-orderchip">
            <b>{m}</b>
            <button type="button" title="前移" disabled={i === 0} onClick={() => move(i, -1)}>
              ◀
            </button>
            <button
              type="button"
              title="后移"
              disabled={i === order.length - 1}
              onClick={() => move(i, 1)}
            >
              ▶
            </button>
          </span>
        ))}
        <Btn variant="mini" disabled={!isCustom} onClick={() => patchEnv({ methodOrder: [] })}>
          恢复默认
        </Btn>
      </Row>
    </div>
  )
}

/**
 * Token 输入区（用户拍板 2026-09-12：输入即生效，不要再摆剪贴板按钮、门户
 * 预设、单独「注入」那套流程）。输什么就存什么，onChange 直进 store；自动
 * 识别只留在粘贴这一条被动路径——整段请求头贴进来，头名/前缀和 token 一起
 * 认出来，零点击。头名/前缀手改用上面「Token 请求头名称 / Token 值前缀」
 * 两格（自定义头名＝头名填 token、前缀留空）。配了登录接口时，运行前会自动
 * 登录并覆盖这里。
 */
function ManualTokenRow() {
  const { message } = AntdApp.useApp()
  const token = useApiforgeStore((s) => s.token)
  const setToken = useApiforgeStore((s) => s.setToken)
  const env = useApiforgeStore((s) => s.env)
  const patchEnv = useApiforgeStore((s) => s.patchEnv)
  /** 输入框默认掩码；点眼睛切明文。token 几百字符，掩码状态下没法核对内容 */
  const [reveal, setReveal] = useState(false)

  /** 单行 input 会丢掉换行，paste 事件里仍是完整文本——整段请求头要在这里拦 */
  const onPasteSmart: ClipboardEventHandler<HTMLInputElement> = (e) => {
    const text = e.clipboardData.getData('text')
    const parsed = parseAuthPaste(text)
    if (!parsed) return
    e.preventDefault()
    if (parsed.header) {
      patchEnv({ tokenHeader: parsed.header, tokenPrefix: parsed.prefix ?? '' })
    }
    setToken(parsed.token, '粘贴')
    void message.success(
      `已识别请求头（${parsed.header ?? '头名沿用当前'}${parsed.prefix ? ` · 前缀 ${parsed.prefix}` : ''}）`,
    )
  }

  return (
    <div>
      <Lbl>Token（可选）</Lbl>
      <Row>
        <Fld
          type={reveal ? 'text' : 'password'}
          value={token ?? ''}
          onChange={(e) => {
            const v = e.target.value.trim()
            setToken(v || null, v ? '手输' : null)
          }}
          onPaste={onPasteSmart}
          placeholder="输入或粘贴 Token，可粘贴完整请求头；只保存在内存"
          big
        />
        {/* 眼睛按钮：aria-pressed 让「当前是明文」可被读屏和测试探到；
            title 同时说明动作（显示/隐藏），不能只画个眼睛让人猜 */}
        <Btn
          className="apf-eyebtn"
          aria-pressed={reveal}
          title={reveal ? '隐藏 Token' : '显示 Token 明文'}
          aria-label={reveal ? '隐藏 Token' : '显示 Token 明文'}
          onClick={() => setReveal((v) => !v)}
        >
          <EyeGlyph off={reveal} />
        </Btn>
        <Btn disabled={!token} onClick={() => setToken(null, null)}>
          清除
        </Btn>
      </Row>
      {token && (
        /* 校对用：把**真正会发出去的那一行头**拼出来（token 掩码）。抠成 Cookie /
           抠半截这类错，头名一眼就能对出来——这是本区最值钱的信息。 */
        <p className="apf-hint">
          实际请求头：{env.tokenHeader || 'Authorization'}: {env.tokenPrefix}
          {env.tokenPrefix ? ' ' : ''}
          {maskToken(token)}（Token 已掩码；头名不对就粘整行请求头重识别）
        </p>
      )}
    </div>
  )
}

/**
 * 明/密文切换的眼睛。设计系统里只有 emoji 图标，没有一个能跟着主题变色的线性
 * 图标，所以这里 inline 一份；`currentColor` 让它在 .ghost 的 hover 态自动换色。
 * `off` 只多一道斜线，形状仍然是眼睛——比换成另一个 emoji 更容易认出
 * 「还是那个开关」。
 */
function EyeGlyph({ off }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M1.5 8S4 4.4 8 4.4 14.5 8 14.5 8 12 11.6 8 11.6 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      {off && <path d="M3 13 13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  )
}

/**
 * 断言严格度。两个词不解释等于没写（用户原话：「观察是什么意思，严格又是
 * 什么」），所以说明文字常驻在单选卡里。
 *
 * 「在哪生效」要写准（原评论「严格不改变界面里的判定」是 2026-09-28 前的事实）：
 * 严格模式现在改变界面里**结构断言**的判定——`judgeCase` 里响应结构对不上扫描
 * 字典的，严格算失败、观察只记录（`scan/schemaAssert`）；体断言始终判。库变更
 * 期望则是随 apiforge.yml 交给 CI 无头运行检查的（`checkExpectations` 只在
 * junit 那条路上被调用），在界面里跑照样只列出。
 */
const ASSERT_MODES: ChoiceCardItem<AssertMode>[] = [
  {
    value: 'observe',
    name: '观察',
    tag: '默认',
    what: '库变更、响应结构差异都只记录不判失败；用例通过与否只看 HTTP 状态与响应体断言。',
    when: '摸底、或第一次接一个工程时用它——先看看差异长什么样，再决定哪些收紧成失败。',
  },
  {
    value: 'strict',
    name: '严格',
    what: '两处收紧：响应结构对不上扫描到的返回类型字段时判失败；库变更按学到的期望判失败（随 apiforge.yml 给 CI）。',
    when: '断言口径定稳了、想让差异拦人时切。结构差异在观察模式全程有记录，报告和调试卡里看。',
  },
]

/**
 * 大目录多工程时各服务端口常不同：只给有差异的工程填覆盖，
 * 空 = 继续用默认 Base URL。登录 / Token 仍全局一份（常见 SSO）。
 * 折在「按工程覆盖 Base URL」块里：标题和覆盖数在折叠头上。
 */
function ProjectBaseUrlOverrides() {
  const env = useApiforgeStore((s) => s.env)
  const scan = useApiforgeStore((s) => s.scan)
  const patchEnv = useApiforgeStore((s) => s.patchEnv)

  const setProjectUrl = (projectId: string, raw: string) => {
    const next = { ...(env.projectBaseUrls ?? {}) }
    const t = raw.trim()
    if (t) next[projectId] = t
    else delete next[projectId]
    patchEnv({ projectBaseUrls: next })
  }

  const setPageUser = (projectId: string, raw: string) => {
    const next = { ...(env.pageUsers ?? {}) }
    const t = raw.trim()
    if (t) next[projectId] = t
    else delete next[projectId]
    patchEnv({ pageUsers: next })
  }

  if (!scan || scan.projects.length === 0) {
    return <p className="apf-hint">先扫描出工程后，可在这里给端口不同的工程单独填地址；空着的用默认。</p>
  }

  // 单工程也露出一行：用户偶尔会想跟默认不同，不必强迫去改全局
  return (
    <div>
      <p className="apf-hint">
        多工程端口 / 网关不同时只填差异项。调试、全量回归都按接口所属工程取地址。
      </p>
      <Stack>
        {scan.projects.map((p) => (
          <div key={p.projectId}>
            <Lbl>
              {p.projectName}
              <span className="apf-lbl-sub">
                {p.vue
                  ? `${(p.pages ?? []).length} 个页面 · 填浏览器里打开这个工程的地址`
                  : `${p.controllers.reduce((n, c) => n + c.methods.length, 0)} 个接口`}
              </span>
            </Lbl>
            <Fld
              value={env.projectBaseUrls?.[p.projectId] ?? ''}
              onChange={(e) => setProjectUrl(p.projectId, e.target.value)}
              placeholder={p.vue ? '如 http://sit.example.com:8080/h5' : env.baseUrl || 'http://localhost:8080'}
              big
            />
            {p.vue ? (
              <div className="apf-gap-top">
                <Fld
                  value={env.pageUsers?.[p.projectId] ?? ''}
                  onChange={(e) => setPageUser(p.projectId, e.target.value)}
                  placeholder={p.vue.defaultUser ? `登录工号，空着用 ${p.vue.defaultUser}` : '登录工号'}
                />
              </div>
            ) : null}
          </div>
        ))}
      </Stack>
    </div>
  )
}

/**
 * 手工补值（2026-09-22 由「样本值」改名）：程序备不出来的前置数据（别的服务写的
 * id、缓存里的值）按「接口字段名 + 值」补一个，正常用例发送时带上。
 *
 * 原来是一整个 `字段名=值` 文本域——用户得先学会「一行一个等号」这门语法，而等号
 * 解析会把写错的行**悄悄吞掉**（没打 `=` 或打在行首的整行丢弃），要等到跑完翻数据
 * 日志才发现没生效。改成一行一条：字段名 / 值 / 删除三个明摆着的部件，拼写当场能
 * 核对，也不用记任何格式。存储仍是 Record<字段名, 值>（env blob 原样持久化，
 * 空字段名的行不入库——等于没填）。
 */
function ManualValueRows() {
  const sampleValues = useApiforgeStore((s) => s.env.sampleValues)
  const patchEnv = useApiforgeStore((s) => s.patchEnv)
  return (
    <KvRows
      value={sampleValues}
      onCommit={(next) => patchEnv({ sampleValues: next })}
      namePh={['字段名（如 brandOwnerId）', '字段名']}
      valuePh={['值（如 1024）', '值']}
      delTitle="删掉这条补值"
    />
  )
}

/**
 * 环境级变量（接口改进 · 变量体系）：场景步骤与数据驱动行里 {{名}} 的第二优先级
 * 取值（场景链上提取的更优先，内置动态兜底）。与手工补值同款的一行一条编辑器。
 */
function EnvVarRows() {
  const vars = useApiforgeStore((s) => s.env.vars)
  const patchEnv = useApiforgeStore((s) => s.patchEnv)
  return (
    <KvRows
      value={vars}
      onCommit={(next) => patchEnv({ vars: next })}
      namePh={['变量名（如 shopId）', '变量名']}
      valuePh={['值（如 66）', '值']}
      delTitle="删掉这条变量"
    />
  )
}

type KvRow = { id: number; k: string; v: string }
let kvSeq = 0
const kvRowsOf = (rec: Record<string, string> | undefined): KvRow[] => [
  ...Object.entries(rec ?? {}).map(([k, v]) => ({ id: ++kvSeq, k, v })),
  { id: ++kvSeq, k: '', v: '' },
]
/** 只 trim 名字；空名不入库；重名只认第一行（后面的标红、不生效） */
const kvRecordOf = (rows: KvRow[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const name = r.k.trim()
    if (name && !(name in out)) out[name] = r.v
  }
  return out
}

/**
 * 一行一条的「名 = 值」编辑器。打字只改本地草稿，失焦或回车才写 store：
 * 边打边写会把值里的空格吃掉、把还没填名字的行丢掉、把同名行合并。
 */
function KvRows({
  value,
  onCommit,
  namePh,
  valuePh,
  delTitle,
}: {
  value: Record<string, string> | undefined
  onCommit: (next: Record<string, string> | undefined) => void
  namePh: [string, string]
  valuePh: [string, string]
  delTitle: string
}) {
  const [rows, setRows] = useState<KvRow[]>(() => kvRowsOf(value))
  // store 被外部改了（切环境组等）才重置草稿；自己提交引起的变化内容一致，不重置
  const key = JSON.stringify(value ?? {})
  const [seenKey, setSeenKey] = useState(key)
  if (key !== seenKey) {
    setSeenKey(key)
    if (key !== JSON.stringify(kvRecordOf(rows))) setRows(kvRowsOf(value))
  }

  const commit = (next: KvRow[]) => {
    const rec = kvRecordOf(next)
    onCommit(Object.keys(rec).length ? rec : undefined)
  }
  const edit = (id: number, slot: 'k' | 'v', raw: string) => {
    setRows((cur) => {
      const next = cur.map((r) => (r.id === id ? { ...r, [slot]: raw } : r))
      const last = next[next.length - 1]
      // 末尾永远留一条空行：入口常驻，不用先找「添加」按钮
      return last.k || last.v ? [...next, { id: ++kvSeq, k: '', v: '' }] : next
    })
  }
  const seen = new Set<string>()
  const dupIds = new Set<number>()
  for (const r of rows) {
    const name = r.k.trim()
    if (!name) continue
    if (seen.has(name)) dupIds.add(r.id)
    else seen.add(name)
  }

  return (
    <Stack>
      {rows.map((r, i) => {
        const blank = i === rows.length - 1
        const dup = dupIds.has(r.id)
        return (
          <Row key={r.id}>
            <Fld
              value={r.k}
              bad={dup}
              title={dup ? '和上面某行重名，这一行不生效' : undefined}
              onChange={(e) => edit(r.id, 'k', e.target.value)}
              onBlur={() => commit(rows)}
              onKeyDown={(e) => e.key === 'Enter' && commit(rows)}
              placeholder={blank ? namePh[0] : namePh[1]}
            />
            <Fld
              value={r.v}
              onChange={(e) => edit(r.id, 'v', e.target.value)}
              onBlur={() => commit(rows)}
              onKeyDown={(e) => e.key === 'Enter' && commit(rows)}
              placeholder={blank ? valuePh[0] : valuePh[1]}
            />
            <Btn
              variant="mini"
              disabled={blank}
              title={delTitle}
              onClick={() => {
                const next = rows.filter((x) => x.id !== r.id)
                setRows(next)
                commit(next)
              }}
            >
              删除
            </Btn>
          </Row>
        )
      })}
      {dupIds.size > 0 && (
        <Hint>有重名的行，标红的那行不生效。</Hint>
      )}
    </Stack>
  )
}

/** CI/CD（PRD v0.5 模块 4.10）：把 GUI 配置导出成 apiforge.yml + 流水线示例。
 *  折在「CI/CD 无头运行」块里：只有要走流水线的人才会展开。 */
function CiPanel() {
  const { message } = AntdApp.useApp()
  const env = useApiforgeStore((s) => s.env)
  const scan = useApiforgeStore((s) => s.scan)
  const learned = useApiforgeStore((s) => s.learnedExpectations)
  const [showSamples, setShowSamples] = useState(false)

  const exportYml = () => {
    const yml = configToYml({
      // 本机绝对路径在 CI 机器上不存在；yml 放进被测工程根目录，用相对路径
      project: './',
      baseUrl: env.baseUrl,
      loginApi: env.loginApi,
      username: env.username,
      assertMode: env.assertMode,
      // 学来的期望（PRD v0.6 模块 4.14）：报告页「学习期望」采纳的表变更规律
      expectations: learned,
      // 执行顺序（PRD v0.6 模块 4.20）：自定义过才写进 yml，默认导出保持原样
      methodOrder: env.methodOrder,
      formats: ['junit', 'html', 'json'] satisfies CiReportFormat[],
    })
    download('apiforge.yml', yml, 'text/yaml')
    const multi = (scan?.projects.length ?? 0) > 1
    void message.info(
      `apiforge.yml 已导出到「下载」文件夹；密码是 \${VAR} 占位，CI 里用环境变量注入${
        multi ? '。当前是多工程目录，把 project 改成要跑的工程相对路径' : ''
      }`,
    )
  }

  const copy = (name: string, text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => message.success(`${name} 配置已复制`),
      () => message.error('复制失败，请在下面的示例里手动选中复制'),
    )
  }

  return (
    <div>
      <p className="apf-hint">
        导出 apiforge.yml 放进被测工程，流水线里跑 <code>pnpm apiforge run --config ./apiforge.yml</code>：
        扫描 → 登录 → 用例 → 调接口 → 数据库对比 → JUnit/HTML 报告，失败退出码非 0 直接卡构建。
        密码不进配置文件，用 <code>${'{VAR}'}</code> 从环境变量注入。
      </p>
      <Row>
        <Btn variant="primary" onClick={exportYml}>
          导出 apiforge.yml
        </Btn>
        <Btn onClick={() => setShowSamples(!showSamples)}>
          {showSamples ? '收起流水线示例' : '查看流水线示例'}
        </Btn>
      </Row>
      {Object.keys(learned).length > 0 && (
        <p className="apf-hint">
          已学 {Object.keys(learned).length} 条库变更期望（{Object.entries(learned).map(([t, s]) => `${t} ${s}`).join('、')}
          ），严格模式下导出会带上；在报告页「学习期望」可更新。
        </p>
      )}
      {showSamples && (
        <Stack>
          {CI_SAMPLES.map((s) => (
            <div key={s.name}>
              <Row>
                <Lbl>{s.name}</Lbl>
                <Btn onClick={() => copy(s.name, s.code)}>复制</Btn>
              </Row>
              <pre className="apf-code">{s.code}</pre>
            </div>
          ))}
        </Stack>
      )}
    </div>
  )
}

const CI_SAMPLES: { name: string; code: string }[] = [
  {
    name: 'GitLab CI（.gitlab-ci.yml）',
    code: `apiforge:
  stage: test
  script:
    - pnpm install --frozen-lockfile
    - pnpm apiforge run --config ./apiforge.yml --output ./reports/
  artifacts:
    paths:
      - ./reports/
    reports:
      junit: ./reports/junit.xml
  rules:
    - if: $CI_MERGE_REQUEST_ID   # 只在 MR 时跑`,
  },
  {
    name: 'Jenkins（Jenkinsfile）',
    code: `stage('API Regression') {
    steps {
        sh 'pnpm install --frozen-lockfile'
        sh 'pnpm apiforge run --config ./apiforge.yml --output ./reports/'
    }
    post {
        always {
            junit 'reports/junit.xml'
            archiveArtifacts 'reports/apiforge-report.html'
        }
    }
}`,
  },
  {
    name: 'GitHub Actions（.github/workflows/apiforge.yml）',
    code: `- name: 码上测回归
  run: |
    pnpm install --frozen-lockfile
    pnpm apiforge run --config ./apiforge.yml --output ./reports/
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: apiforge-reports
    path: reports/`,
  },
]

/**
 * 页面测试：登录页工号 / 密码 / 部门，浏览器窗口开关，检查浏览器。login=false（只有 Vue 工程）只留浏览器那行；
 * soloVue（只有一个 Vue 工程）再加它的登录工号，存在 pageUsers 里，跟按工程覆盖里那格是同一个值
 */
function PageTestFold({
  defaultOpen,
  login,
  soloVue,
}: {
  defaultOpen?: boolean
  login: boolean
  soloVue: { projectId: string; defaultUser: string } | null
}) {
  const { message } = AntdApp.useApp()
  const env = useApiforgeStore((s) => s.env)
  const patchEnv = useApiforgeStore((s) => s.patchEnv)
  const [checking, setChecking] = useState(false)
  // 记住了却读回空的工号（换了电脑 / Windows 用户），密码框下提示重输
  const [lostUser, setLostUser] = useState('')
  const remember = !!env.pageRememberPass
  const user = env.pageUsername ?? ''
  const vueUser = soloVue ? (env.pageUsers?.[soloVue.projectId] ?? '') : ''
  const setVueUser = (raw: string) => {
    if (!soloVue) return
    const next = { ...(env.pageUsers ?? {}) }
    if (raw.trim()) next[soloVue.projectId] = raw.trim()
    else delete next[soloVue.projectId]
    patchEnv({ pageUsers: next })
  }

  // 勾了记住又没密码（刚重开应用 / 换了工号）就从本机凭据填回
  useEffect(() => {
    if (!remember || !user || useApiforgeStore.getState().env.pagePassword) return
    pageCredGet(user)
      .then((p) => {
        // 读的工夫工号又变了（还在打字），这份密码不是新工号的
        const now = useApiforgeStore.getState().env
        if (p && !now.pagePassword && now.pageUsername === user) patchEnv({ pagePassword: p })
        else if (!p) setLostUser(user)
      })
      .catch((e: unknown) => {
        setLostUser(user)
        void message.error(`读取记住的密码失败：${credErr(e)}`)
      })
  }, [remember, user, patchEnv, message])

  const savePass = async (password: string | undefined) => {
    if (!remember || !user || !password) return
    try {
      await pageCredSet(user, password)
    } catch (e) {
      void message.error(`密码没记住：${credErr(e)}`)
    }
  }

  const toggleRemember = async (on: boolean) => {
    try {
      if (on) {
        if (env.pagePassword) await pageCredSet(user, env.pagePassword)
      } else {
        await pageCredDelete(user)
      }
      patchEnv({ pageRememberPass: on || undefined })
    } catch (e) {
      void message.error(`${on ? '密码没记住' : '清掉记住的密码失败'}：${credErr(e)}`)
    }
  }

  const check = async () => {
    if (checking) return
    setChecking(true)
    try {
      await checkBrowser(message, !!env.pageShowBrowser)
    } finally {
      setChecking(false)
    }
  }

  return (
    <ApfFold
      title="页面测试"
      summary={
        soloVue
          ? `工号 ${vueUser || soloVue.defaultUser || '未配置'}`
          : !login
            ? '浏览器'
            : env.pageUsername
              ? `工号 ${env.pageUsername}`
              : '未配置'
      }
      defaultOpen={defaultOpen}
    >
      {soloVue && (
        <div>
          <Lbl>登录工号</Lbl>
          <Fld
            value={vueUser}
            onChange={(e) => setVueUser(e.target.value)}
            placeholder={soloVue.defaultUser ? `空着用 ${soloVue.defaultUser}` : '登录工号'}
          />
        </div>
      )}
      {login && (
      <Row>
        <div>
          <Lbl>登录工号</Lbl>
          <Fld
            value={env.pageUsername ?? ''}
            // 记住密码时换工号：清掉内存里上一个工号的密码，上面的 effect 按新工号读回来
            onChange={(e) => patchEnv({ pageUsername: e.target.value || undefined, ...(remember ? { pagePassword: undefined } : {}) })}
            placeholder="登录页上填的工号"
          />
        </div>
        <div>
          <Lbl>登录密码{remember ? '（已记在本机）' : '（只记在内存，关掉应用要重填）'}</Lbl>
          <Fld
            type="password"
            value={env.pagePassword ?? ''}
            onChange={(e) => patchEnv({ pagePassword: e.target.value || undefined })}
            onBlur={(e) => void savePass(e.target.value || undefined)}
          />
          {remember && lostUser === user && !env.pagePassword && (
            <Hint>记住的密码读不出来（可能换了电脑或 Windows 用户），请重新输入。</Hint>
          )}
        </div>
        <div>
          <Lbl>部门（留空取第一个）</Lbl>
          <Fld
            value={env.pageDept ?? ''}
            onChange={(e) => patchEnv({ pageDept: e.target.value || undefined })}
            placeholder="和登录页下拉里的名字一致"
          />
        </div>
      </Row>
      )}
      <Row>
        <Cb checked={!!env.pageShowBrowser} onChange={(v) => patchEnv({ pageShowBrowser: v })}>
          运行时显示浏览器窗口
        </Cb>
        {login && (
          <Cb checked={remember} onChange={(v) => void toggleRemember(v)}>
            记住密码（存本机凭据，生产账号别勾）
          </Cb>
        )}
        <Btn blocked={checking} onClick={() => void check()}>
          {checking ? '检查中…' : '检查浏览器'}
        </Btn>
      </Row>
      <Hint>
        {soloVue
          ? '页面地址用上面的 Base URL。'
          : login
            ? '页面根地址用上面的 Base URL；多工程时可在「按工程覆盖 Base URL」里单独填。机构取登录页带出的第一个。'
            : 'Vue 工程的地址和登录工号在下面「按工程覆盖 Base URL」里填。'}
      </Hint>
    </ApfFold>
  )
}

/**
 * 环境组（接口改进 · 体验）：整套环境配置的命名快照。开发 / 测试 / 预发各存一份，
 * 点组名一键切换——不用再逐个折叠手改地址和账号。与手工补值同款的一行一条交互：
 * 上面是组列表（点名字 = 切换，带确认框因为会整体覆盖当前配置），下面一行存当前
 * 配置。密码不进快照（envWithoutSecret 在 store 里剥掉）；切换后 Token 清空，
 * 重跑时配了登录接口会自动重登（401 自救也兜底）。
 */
function EnvGroupRows() {
  const { message, modal } = AntdApp.useApp()
  const profiles = useApiforgeStore((s) => s.envProfiles)
  const saveEnvProfile = useApiforgeStore((s) => s.saveEnvProfile)
  const applyEnvProfile = useApiforgeStore((s) => s.applyEnvProfile)
  const removeEnvProfile = useApiforgeStore((s) => s.removeEnvProfile)
  const [name, setName] = useState('')

  const save = () => {
    const n = name.trim()
    const doSave = () => {
      const evicted = evictedBy(profiles, n)
      if (saveEnvProfile(name)) {
        void message.info(
          evicted ? `环境组「${n}」已保存；最多留 ${ENV_PROFILES_MAX} 组，最旧的「${evicted}」被挤掉了` : `环境组「${n}」已保存`,
        )
        setName('')
      }
    }
    if (n && profiles.some((p) => p.name === n)) {
      modal.confirm({
        title: `覆盖环境组「${n}」？`,
        content: '已有同名的组，会用当前配置替换它。',
        okText: '覆盖',
        onOk: doSave,
      })
      return
    }
    doSave()
  }

  const remove = (p: EnvProfile) => {
    modal.confirm({
      title: `删除环境组「${p.name}」？`,
      content: '只删这份快照，当前配置不变；删了不能恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: () => removeEnvProfile(p.id),
    })
  }

  const switchTo = (p: EnvProfile) => {
    modal.confirm({
      title: `切换到环境组「${p.name}」？`,
      content: '当前整份环境配置（地址 / 登录 / 连库 / 变量 / 补值）会被这份快照覆盖；密码不动，Token 清空。',
      okText: '切换',
      onOk: () => {
        if (applyEnvProfile(p.id)) void message.info(`已切换到环境组「${p.name}」`)
      },
    })
  }

  return (
    <Stack>
      {profiles.length === 0 && <Hint>还没有环境组。先把当前环境调好，下面起个名字存一份。</Hint>}
      {profiles.map((p) => (
        <Row key={p.id}>
          <Btn onClick={() => switchTo(p)} title="切换到这组环境（整体覆盖当前配置）">
            {p.name}
          </Btn>
          <span className="apf-hint">
            {p.savedAt ? new Date(p.savedAt).toLocaleString().slice(0, 16) : ''}
          </span>
          <Btn
            variant="mini"
            title="删掉这组快照（不影响当前配置）"
            onClick={() => remove(p)}
          >
            删除
          </Btn>
        </Row>
      ))}
      <Row>
        <Fld
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="环境组名（如 测试）"
          className="apf-envgroup-name"
        />
        <Btn variant="primary" disabled={!name.trim()} onClick={save}>
          保存当前配置
        </Btn>
      </Row>
    </Stack>
  )
}
