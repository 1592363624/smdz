/**
 * Jest 配置 - 使魔大战3 网页版后端 · db project（真实远程 MySQL 集成套件，**必须串行**）
 *
 * 本 config 只匹配 13 个真实 DB 集成套件（清单见 jest.db-specs.cjs）。它们共享同一远程
 * smdz schema、在同一游戏地图上并发读写全局聚合状态，因此**绝不能并行**——务必用串行方式
 * 调用（见下），否则会互踩产生间歇性假失败。
 *
 * 调用方式（必须 --runInBand，且勿与 unit project 并行）：
 *   npx jest --config jest.db.config.js --runInBand      # 串行跑 13 个真实库套件
 *   npm run test:db                                      # 等价简写
 *
 * 判定全绿的唯一依据仍是 `npm test`（= jest --config jest.full.config.js --runInBand，
 * 一次串行跑满 unit+db 共 79 套件）。本 config 供需要单独回归真实库逻辑时使用。
 */
const { dbSpecs } = require('./jest.db-specs.cjs');

// 用 testMatch（glob，支持 <rootDir> 展开为绝对路径）精确匹配 13 个真实 DB 套件，
// 不匹配任何 unit 套件。这是 Jest 最不易踩路径坑的正向匹配方式。
const testMatch = dbSpecs.map((p) => `<rootDir>/${p}`);

module.exports = {
  // 测试环境为 Node
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch,
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
  // 真实库集成套件单条耗时较长（建档/刷怪/战斗链路），给足文件级余量
  testTimeout: 180000,
};
