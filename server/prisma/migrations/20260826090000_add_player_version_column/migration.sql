-- 乐观锁版本号：savePlayer 按「读快照时的 version」做条件更新（CAS），
-- 并发旧快照写回时 Prisma update 抛 P2025，由 PlayerService.savePlayer 转换为显式并发冲突错误，
-- 防止兑换/召唤等玩家指令被后台结算的旧快照整包覆盖（丢失更新）。
ALTER TABLE `Player` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX `Player_id_version_key` ON `Player`(`id`, `version`);
