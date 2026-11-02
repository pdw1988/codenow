/**
 * 页面测试的钩子：ftl 画像、写操作草稿、Vue 工程扫描都在专业版里，专业版加载时挂上。
 * 开源版没挂：扫描只出接口，页面条目没有画像和草稿。
 */
import type { PageProfile, WriteDraft } from '../types'

/** iframe 弹窗：按链接找同一次扫描里另一个页面的 ftl 原文 */
export type FrameFtl = (url: string) => { url: string; text: string } | null

export interface PageHooks {
  profileFtl(text: string): PageProfile
  draftWrite(text: string, profile: PageProfile | null, frameFtl?: FrameFtl): WriteDraft | null
  resolveLinkUrl(from: string, url: string): string
  linkHitsPage(url: string, pagePath: string): boolean
  /** 扫出来的 Vue 工程，和 jar 输出的工程同形状；读失败当没有 */
  scanVue(root: string): Promise<Record<string, unknown>[]>
}

let hooks: PageHooks | null = null

export function setPageHooks(h: PageHooks): void {
  hooks = h
}

export function pageHooks(): PageHooks | null {
  return hooks
}

/** 把 Vue 工程并进 jar 输出的 JSON；jar 输出坏了原样返回，交给原来的报错 */
export function mergeVueProjects(jarJson: string, vue: readonly Record<string, unknown>[]): string {
  if (!vue.length) return jarJson
  try {
    const j = JSON.parse(jarJson) as { projects?: unknown[] }
    return JSON.stringify({ ...j, projects: [...(j.projects ?? []), ...vue] })
  } catch {
    return jarJson
  }
}
