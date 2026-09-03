/**
 * Jest 配置 - 使魔大战3 网页版后端 · full project（全量 = unit ∪ db，**判绿标准**）
 *
 * 本 config 复刻早期单 jest.config.js 的语义：匹配 test 目录下全部 *.spec.ts（79 套件，
 * 含 66 个纯桩/单元 + 13 个真实远程 DB 集成套件）。因包含真实库套件，**必须串行**
 * （--runInBand）执行，否则 DB 套件并行互踩 → 假失败。
 *
 * 调用方式：
 *   npm test                                              # = jest --config jest.full.config.js --runInBand
 *   npx jest --config jest.full.config.js --runInBand
 *
 * 这是判定「全绿」的唯一依据。快速并行跑纯桩/单元请用 `npm run test:unit`；
 * 单独回归真实库逻辑用 `npm run test:db`；两者都想要的最快方式用 `npm run test:all`。
 */
module.exports = {
  // 测试环境为 Node
  testEnvironment: 'node',
  // 仅运行 test 目录下以 .spec.ts 结尾的文件
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  // ts-jest 转换 TS 源码
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // 使用测试专用 tsconfig，避免引入 nest 装饰器元数据报错
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  // 忽略 node_modules
  moduleFileExtensions: ['ts', 'js', 'json'],
  // 默认超时 10s；真实库集成套件内部以 jest.setTimeout 自行抬高
  testTimeout: 10000,
};
