-- 玩家改名基础名列（对应原版 玩家.图片）：
-- baseName 存「选择使魔赋初值 / 命名使魔修改」的基础名，
-- name 列持久化派生显示名（原版 玩家.名称 = 图片 + [佩戴称号]，见 display-name.util.ts）。
ALTER TABLE `Player` ADD COLUMN `baseName` VARCHAR(191) NOT NULL DEFAULT '';

-- 存量回填：改动上线前 name 持久化的一直是基础名，直接平移
UPDATE `Player` SET `baseName` = `name` WHERE `baseName` = '';
