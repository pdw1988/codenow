/**
 * 开源版（没有 pro/ 目录）时 `@pro` 指到这里。
 * 导出名字要和 pro/src/index.ts 一一对应，少一个开源版就编不过。
 * 页面和普通函数分两个文件：混在一个 .tsx 里热更新不生效。
 */
export {
  ApiforgeBenchTab,
  ApiforgeDataTab,
  ApiforgePagesTab,
  ApiforgeScenarioTab,
  SshPanel,
  TermPage,
  TimelineView,
} from './pages'
export {
  checkBrowser,
  docsToAiContext,
  HAS_PRO,
  junitForApi,
  parseJavaSer,
  runApiCases,
  runControllerCases,
  runFullRegression,
  useBenchEvents,
  type JavaSerResult,
} from './lib'
