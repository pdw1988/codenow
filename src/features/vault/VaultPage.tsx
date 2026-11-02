/**
 * 常用信息：VPN、堡垒机、生产库这些账号地址收在一处，点开一条逐个复制。
 *
 * 布局跟「我的连接」一致：工具条 → 新建/编辑表单 → 选中那条的详情 → 三列卡片。
 * 敏感字段只在选中时解密一次，默认打码；切到别的条目就重新盖上。
 */
import { useEffect, useState } from 'react'
import { App } from 'antd'
import { credErr } from '../../lib/dbCred'
import { vaultSecretsDelete, vaultSecretsGet, vaultSecretsSet } from '../../lib/vaultCred'
import { initStore, isTauri } from '../../storage'
import {
  VAULT_CATS,
  VAULT_FIELD_LIMIT,
  VAULT_KEY,
  VAULT_LIMIT,
  catLabel,
  looksSecret,
  matchVault,
  newVaultId,
  parseVault,
  parseVaultText,
  presetFields,
  removeVault,
  splitSecrets,
  upsertVault,
  vaultSummary,
  type VaultCat,
  type VaultField,
  type VaultItem,
} from '../../storage/vault'
import { Page } from '../../components/shell/Page'
import {
  Band,
  Btn,
  Card,
  Cb,
  CopyBtn,
  EmptyBox,
  Fld,
  Hint,
  Lbl,
  Mono,
  Row,
  Seg,
  Spacer,
  Stack,
  Tag,
  TextArea,
} from '../../components/ui'

type CatFilter = 'all' | VaultCat

interface Form {
  id: string | null
  name: string
  cat: VaultCat
  /** 敏感字段的真值也在这里，只活在内存 */
  fields: VaultField[]
  note: string
}

const blankForm = (cat: VaultCat = 'vpn'): Form => ({ id: null, name: '', cat, fields: presetFields(cat), note: '' })

const persist = async (list: VaultItem[]) => (await initStore()).saveMetaBlob(VAULT_KEY, JSON.stringify(list))
const readVault = async () => parseVault(await (await initStore()).getMetaBlob(VAULT_KEY))

export function VaultPage() {
  const { message } = App.useApp()
  const [items, setItems] = useState<VaultItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [q, setQ] = useState('')
  const [catFilter, setCatFilter] = useState<CatFilter>('all')
  const [sel, setSel] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [bad, setBad] = useState(false)
  const [formHint, setFormHint] = useState('')
  const [saving, setSaving] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paste, setPaste] = useState('')
  /** 表单里敏感字段明文显示 */
  const [formPlain, setFormPlain] = useState(false)
  const [armedDel, setArmedDel] = useState<string | null>(null)

  const [loadRev, setLoadRev] = useState(0)
  useEffect(() => {
    let live = true
    readVault()
      .then((list) => {
        if (!live) return
        setItems(list)
        setSel((cur) => cur ?? list[0]?.id ?? null)
        // 一条都没有：直接摆出新建表单，不让人先去找按钮
        if (list.length === 0) setForm((f) => f ?? blankForm())
        setLoaded(true)
      })
      .catch((e: unknown) => {
        if (live) setLoadErr(credErr(e))
      })
    return () => {
      live = false
    }
  }, [loadRev])

  const current = items.find((x) => x.id === sel) ?? null
  const hasSecret = Boolean(current?.fields.some((x) => x.secret))

  /* 选中条目变了就重新解密。结果带着 id，快速连点时旧的回来也不会套到新的上 */
  const [secFor, setSecFor] = useState<string | undefined>(undefined)
  const [sec, setSec] = useState<{ id: string; map: Record<string, string> } | null>(null)
  const [secErr, setSecErr] = useState('')
  const [reveal, setReveal] = useState<ReadonlySet<string>>(new Set())
  if (current?.id !== secFor) {
    setSecFor(current?.id)
    setSec(null)
    setSecErr('')
    setReveal(new Set())
    setArmedDel(null)
    if (current && current.fields.some((x) => x.secret)) {
      const id = current.id
      void vaultSecretsGet(id)
        .then((map) => setSec({ id, map }))
        .catch((e: unknown) => setSecErr(credErr(e)))
    }
  }
  const secMap = sec && sec.id === current?.id ? sec.map : null
  const secReady = !hasSecret || secMap !== null

  const kw = q.trim()
  const shown = items.filter((x) => (catFilter === 'all' || x.cat === catFilter) && matchVault(x, kw))
  const countCat = (c: VaultCat) => items.filter((x) => x.cat === c).length

  const openForm = (f: Form) => {
    setForm(f)
    setBad(false)
    setFormHint('')
    setPasteOpen(false)
    setPaste('')
    setFormPlain(false)
  }
  const closeForm = () => {
    setForm(null)
    setFormHint('')
    setPaste('')
    setPasteOpen(false)
  }

  const editCurrent = () => {
    if (!current) return
    if (!secReady) {
      message.warning(secErr ? `密码读不出来，先别改，免得把它存成空的：${secErr}` : '密码还在解密，稍等一下')
      return
    }
    openForm({
      id: current.id,
      name: current.name,
      cat: current.cat,
      fields: current.fields.map((x) => (x.secret ? { ...x, value: secMap?.[x.id] ?? '' } : { ...x })),
      note: current.note,
    })
  }

  const patchForm = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f))
  const patchField = (id: string, p: Partial<VaultField>) =>
    setForm((f) => (f ? { ...f, fields: f.fields.map((x) => (x.id === id ? { ...x, ...p } : x)) } : f))

  /** 新建时切分类：字段还没填过就换成这一类的预填行；填过了只改分类，不动内容 */
  const switchCat = (cat: VaultCat) => {
    if (!form) return
    const untouched = form.fields.every((x) => !x.value.trim())
    patchForm(form.id === null && untouched ? { cat, fields: presetFields(cat) } : { cat })
  }

  const applyPaste = () => {
    if (!form) return
    const got = parseVaultText(paste)
    if (got.fields.length === 0 && !got.note) {
      message.warning('没拆出东西。每行写成「名称：值」最好认')
      return
    }
    const kept = form.fields.filter((x) => x.value.trim())
    patchForm({
      fields: [...kept, ...got.fields].slice(0, VAULT_FIELD_LIMIT),
      note: [form.note.trim(), got.note].filter(Boolean).join('\n'),
    })
    setPaste('')
    setPasteOpen(false)
    message.success(`拆出 ${got.fields.length} 个字段${got.note ? '，其余的放进了备注' : ''}。看一眼再保存`)
  }

  const save = async () => {
    if (!form) return
    if (!form.name.trim()) {
      setBad(true)
      setFormHint('名称要填')
      return
    }
    if (form.id === null && items.length >= VAULT_LIMIT) {
      setFormHint(`最多 ${VAULT_LIMIT} 条`)
      return
    }
    const id = form.id ?? newVaultId()
    const { item, secrets } = splitSecrets({ ...form, id, updatedAt: Date.now() })
    const anySecret = Object.keys(secrets).length > 0
    if (anySecret && !isTauri()) {
      setFormHint('浏览器版存不了敏感字段，请用桌面版')
      return
    }
    setSaving(true)
    try {
      // 先写密码再写条目：密码没存上就整条不存，不会出现「条目在、密码丢了」
      if (anySecret) await vaultSecretsSet(id, secrets)
      else await vaultSecretsDelete(id)
      const next = upsertVault(items, item)
      await persist(next)
      setItems(next)
      setSel(id)
      setSecFor(undefined) // 强制重新解密这一条
      closeForm()
      message.success(anySecret ? '已保存，密码加密存在本机' : '已保存')
    } catch (e) {
      setFormHint(`没存上：${credErr(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const del = async () => {
    if (!current) return
    if (armedDel !== current.id) {
      setArmedDel(current.id)
      return
    }
    try {
      await vaultSecretsDelete(current.id)
      const next = removeVault(items, current.id)
      await persist(next)
      setItems(next)
      setSel(next[0]?.id ?? null)
      if (form?.id === current.id) closeForm()
      message.info('已删除这条')
    } catch (e) {
      message.error(`删除失败：${credErr(e)}`)
    }
  }

  const toggleReveal = (id: string) =>
    setReveal((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Page tab="vault">
      {loadErr && (
        <Band tone="err" title="读存档失败">
          {loadErr}
          <Btn
            variant="mini"
            onClick={() => {
              setLoadErr('')
              setLoadRev((n) => n + 1)
            }}
          >
            重试
          </Btn>
        </Band>
      )}

      <Stack>
        <div className="toolrow">
          <Fld
            className="grow"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜名称 / 地址 / 账号 / 备注（密码不参与搜索）"
            aria-label="搜索常用信息"
          />
          <Seg
            value={catFilter}
            onChange={setCatFilter}
            options={[
              { value: 'all' as const, label: `全部 ${items.length}` },
              ...VAULT_CATS.map((c) => ({ value: c.value, label: `${c.label} ${countCat(c.value)}` })),
            ]}
          />
          <Btn
            variant="primary"
            onClick={() => (form && form.id === null ? closeForm() : openForm(blankForm(catFilter === 'all' ? 'vpn' : catFilter)))}
          >
            {form && form.id === null ? '收起新建' : '＋ 新建'}
          </Btn>
        </div>

        {form && (
          <Card hero title={form.id ? '编辑' : '新建'} who="勾了「敏感」的字段加密存在本机，不进普通存档" className="form-card">
            <Stack gap={8}>
              <Row>
                <Lbl>名称</Lbl>
                <Fld
                  className="grow"
                  value={form.name}
                  onChange={(e) => {
                    setBad(false)
                    patchForm({ name: e.target.value })
                  }}
                  placeholder="如 公司 VPN、生产堡垒机、订单库（生产只读）"
                  bad={bad}
                  aria-label="名称"
                />
              </Row>
              <Row>
                <Lbl>分类</Lbl>
                <Seg value={form.cat} onChange={switchCat} options={VAULT_CATS} />
                <Spacer />
                <Btn variant="mini" on={pasteOpen} onClick={() => setPasteOpen((v) => !v)}>
                  粘贴文本自动拆
                </Btn>
              </Row>
              {pasteOpen && (
                <Stack gap={6} className="vault-paste">
                  <TextArea
                    rows={6}
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder={'把记事本里那段直接粘进来，如：\n地址：10.0.0.8\n账号：ops\n密码：******\n每行「名称：值」拆成一个字段，名字里带「密码/口令/password」的自动勾敏感，其余的行进备注'}
                    aria-label="粘贴文本"
                  />
                  <Row>
                    <Hint>拆完接在已填的字段后面；空着的预填行会被替掉。</Hint>
                    <Spacer />
                    <Btn variant="mini" hi disabled={!paste.trim()} onClick={applyPaste}>
                      拆成字段
                    </Btn>
                  </Row>
                </Stack>
              )}
              <Row tight>
                <Lbl>字段</Lbl>
                <Spacer />
                <Cb checked={formPlain} onChange={setFormPlain}>
                  显示敏感字段
                </Cb>
              </Row>
              {form.fields.map((x) => (
                <div className="vault-frow" key={x.id}>
                  <Fld
                    value={x.label}
                    onChange={(e) => {
                      const label = e.target.value
                      // 新加的行字段名打成「密码」之类就顺手勾上敏感；已经勾过的不反向取消
                      patchField(x.id, { label, secret: x.secret || (!x.value && looksSecret(label)) })
                    }}
                    placeholder="字段名"
                    aria-label="字段名"
                  />
                  <Fld
                    className="mono"
                    type={x.secret && !formPlain ? 'password' : 'text'}
                    autoComplete="off"
                    value={x.value}
                    onChange={(e) => patchField(x.id, { value: e.target.value })}
                    placeholder="值"
                    aria-label={x.label || '值'}
                  />
                  <Cb checked={x.secret} onChange={(v) => patchField(x.id, { secret: v })} title="勾上：加密存、列表里打码">
                    敏感
                  </Cb>
                  <Btn
                    variant="mini"
                    title="删掉这一行"
                    onClick={() => patchForm({ fields: form.fields.filter((y) => y.id !== x.id) })}
                  >
                    ✕
                  </Btn>
                </div>
              ))}
              <Row tight>
                <Btn
                  variant="mini"
                  blocked={form.fields.length >= VAULT_FIELD_LIMIT}
                  onClick={() => {
                    if (form.fields.length >= VAULT_FIELD_LIMIT) {
                      message.warning(`一条最多 ${VAULT_FIELD_LIMIT} 个字段，放不下的写进备注`)
                      return
                    }
                    patchForm({ fields: [...form.fields, { id: newVaultId(), label: '', value: '', secret: false }] })
                  }}
                >
                  ＋ 加一行
                </Btn>
              </Row>
              <Row className="lbl-top">
                <Lbl>备注</Lbl>
                <TextArea
                  className="grow"
                  rows={3}
                  value={form.note}
                  onChange={(e) => patchForm({ note: e.target.value })}
                  placeholder="可选，如 先连 VPN 再登堡垒机；密码每 90 天改一次。备注不加密，别写密码"
                  aria-label="备注"
                />
              </Row>
              <Row className="fc-indent">
                <Btn variant="primary" disabled={!loaded || saving} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存'}
                </Btn>
                {(form.id !== null || items.length > 0) && (
                  <Btn variant="mini" onClick={closeForm}>
                    取消
                  </Btn>
                )}
                <Hint>{formHint}</Hint>
              </Row>
            </Stack>
          </Card>
        )}

        {current && !form && (
          <Card
            title={current.name}
            who={catLabel(current.cat)}
            extra={
              <Row tight>
                <Btn variant="mini" blocked={!secReady} onClick={editCurrent}>
                  编辑
                </Btn>
                <Btn variant="mini" danger={armedDel === current.id} onClick={() => void del()}>
                  {armedDel === current.id ? '确认删除？' : '删除'}
                </Btn>
              </Row>
            }
          >
            <Stack gap={10}>
              {secErr && (
                <Band tone="err" title="密码读不出来">
                  {secErr}。换过 Windows 用户或重装过系统会这样，只能重新填一遍。
                </Band>
              )}
              {current.fields.length === 0 ? (
                <Hint>这条没有字段，点「编辑」加。</Hint>
              ) : (
                <div className="vault-kv">
                  {current.fields.map((x) => {
                    const val = x.secret ? (secMap?.[x.id] ?? '') : x.value
                    const open = !x.secret || reveal.has(x.id)
                    return (
                      <div className="vault-kv-row" key={x.id}>
                        <Lbl>{x.label || '（未命名）'}</Lbl>
                        <Mono className={x.secret && !open ? 'vault-mask' : undefined}>
                          {x.secret && !secMap ? (secErr ? '读不出' : '解密中…') : open ? val : val ? '••••••••' : '（空）'}
                        </Mono>
                        <Row tight>
                          {x.secret && (
                            <Btn variant="mini" on={open} disabled={!val} onClick={() => toggleReveal(x.id)}>
                              {open ? '隐藏' : '显示'}
                            </Btn>
                          )}
                          <CopyBtn text={val} />
                        </Row>
                      </div>
                    )
                  })}
                </div>
              )}
              {current.note && (
                <Row className="lbl-top">
                  <Hint className="vault-note grow">{current.note}</Hint>
                  <CopyBtn text={current.note}>复制备注</CopyBtn>
                </Row>
              )}
            </Stack>
          </Card>
        )}

        {!loaded && !loadErr && <EmptyBox>正在读取本地存储…</EmptyBox>}
        {loaded && items.length > 0 && shown.length === 0 && (
          <EmptyBox>没有命中的条目。换个词，或切到「全部」。</EmptyBox>
        )}
        <div className="g-grid3">
          {shown.map((x) => (
            <button
              key={x.id}
              type="button"
              className={x.id === sel ? 'conncard on' : 'conncard'}
              onClick={() => {
                setSel(x.id)
                if (form) closeForm()
              }}
            >
              <div className="fr">
                <span className="nm">{x.name}</span>
                <Tag tone="hi">{catLabel(x.cat)}</Tag>
              </div>
              <div className="addr">{vaultSummary(x) || '—'}</div>
              <div className="who">
                <span>
                  {x.fields.length} 个字段
                  {x.fields.some((y) => y.secret) ? ' · 含密码' : ''}
                  {x.note ? ` · ${x.note.split('\n')[0]}` : ''}
                </span>
              </div>
            </button>
          ))}
        </div>
      </Stack>
    </Page>
  )
}
