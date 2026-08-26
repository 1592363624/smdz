-- 货币审计日志表（P4，幂等守卫式）
CREATE TABLE IF NOT EXISTS `CurrencyLog` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `currency` VARCHAR(191) NOT NULL,
  `delta` DOUBLE NOT NULL,
  `balanceAfter` DOUBLE NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `CurrencyLog_userId_createdAt_idx`(`userId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
