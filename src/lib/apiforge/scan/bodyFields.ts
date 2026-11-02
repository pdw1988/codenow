/**
 * 用 workspace 级的 DTO 字典补齐 `@RequestBody` 的字段清单。
 *
 * **为什么需要这一步**：扫描器（`parsers/spring-scanner`）把 `--root` 下每个带
 * pom.xml 的目录当成一个独立「工程」，而且**每个工程开头把 DTO 索引清空**
 * （Scanner.java 里 `dtoFields.clear()`）。于是 Controller 在 A 模块、DTO 在 B 模块时，
 * `requestBody.fields` 就是空的——多模块工程常是这个布局：
 * service / ui 模块的接口 body 字段全空，DTO 全在单独的 `xxx-api` 模块里。
 *
 * 好在扫描器**同时吐了一份工程级 `types` 字典**（原本给响应 JSON 的 key 标含义用的），
 * 所以数据其实都在，只是没接上。把所有工程的 `types` 并成一张表再反查一遍就行，
 * 不用改 Java、不用重建 jar。
 *
 * **为什么放归一化这一层而不是放 `buildBody`**：下游试跑预填、用例生成、接口文档、
 * API diff 全部读 `requestBodyFields` 这一个字段。补在源头，四处同时受益，
 * 而且补完的结果跟着扫描结果一起进缓存。
 *
 * **补不到的**：`List` / `Map` / `String` / `JSONObject` 这类泛型或 JDK 类型当 body
 * （泛型实参在扫描时就丢了），以及 `PageCondition` / `IdCondition` 这种
 * 跟外部 jar（ruoyi-common-core）一起来的基类——源码不在工作区，看不到就扫不到。
 */
import type { DtoField, ProjectScanResult, WorkspaceScanResult } from '../types'

/** 类简名 → 字段清单。body 骨架（嵌套对象/集合元素）与字段回填共用这一张表 */
export type TypeDict = Map<string, DtoField[]>

/** 有扫描结果就建字典，没有就 undefined（调用方退回无嵌套的骨架） */
export function dictOfScan(
  ws: { projects: readonly ProjectScanResult[] } | null | undefined,
): TypeDict | undefined {
  return ws ? buildTypeDict(ws.projects) : undefined
}

/**
 * 所有工程的 `types` 并成一张「类简名 → 字段」表。
 *
 * 同名类在两个模块里各有一份是真存在的（比如 `SysUser`）。取**字段多的那一份**：
 * 简名撞车时无法分辨哪个才是接口真正收的，但字段多的那份对「手动改参数试跑」更有用，
 * 而且结果不依赖工程遍历顺序（否则重排一次扫描结果就变）。
 */
export function buildTypeDict(projects: readonly ProjectScanResult[]): TypeDict {
  const dict = new Map<string, DtoField[]>()
  for (const p of projects) {
    for (const t of p.types ?? []) {
      if (t.fields.length === 0) continue
      const had = dict.get(t.name)
      if (!had || t.fields.length > had.length) dict.set(t.name, t.fields)
    }
  }
  return dict
}

/**
 * 把字典里的字段补给「声明了 body 类型但字段清单为空」的接口。
 *
 * 只补空的：扫描器自己解析出来的那份优先（它跟 Controller 同模块，比简名反查可信）。
 * 不改入参：扫描结果会进 React state 和缓存 blob，原地改等于骗过渲染。
 */
export function fillBodyFields(ws: WorkspaceScanResult): WorkspaceScanResult {
  const dict = buildTypeDict(ws.projects)
  if (dict.size === 0) return ws

  let touched = 0
  const projects = ws.projects.map((p) => ({
    ...p,
    controllers: p.controllers.map((c) => ({
      ...c,
      methods: c.methods.map((m) => {
        if (m.requestBodyType === null || m.requestBodyFields.length > 0) return m
        const fields = dict.get(m.requestBodyType)
        if (!fields || fields.length === 0) return m
        touched += 1
        return { ...m, requestBodyFields: fields }
      }),
    })),
  }))

  return touched === 0 ? ws : { ...ws, projects }
}
