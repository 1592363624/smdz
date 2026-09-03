/**
 * Jest 配置文件 - 使魔大战3 网页版后端 · 默认 project（unit：纯桩/单元，可并行）
 *
 * ⚠️ 本项目存在「真实远程 MySQL 集成套件」与「纯桩/单元套件」两类。Jest 29 无法在单次并行
 * 进程内让某类套件单独串行，而真实库套件彼此共享同一 smdz schema、在同一游戏地图上并发读写
 * 全局聚合状态，只要并行就会互踩产生假失败。因此拆分三份独立 config（各为单 project，用
 * --config 显式调用，互不共享 worker 池语义）：
 *
 *   1. jest.config.js      (默认) → unit project：66 个纯桩/单元套件，**可并行**。裸 `npx jest`
 *      只跑本组，永不触碰共享远程 DB → 并行恒稳定。
 *   2. jest.db.config.js            → db project：13 个真实 DB 集成套件，**必须串行**。
 *   3. jest.full.config.js          → 全量 = unit ∪ db。npm test（--runInBand 串行）用它，为判绿标准。
 *
 * 若你只想快速跑可并行的单元套件：`npm run test:unit`（= 裸 npx jest）。
 * 若你改动了真实库集成逻辑：请跑 `npm run test:db`（串行）或 `npm run test:all`。
 * 判定全绿的唯一依据：`npm test`（= jest --config jest.full.config.js --runInBand，一次串行全量 79）。
 *
 * 使用 ts-jest 编译 TS，隔离 NestJS DI 依赖。
 */
const { dbSpecs } = require('./jest.db-specs.cjs');

module.exports = {
  // 测试环境为 Node
  testEnvironment: 'node',
  // 仅运行 test 目录下以 .spec.ts 结尾的文件
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  // 排除真实远程 DB 集成套件（见 jest.db-specs.cjs）：它们必须走 jest.db.config.js 串行，
  // 绝不能在本 project 被并行执行，否则共享 smdz schema 的并发读写会互踩 → 假失败。
  // 注意 testPathIgnorePatterns 匹配的是「绝对测试路径」且不做 <rootDir> 替换，故用不含
  // <rootDir>、锚定文件名结尾的相对路径正则（jest 内部 testPath 统一以 '/' 分隔）。
  testPathIgnorePatterns: dbSpecs.map((p) => {
    const rel = p.replace(/^test\//, '').replace(/\./g, '\\.');
    return `/test/${rel}$`;
  }),
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
  // 超时设置（算法单测通常很快，留 10s 余量）
  testTimeout: 10000,
};
