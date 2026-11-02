/**
 * 配置管理页（PRD 五）：YAML ↔ Properties ↔ JSON 一键互转 · 实时校验报行号。
 *
 * 布局跟原型 mockup/config.html 一致：左边输入（编辑器 + 校验 + 智能提示），
 * 右边输出（互转结果 + 多环境）。跟原型最大的不同是**没有「生成」按钮**：
 * 解析和转换全在 useMemo 里，粘贴即出结果（PRD 5.1 的 3 秒要求在这里是即时的），
 * 原型的「格式化」按钮也因此不需要了——输出本来就是 dump 出来的规范格式。
 *
 * 注释保活（P0）：notes 按「完整点分路径」记行尾注释，转 Properties 时注释
 * 还能找到自己的键；反向转回 YAML 时按同一路径回填。链路被 convert.test.ts
 * 的全链路用例钉住。
 *
 * 草稿持久化（PRD 5.6）：内容按（文件名 × 环境）自动存进 MetaStore
 * （Tauri 落 SQLite 的 cache_metadata，浏览器落独立 localStorage 键），
 * 防抖 800ms——打字间隙足够落盘，又不至于每个字符写一次库。
 *
 * 三种格式（2026-09-22 加 JSON，用户「json / yml / 属性文件都加上」）共用同一棵
 * 中间树：YAML 和 JSON 的解析结果本来就是 YamlNode，Properties 是扁平表、
 * 输出前折一次。所以「来源 × 输出方向」是 3 × 3 而不是每个方向一份实现。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { getStore, initStore } from '../../storage'
import type { YamlNode } from '../../lib/config/common'
import type { ConfigFormat } from '../../lib/config/convert'
import { flatten, nest, sniff } from '../../lib/config/convert'
import { parseProps, dumpProps } from '../../lib/config/props'
import { computeInsertion, filterHints } from '../../lib/config/springMeta'
import { dumpYaml, parseYaml } from '../../lib/config/yaml'
import { dumpJson, parseJson } from '../../lib/config/json'
import { Page } from '../../components/shell/Page'
import {
  Auto,
  Band,
  Cb,
  Col,
  Fld,
  Hint,
  Row,
  Seg,
  Spacer,
  Split,
  Stack,
  Tag,
} from '../../components/ui'
import { Btn } from '../../components/ui'
import { Card } from '../../components/ui'
import { Code } from '../../components/ui'
import { GutterEditor } from './GutterEditor'

/** 多环境的三个槽位。MVP 只做内容切换，「一键对比」是后续铺垫（PRD 5.4.4） */
const ENVS = ['dev', 'test', 'prod'] as const
type EnvKey = (typeof ENVS)[number]

/** 草稿的键。文件名跟当前生效格式走——粘的是 properties 就存到 application.properties 名下 */
const draftKey = (lang: ConfigFormat, env: EnvKey) =>
  `application.${lang === 'props' ? 'properties' : lang === 'json' ? 'json' : 'yml'}|${env}`

type ParseResult =
  | { error: Error; leafCount: number }
  | { error: null; tree: YamlNode; notes: Record<string, string>; leafCount: number }

export function ConfigPanel() {
  const [src, setSrc] = useState('')
  const [mode, setMode] = useState<'yaml' | 'props' | 'json' | 'auto'>('yaml')
  const [indent, setIndent] = useState<'2' | '4'>('2')
  const [dir, setDir] = useState<'props' | 'yaml' | 'json'>('yaml')
  const [sorted, setSorted] = useState(false)
  const [env, setEnv] = useState<EnvKey>('dev')
  const [query, setQuery] = useState('')
  /** 已保存的草稿。内存里留一份给「切环境」即时取用，落盘交给 MetaStore */
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const taRef = useRef<HTMLTextAreaElement | null>(null)
  /** 挂载后用户动过编辑器没有：草稿异步读回来时不能盖掉用户已经打的字 */
  const touchedRef = useRef(false)

  // 自动识别模式下才需要嗅探；显式指定时不花这笔解析
  const effLang: ConfigFormat = mode === 'auto' ? sniff(src) : mode

  /* ---------- 挂载时读回草稿 ---------- */
  useEffect(() => {
    let cancelled = false
    void initStore().then(async (store) => {
      const saved = await store.getConfigDrafts()
      if (cancelled) return
      setDrafts(saved)
      // 只恢复当前槽位，而且用户还没打过字——恢复永远不覆盖输入
      const restored = saved[draftKey(effLang, env)]
      if (!touchedRef.current && restored !== undefined) setSrc(restored)
    })
    return () => {
      cancelled = true
    }
    // 挂载时只读一次；effLang/env 此后变化走 switchEnv，不走这里
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- 实时校验：解析一遍过，错误带行号 ---------- */
  const parsed: ParseResult | null = useMemo(() => {
    if (!src.trim()) return null // 空文本是「还没粘」，不是「粘错了」
    try {
      // 三个解析器的返回形状不同（YAML/JSON 是嵌套树，Properties 是扁平字符串表，
      // 见 parseProps 的返回类型注释），分开调而不是三元里混用——r 没法按语言收窄
      if (effLang === 'yaml' || effLang === 'json') {
        const r = effLang === 'yaml' ? parseYaml(src) : parseJson(src)
        // 键数按叶子算：树要展开成点分路径再数，嵌套层级不算配置项
        return { error: null, ...r, leafCount: Object.keys(flatten(r.tree)).length }
      }
      const r = parseProps(src)
      return { error: null, ...r, leafCount: Object.keys(r.tree).length }
    } catch (e) {
      return { error: e as Error, leafCount: 0 }
    }
  }, [src, effLang])

  const badLine = useMemo(() => {
    if (!parsed?.error) return null
    const m = /第 (\d+) 行/.exec(parsed.error.message)
    return m ? Number(m[1]) : null
  }, [parsed])

  /* ---------- 互转结果：方向 × 来源格式一共三条链路 ---------- */
  const conv = useMemo<{ code: string; error: string | null }>(() => {
    if (!parsed || parsed.error) return { code: '', error: null }
    try {
      if (dir === 'props') {
        // props 来源时优先用**原表**，不要 nest/flatten 走一圈：那一圈不是恒等变换
        // （`a[0].b` 会变成 `a.0.b`），而 Properties → Properties 本来就是
        // 「整理格式」，没道理把用户写对的下标改掉
        const flat =
          effLang === 'props'
            ? (parsed.tree as unknown as Record<string, string>)
            : flatten(parsed.tree)
        return { code: dumpProps(flat, parsed.notes, sorted), error: null }
      }
      // 折叠成同一棵树：YAML/JSON 的解析结果本来就是树，Properties 是扁平表、折一次。
      // 折完 yaml / json 两个输出方向都只看 tree
      const tree =
        effLang === 'props'
          ? nest(parsed.tree as unknown as Record<string, string>)
          : parsed.tree
      return {
        code:
          dir === 'json'
            ? dumpJson(tree, indent === '2' ? 2 : 4)
            : dumpYaml(tree, indent === '2' ? 2 : 4, parsed.notes),
        error: null,
      }
    } catch (e) {
      // 只有一种会走到这：Properties → YAML / JSON 时一个键既是叶子又是分支
      // （同一个文件里既有 `a=1` 又有 `a.b=2`）。折叠不出树就说清楚，
      // 让异常从 useMemo 里炸出去只会整页白屏
      return { code: '', error: (e as Error).message }
    }
  }, [parsed, dir, effLang, indent, sorted])
  const output = conv.code

  /* ---------- 草稿防抖自动存 ---------- */
  useEffect(() => {
    if (!touchedRef.current) return // 挂载恢复那一下不触发存档
    const key = draftKey(effLang, env)
    const timer = window.setTimeout(() => {
      setDrafts((d) => ({ ...d, [key]: src }))
      void getStore().saveConfigDraft(key, src)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [src, effLang, env])

  /** 把当前编辑器内容立刻存进当前槽位。切环境前必须调：
   *  上面的防抖定时器会被依赖变化的 cleanup 取消，不补这一刀的话
   *  「改完立刻切环境」会丢最后几秒的输入 */
  const flushDraft = () => {
    if (!touchedRef.current) return
    const key = draftKey(effLang, env)
    setDrafts((d) => ({ ...d, [key]: src }))
    void getStore().saveConfigDraft(key, src)
  }

  const switchEnv = (next: EnvKey) => {
    if (next === env) return
    flushDraft()
    setEnv(next)
    setSrc(drafts[draftKey(effLang, next)] ?? '')
  }

  /* ---------- 智能提示（PRD 5.3）---------- */
  const hints = useMemo(() => filterHints(query), [query])

  const applyHint = (key: string) => {
    const ta = taRef.current
    const cursor = ta?.selectionStart ?? src.length
    // joiner 跟生效格式走：YAML 补 ": "、Properties 补 "="、JSON 补 `": `
    // 传 effLang 而不是 mode —— 自动识别下内容已经明说是 Properties 了，
    // 补一个 ":" 进去用户还得自己删
    const ins = computeInsertion(src, cursor, key, effLang)
    touchedRef.current = true
    setSrc(ins.text)
    // 受控组件重渲染会重置选区，等一帧再把光标放到补全结尾并夺回焦点
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(ins.cursor, ins.cursor)
    })
  }

  const langLabel = effLang === 'yaml' ? 'YAML' : effLang === 'json' ? 'JSON' : 'Properties'
  const outExt = dir === 'props' ? 'properties' : dir === 'json' ? 'json' : 'yml'

  const onEdit = (next: string) => {
    touchedRef.current = true
    setSrc(next)
  }

  return (
    <Page tab="config" actions={<Auto>粘贴即校验 · 报错带行号</Auto>}>
      <Split even>
        {/* ---------- 左：输入 ---------- */}
        <Col>
          <Stack>
            <Card hero
              title="输入"
              who={
                parsed === null
                  ? undefined
                  : parsed.error
                    ? '✗ 校验未通过'
                    : `✓ ${parsed.leafCount} 个配置项 · ${langLabel}`
              }
              extra={
                <Seg
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'yaml', label: 'YAML' },
                    { value: 'props', label: 'Properties' },
                    { value: 'json', label: 'JSON' },
                    {
                      value: 'auto',
                      label: '自动识别',
                      title: '按内容特征判断：行首是 { 或 [ 的是 JSON，成片的 a.b=c 是 Properties，其余是 YAML',
                    },
                  ]}
                />
              }
            >
              <GutterEditor
                value={src}
                onChange={onEdit}
                taRef={taRef}
                badLine={badLine}
                placeholder="粘一段 application.yml / application.json / application.properties 进来 —— 校验是实时的，不用点按钮"
              />
            </Card>

            {parsed?.error && (
              <Band tone="err" title={parsed.error.message}>
                改掉对应行的问题就行，校验是实时的，不用点按钮
              </Band>
            )}
            {parsed && !parsed.error && (
              <Band tone="ok" title="校验通过">
                共 {parsed.leafCount} 个配置项 · {langLabel}，右边就是转换结果
              </Band>
            )}

            <Card title="智能提示" extra={<Tag tone="hi">{hints.length}</Tag>}>
              <Stack>
                <Row>
                  <Fld
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="输入 spring. 、server. 试试 —— 点一条直接补进编辑器"
                  />
                </Row>
                {hints.length === 0 ? (
                  <Hint>没有匹配的配置项 —— 换个词试试，比如 datasource、redis。</Hint>
                ) : (
                  <div className="hints">
                    {hints.map((h) => (
                      <button
                        key={h.key}
                        type="button"
                        className="hint-row"
                        onClick={() => applyHint(h.key)}
                        title={`点击插入到光标处（${effLang === 'props' ? 'a.b=' : effLang === 'json' ? '"a.b": ' : 'a:'} 形式）`}
                      >
                        <code>{h.key}</code>
                        <span className="ds">
                          {h.desc}
                          {h.def !== '—' ? ` · 默认 ${h.def}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Stack>
            </Card>
          </Stack>
        </Col>

        {/* ---------- 右：输出 ---------- */}
        <Col>
          <Stack>
            <Card
              title="输出结果"
              extra={
                <Seg
                  value={dir}
                  onChange={setDir}
                  options={[
                    { value: 'props', label: '转 Properties' },
                    { value: 'yaml', label: '保持 YAML' },
                    { value: 'json', label: '转 JSON' },
                  ]}
                />
              }
            >
              {/* 缩进和排序都只管输出长什么样：放在输出卡里一行，输入卡头只留来源格式 */}
              <Row tight style={{ marginBottom: 10 }}>
                <span title="缩进只对 YAML / JSON 生效">
                  <Seg
                    value={indent}
                    onChange={setIndent}
                    options={[
                      { value: '2', label: '2 空格' },
                      { value: '4', label: '4 空格' },
                    ]}
                  />
                </span>
                <Cb
                  checked={sorted}
                  onChange={setSorted}
                  disabled={dir !== 'props'}
                  title={
                    dir !== 'props'
                      ? '只对 Properties 输出生效——YAML / JSON 保持书写顺序'
                      : '键按字母排序，行尾注释跟着原来的键走'
                  }
                >
                  排序
                </Cb>
              </Row>
              <Code
                code={output}
                lang={dir === 'props' ? 'props' : dir === 'json' ? 'json' : 'yaml'}
                download={`application-${env}.${outExt}`}
                empty="左边粘入内容后这里就是转换结果 —— 方向用上面的开关切，不用重新粘贴。"
              />
              {conv.error && (
                <Band tone="err" title={`转不出来：${conv.error}`}>
                  上面的输入本身是合法的，只是它表达的结构没法折成层级 ——
                  看看是不是同一个键既写了值又写了子键。
                </Band>
              )}
            </Card>

            <Card title="多环境配置">
              <Stack>
                <Row style={{ gap: 8 }}>
                  <Seg
                    value={env}
                    onChange={switchEnv}
                    options={ENVS.map((e) => ({ value: e, label: e }))}
                  />
                  <Spacer />
                  <Btn
                    variant="mini"
                    disabled
                    title="每个环境各存一份，目前没有可对比的对象"
                  >
                    一键对比
                  </Btn>
                </Row>
                <Hint>
                  内容按（文件名 × 环境）各存一份草稿，自动保存；切环境就是切换编辑内容，互不影响。
                </Hint>
              </Stack>
            </Card>
          </Stack>
        </Col>
      </Split>
    </Page>
  )
}
