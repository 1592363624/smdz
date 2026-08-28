-- 怪物奖励原子认领：同一运行时实例只允许一个请求继续结算奖励。
ALTER TABLE `GameMonster` ADD COLUMN `rewardClaimed` BOOLEAN NOT NULL DEFAULT FALSE;
