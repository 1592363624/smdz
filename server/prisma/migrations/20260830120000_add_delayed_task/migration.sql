-- 持久化延时任务表（幂等守卫式）：承载跨重启的「N 秒后结算」任务
CREATE TABLE IF NOT EXISTS `DelayedTask` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `type` VARCHAR(191) NOT NULL,
  `userId` INTEGER NULL,
  `dedupeKey` VARCHAR(191) NULL,
  `payload` JSON NOT NULL DEFAULT ('{}'),
  `runAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `DelayedTask_runAt_idx`(`runAt`),
  INDEX `DelayedTask_type_userId_dedupeKey_idx`(`type`, `userId`, `dedupeKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
