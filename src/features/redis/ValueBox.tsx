/**
 * 一个值的显示和编辑：字符串键的整个值，以及哈希 / 列表里单元格点开后的值。
 *
 * 「显示为」默认自动识别。只有合法 UTF-8 的值能改：二进制值经过文本框一来一回
 * 字节就变了，Java 序列化的对象写回去业务代码直接反序列化失败。
 * gzip 先解压再按里面的内容识别（可能是 JSON，也可能又是 Java 序列化）；
 * Java 序列化解成 JSON 只读显示，是专业版。「十六进制」永远看的是原始字节。
 */
import { useEffect, useMemo, useState } from 'react'
import { App } from 'antd'
import { parsePreservingBig, stringifyPreservingBig } from '../../lib/bigIntJson'
import { canRedisPro } from '../../lib/license'
import { gunzip, hexDump, jsonPretty, sizeText, sniff, textToBytes, utf8OrNull, type ValueKind } from '../../lib/redis/codec'
import { parseJavaSer } from '@pro'
import { useLicenseStore } from '../../store/useLicenseStore'
import { useUiStore } from '../../store/useUiStore'
import { Band, Btn, Row, Seg, Spacer, Stack, TextArea } from '../../components/ui'

type View = 'auto' | 'text' | 'json' | 'hex'

const KIND_LABEL: Record<ValueKind, string> = { text: '文本', json: 'JSON', jdk: 'Java 序列化', gzip: 'gzip', binary: '二进制' }

interface Props {
  bytes: Uint8Array
  /** 不能改的原因（只读连接、大键只读了前 1MB…）；没有就是能改 */
  lockedWhy?: string
  onSave?: (bytes: Uint8Array) => Promise<unknown>
  /** 跳 JSON 查看时显示的来源 */
  from: string
}

type Unzipped = { src: Uint8Array; bytes: Uint8Array; cut: boolean } | { src: Uint8Array; err: string }

export function ValueBox({ bytes, lockedWhy, onSave, from }: Props) {
  const { message } = App.useApp()
  const isPro = useLicenseStore((s) => s.isPro)
  const kind = useMemo(() => sniff(bytes), [bytes])
  const text = useMemo(() => utf8OrNull(bytes), [bytes])
  const [unz, setUnz] = useState<Unzipped | null>(null)
  const [view, setView] = useState<View>('auto')
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 换了一个值（刷新、点了别的行）就丢掉没保存的草稿；渲染期校正，不走 effect
  const [seen, setSeen] = useState(bytes)
  if (seen !== bytes) {
    setSeen(bytes)
    setDraft(null)
  }

  useEffect(() => {
    if (kind !== 'gzip') return
    let live = true
    gunzip(bytes).then(
      (r) => live && setUnz({ src: bytes, ...r }),
      (e: unknown) => live && setUnz({ src: bytes, err: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [bytes, kind])

  // 解压是异步的：只认属于当前这个值的结果，刚换值时上一个的结果不算
  const zipped = kind === 'gzip' ? (unz?.src === bytes ? unz : null) : null
  const inner = kind === 'gzip' ? (zipped && 'bytes' in zipped ? zipped.bytes : null) : bytes
  const innerKind = useMemo(() => (inner ? sniff(inner) : null), [inner])
  const innerText = useMemo(() => (inner && kind === 'gzip' ? utf8OrNull(inner) : text), [inner, kind, text])
  const pro = canRedisPro(isPro)
  const ser = useMemo(() => (inner && innerKind === 'jdk' && pro ? parseJavaSer(inner) : null), [inner, innerKind, pro])
  const pretty = useMemo(() => {
    if (ser?.ok) return ser.json
    return innerText === null ? null : jsonPretty(innerText)
  }, [ser, innerText])

  const auto: View = pretty !== null ? 'json' : innerText !== null ? 'text' : 'hex'
  const v = view === 'auto' ? auto : view
  const shown =
    v === 'json' ? (pretty ?? '') : v === 'text' ? (innerText ?? '') : hexDump(v === 'hex' && view === 'auto' && inner ? inner : bytes)
  // 只有原始字节就是文本的能改：gzip / Java 对象改完写回去格式就不对了
  const editable = !lockedWhy && Boolean(onSave) && v !== 'hex' && text !== null && !ser
  const dirty = draft !== null && draft !== shown
  const autoLabel = kind === 'gzip' && innerKind ? `gzip → ${KIND_LABEL[innerKind]}` : KIND_LABEL[kind]

  const save = async () => {
    if (draft === null || !onSave) return
    let out = draft
    if (v === 'json') {
      try {
        const parsed = parsePreservingBig(draft)
        // 原值是一行的紧凑 JSON（程序写进去的通常如此）就压回一行，别改变它的格式
        if (text !== null && !/\n/.test(text.trim())) out = stringifyPreservingBig(parsed)
      } catch {
        message.error('不是合法的 JSON，没有保存。要存成普通文本请切到「文本」再改')
        return
      }
    }
    setSaving(true)
    try {
      await onSave(textToBytes(out))
    } finally {
      setSaving(false)
    }
  }

  const copy = () => {
    void navigator.clipboard.writeText(draft ?? shown).then(
      () => message.success('已复制'),
      () => message.error('复制失败'),
    )
  }

  return (
    <Stack>
      <Row tight>
        <Seg
          value={view}
          onChange={(next) => {
            setView(next)
            setDraft(null)
          }}
          options={[
            { value: 'auto', label: `自动（${autoLabel}）` },
            {
              value: 'text',
              label: '文本',
              disabled: innerText === null,
              title: innerText === null ? '不是合法的 UTF-8 文本，只能按十六进制看' : undefined,
            },
            {
              value: 'json',
              label: 'JSON',
              disabled: pretty === null,
              title: pretty === null ? '不是合法的 JSON' : undefined,
            },
            { value: 'hex', label: '十六进制', title: '原始字节（gzip 是压缩前的样子）' },
          ]}
        />
        <Spacer />
        {pretty !== null && (
          <Btn variant="mini" onClick={() => useUiStore.getState().jumpToJsonPath({ json: pretty, from })}>
            在 JSON 查看里打开
          </Btn>
        )}
        <Btn variant="mini" onClick={copy}>
          复制
        </Btn>
        {dirty && (
          <>
            <Btn variant="mini" onClick={() => setDraft(null)}>
              撤销修改
            </Btn>
            <Btn variant="mini" on disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </Btn>
          </>
        )}
      </Row>
      {kind === 'gzip' && !zipped && <Band tone="info">正在解压…</Band>}
      {zipped && 'err' in zipped && (
        <Band tone="warn" title="gzip 解压失败">
          {zipped.err}。下面按十六进制显示原始字节。
        </Band>
      )}
      {zipped && 'bytes' in zipped && (
        <Band tone="info" title="gzip 压缩的值">
          下面是解压后的内容（{sizeText(bytes.length)} → {sizeText(zipped.bytes.length)}
          {zipped.cut ? '，太大只解了前面一部分' : ''}）。压缩的值不能在这里改。
        </Band>
      )}
      {innerKind === 'jdk' && !pro && (
        <Band tone="warn" title="Java 序列化的值">
          把它解成类名和字段是专业版功能，先按十六进制显示。{' '}
          <Btn variant="mini" onClick={() => useLicenseStore.getState().openUpgrade()}>
            如何升级
          </Btn>
        </Band>
      )}
      {ser && !ser.ok && (
        <Band tone="warn" title="Java 序列化解析失败">
          {ser.err}。下面按十六进制显示。
        </Band>
      )}
      {ser?.ok && (
        <Band tone="info" title={ser.cls ? `Java 对象 ${ser.cls}` : 'Java 对象'}>
          只读：改了写回去业务代码会反序列化失败，要改请走业务接口。@class 是类名；环引用只展开一次。
        </Band>
      )}
      {editable ? (
        <TextArea className="rk-val-edit" value={draft ?? shown} onChange={(e) => setDraft(e.target.value)} aria-label="值" />
      ) : (
        <pre className="rk-val">{shown || '（空字符串）'}</pre>
      )}
      {lockedWhy && onSave && <Band tone="warn">{lockedWhy}</Band>}
    </Stack>
  )
}
