-- 怪物三层池字段：护盾(Shield) / 装甲(Armor)，战斗按 护盾→装甲→生命 串行扣减
-- 对应原版使魔大战3 怪物拥有独立护盾与装甲

ALTER TABLE "GameMonster" ADD COLUMN "maxHp" REAL NOT NULL DEFAULT 100;
ALTER TABLE "GameMonster" ADD COLUMN "shield" REAL NOT NULL DEFAULT 0;
ALTER TABLE "GameMonster" ADD COLUMN "maxShield" REAL NOT NULL DEFAULT 0;
ALTER TABLE "GameMonster" ADD COLUMN "armor" REAL NOT NULL DEFAULT 0;
ALTER TABLE "GameMonster" ADD COLUMN "maxArmor" REAL NOT NULL DEFAULT 0;
