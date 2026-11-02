import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  changelogSection,
  composeReleaseNotes,
  notesFromChanges,
  notesLookThin,
} from './updateNotes'

const CHANGES = `# 未发版改动记录

---

## 2026-09-01 · 粘贴 ALTER 展开后结果网格横条没了

**提交信息**（直接拿去 \`git commit -m\`）

\`\`\`
fix: 粘贴 ALTER 展开后结果网格还能横滚

右栏 overflow:auto 两轴一起开，展开的 ALTER 把栏撑宽，结果表跟着撑满，横条没了。
\`\`\`

**建议版本**：\`+0.0.1\`

## 2026-09-01 · 打 11g 包后自动传到 GitHub Release

\`\`\`
fix: pnpm tauri:build:oci 打完自动上传 GitHub Release

本机 7897 开着就走 Clash。
\`\`\`

**建议版本**：不升。

## 2026-09-01 · 用户手册

\`\`\`
docs: 增加面向使用者的操作手册
\`\`\`

**建议版本**：文档，不升号
`

test('CHANGES.md 抽出标题和为什么，跳过不升号的条目', () => {
  const notes = notesFromChanges(CHANGES)
  assert.match(notes, /粘贴 ALTER 展开后结果网格横条没了/)
  assert.match(notes, /右栏 overflow:auto/)
  assert.doesNotMatch(notes, /11g 包后自动传/)
  assert.doesNotMatch(notes, /用户手册/)
})

test('命令行只写「发版 v1.2.0」时改用 CHANGES.md，不能让弹窗只剩一句口号', () => {
  const notes = composeReleaseNotes('发版 v1.2.0', CHANGES)
  assert.match(notes, /粘贴 ALTER/)
  assert.doesNotMatch(notes, /^发版 v1\.2\.0$/)
})

test('认真写的命令行说明保留在条目前面', () => {
  const notes = composeReleaseNotes('查询结果横条修好了', CHANGES)
  assert.ok(notes.startsWith('查询结果横条修好了'), notes)
  assert.match(notes, /粘贴 ALTER/)
})

test('已经拼过的说明再跑一遍不把条目叠两份', () => {
  const once = composeReleaseNotes('查询结果横条修好了', CHANGES)
  const twice = composeReleaseNotes(once, CHANGES)
  assert.equal(twice, once)
})

test('口号 / 空说明判为 thin，给弹窗走 CHANGELOG 兜底', () => {
  assert.equal(notesLookThin(''), true)
  assert.equal(notesLookThin('发版 v1.1.0'), true)
  assert.equal(notesLookThin('本次更新没有写说明。'), true)
  assert.equal(notesLookThin('· 粘贴 ALTER 展开后结果网格还能横滚'), false)
})

test('CHANGELOG 按版本切开，丢掉下载路径那行', () => {
  const md = `# 更新日志

## v1.2.0 —— 2026-09-01

· 粘贴 ALTER 展开后结果网格横条没了

> Windows 安装包：\`CHUJU SQL_1.2.0_x64-setup.exe\`

## v1.1.0 —— 2026-08-31

发版 v1.1.0
`
  const body = changelogSection(md, '1.2.0')
  assert.match(body, /粘贴 ALTER/)
  assert.doesNotMatch(body, /Windows 安装包/)
  assert.doesNotMatch(body, /1\.1\.0/)
  assert.equal(changelogSection(md, '9.9.9'), '')
})
