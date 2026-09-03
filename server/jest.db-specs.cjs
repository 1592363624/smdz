/**
 * 真实远程 DB 套件清单（唯一事实来源）
 *
 * 判据：这些 spec 通过 `NestFactory.createApplicationContext(AppModule)` 启动真实 Nest 应用，
 * 直连共享远程 MySQL（server/.env DATABASE_URL → smdz），并在同一游戏地图(mapId)上读写
 * 全局聚合状态（summons/vehicles/markers/怪物…）。它们之间只要并行就会互踩 → 假失败
 * （实测 13 并行 → integration-vehicle-combat / integration-merchant 间歇 3 用例红）。
 *
 * 因此它们必须被隔离到独立 Jest project（jest.db.config.js），由编排脚本强制串行执行。
 * 默认 jest.config.js（unit project）通过 testPathIgnorePatterns 排除本清单，保证裸 `npx jest`
 * 永不触碰共享远程 DB → 并行恒稳定。
 *
 * ⚠️ 若新增/移除真实 DB 集成套件，请同步本清单，保证三份 config 覆盖集一致。
 */
module.exports = {
  dbSpecs: [
    'test/actor-player-e2e.spec.ts',
    'test/admin-backpack-e2e.spec.ts',
    'test/integration-counter-attack.spec.ts',
    'test/integration-display-mult.spec.ts',
    'test/integration-dodge.spec.ts',
    'test/integration-familiar-select.spec.ts',
    'test/integration-home-frontline.spec.ts',
    'test/integration-lann-plana-skill.spec.ts',
    'test/integration-merchant.spec.ts',
    'test/integration-openbox.spec.ts',
    'test/integration-vehicle-combat.spec.ts',
    'test/onboarding-flow.spec.ts',
    'test/skill-view.smoke.spec.ts',
  ],
};
