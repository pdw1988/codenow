/** 文档导出测试共用的扫描夹具（免费版文档测试和专业版 AI 上下文测试都用） */
import type { ProjectScanResult, WorkspaceScanResult } from '../types'

const project = (): ProjectScanResult => ({
  projectId: 'p1',
  projectPath: 'E:/demo/demo-api',
  projectName: 'demo-api',
  controllers: [
    {
      className: 'UserController',
      packageName: 'com.demo.web',
      basePath: '/api/users',
      filePath: 'E:/demo/demo-api/UserController.java',
      description: '',
      author: '',
      date: '',
      methods: [
        {
          id: 'a1',
          methodName: 'create',
          httpMethod: 'POST',
          path: '/api/users',
          parameters: [{ name: 'verbose', javaType: 'Boolean', position: 'query', required: false }],
          requestBodyType: 'UserSaveDTO',
          requestBodyFields: [
            { name: 'name', javaType: 'String', required: true },
            { name: 'age', javaType: 'Integer', required: false },
          ],
          responseType: 'Result<UserVO>',
          description: '创建用户 <script>',
          controllerClass: 'UserController',
          filePath: 'E:/demo/demo-api/UserController.java',
          projectId: 'p1',
        },
        {
          id: 'a2',
          methodName: 'detail',
          httpMethod: 'GET',
          path: '/api/users/{id}',
          parameters: [{ name: 'id', javaType: 'Long', position: 'path', required: true }],
          requestBodyType: null,
          requestBodyFields: [],
          responseType: 'String',
          description: '',
          controllerClass: 'UserController',
          filePath: 'E:/demo/demo-api/UserController.java',
          projectId: 'p1',
        },
      ],
    },
  ],
  mappers: [
    {
      namespace: 'com.demo.UserMapper',
      filePath: 'E:/demo/demo-api/UserMapper.xml',
      statements: [{ id: 'insert', op: 'insert', tables: ['t_user'] }],
    },
  ],
  classUses: [
    { className: 'UserController', methodName: 'create', usedFieldTypes: ['UserService'] },
    { className: 'UserService', methodName: 'create', usedFieldTypes: ['UserMapper'] },
  ],
  errors: [],
})

export const scan = (): WorkspaceScanResult => ({
  root: 'E:/demo',
  scannedAt: '2026-09-05T00:00:00.000Z',
  fingerprint: 'abc',
  projects: [project()],
  errors: [],
})
