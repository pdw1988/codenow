/**
 * 底部命令窗口：输命令回车执行，上下键翻历史，结果按 redis-cli 的样子排。
 * 危险命令和只读连接的写命令由 Rust 拦，这里只把拦下来的原因显示出来。
 */
import { useEffect, useRef, useState } from 'react'
import { credErr } from '../../lib/dbCred'
import { redisExec } from '../../lib/redisIpc'
import { formatReply, splitArgs } from '../../lib/redis/reply'
import { Btn, Card, Fld, Hint, Row } from '../../components/ui'

interface Line {
  id: number
  cmd: string
  out: string
  err?: boolean
}

const KEEP = 200

export function RedisConsole({ open, onToggle, db }: { open: boolean; onToggle: (open: boolean) => void; db: number }) {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [hist, setHist] = useState<string[]>([])
  const [at, setAt] = useState(-1)
  const [busy, setBusy] = useState(false)
  const outRef = useRef<HTMLPreElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const push = (cmd: string, out: string, err?: boolean) =>
    setLines((prev) => [...prev, { id: ++seq.current, cmd, out, err }].slice(-KEEP))

  const run = async () => {
    const line = input.trim()
    if (!line || busy) return
    setHist((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100))
    setAt(-1)
    setInput('')
    const args = splitArgs(line)
    if (typeof args === 'string') {
      push(line, `(error) ${args}`, true)
      return
    }
    if (args.length === 0) return
    setBusy(true)
    try {
      push(line, formatReply(await redisExec(...args)))
    } catch (e) {
      push(line, `(error) ${credErr(e)}`, true)
    } finally {
      setBusy(false)
    }
  }

  const recall = (next: number) => {
    if (next < -1 || next >= hist.length) return
    setAt(next)
    setInput(next === -1 ? '' : hist[next]!)
  }

  return (
    <Card
      className="rk-con"
      title="命令窗口"
      who={`库 ${db}`}
      open={open}
      onToggle={onToggle}
      extra={
        lines.length > 0 ? (
          <Btn
            variant="mini"
            onClick={(e) => {
              e.stopPropagation()
              setLines([])
            }}
          >
            清屏
          </Btn>
        ) : undefined
      }
    >
      <pre className="rk-out" ref={outRef}>
        {lines.length === 0 && (
          <Hint>输命令回车执行，如 HGETALL user:1。上下键翻历史。FLUSHALL、KEYS 这类会卡住或清空库的命令不执行。</Hint>
        )}
        {lines.map((l) => (
          <div key={l.id}>
            <div className="cmd">{`> ${l.cmd}`}</div>
            <div className={l.err ? 'err' : undefined}>{l.out}</div>
          </div>
        ))}
      </pre>
      <Row tight>
        <Fld
          className="grow mono"
          value={input}
          placeholder={busy ? '执行中…' : '输入命令，回车执行'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              recall(at + 1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              recall(at - 1)
            }
          }}
          aria-label="Redis 命令"
        />
        <Btn variant="mini" disabled={busy || !input.trim()} onClick={() => void run()}>
          执行
        </Btn>
      </Row>
    </Card>
  )
}
