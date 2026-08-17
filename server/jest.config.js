/**
 * Jest 配置文件 - 使魔大战3 网页版后端
 * 使用 ts-jest 编译 TS 测试，隔离 NestJS DI 依赖（测试仅覆盖纯算法/复刻单元）。
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
  // 超时设置（算法单测通常很快，留 10s 余量）
  testTimeout: 10000,
};
