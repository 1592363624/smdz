/**
 * 全量测试套件的环境默认值（jest.full.config.js 的 setupFiles，每个测试文件执行前注入）。
 *
 * PLAYTIME_CRON=off：停用 ScheduleService 的每分钟在线时长统计。该 cron 会给
 * 所有 5 分钟内活跃的玩家推进 version，与集成测试的快照式保存互相挤掉写入
 * （stale-block 静默丢写 / CAS 冲突），是 e2e 精确断言偶发失败的并发写者。
 */
process.env.PLAYTIME_CRON = process.env.PLAYTIME_CRON || 'off';
