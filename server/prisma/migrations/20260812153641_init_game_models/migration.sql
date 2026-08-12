-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '',
    "qqNumber" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "avatar" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserBinding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "botKey" TEXT NOT NULL,
    "botType" TEXT NOT NULL DEFAULT 'qq',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Player" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "exp" REAL NOT NULL DEFAULT 0,
    "upgradeExp" REAL NOT NULL DEFAULT 100,
    "name" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT '',
    "specialSeq" INTEGER NOT NULL DEFAULT 0,
    "hp" REAL NOT NULL DEFAULT 100,
    "maxHp" REAL NOT NULL DEFAULT 100,
    "shield" REAL NOT NULL DEFAULT 0,
    "maxShield" REAL NOT NULL DEFAULT 0,
    "armor" REAL NOT NULL DEFAULT 0,
    "maxArmor" REAL NOT NULL DEFAULT 0,
    "attack" REAL NOT NULL DEFAULT 10,
    "defense" REAL NOT NULL DEFAULT 0,
    "speed" REAL NOT NULL DEFAULT 100,
    "dodge" REAL NOT NULL DEFAULT 0,
    "hit" REAL NOT NULL DEFAULT 100,
    "crit" REAL NOT NULL DEFAULT 5,
    "critDmg" REAL NOT NULL DEFAULT 150,
    "regenHp" REAL NOT NULL DEFAULT 0,
    "regenShield" REAL NOT NULL DEFAULT 0,
    "regenArmor" REAL NOT NULL DEFAULT 0,
    "mapId" INTEGER NOT NULL DEFAULT 1,
    "location" TEXT NOT NULL DEFAULT '新手村',
    "houseName" TEXT NOT NULL DEFAULT '',
    "backpack" TEXT NOT NULL DEFAULT '[]',
    "equipment" TEXT NOT NULL DEFAULT '[]',
    "weapons" TEXT NOT NULL DEFAULT '[]',
    "currentWeapon" INTEGER NOT NULL DEFAULT 0,
    "markers" TEXT NOT NULL DEFAULT '{}',
    "markers2" TEXT NOT NULL DEFAULT '[]',
    "buffs" TEXT NOT NULL DEFAULT '[]',
    "tasks" TEXT NOT NULL DEFAULT '[]',
    "titles" TEXT NOT NULL DEFAULT '[]',
    "skills" TEXT NOT NULL DEFAULT '{}',
    "sets" TEXT NOT NULL DEFAULT '{}',
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "baseBonus" TEXT NOT NULL DEFAULT '{}',
    "vehicle" TEXT NOT NULL DEFAULT '',
    "safeBox" TEXT NOT NULL DEFAULT '[]',
    "equipmentPresets" TEXT NOT NULL DEFAULT '[]',
    "reverse" TEXT NOT NULL DEFAULT '[]',
    "recipes" TEXT NOT NULL DEFAULT '[]',
    "stats" TEXT NOT NULL DEFAULT '{}',
    "affinity" REAL NOT NULL DEFAULT 0,
    "masterQQ" TEXT NOT NULL DEFAULT '',
    "vitality" REAL NOT NULL DEFAULT 0,
    "lastOpTime" BIGINT NOT NULL DEFAULT 0,
    "readTime" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Player_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GameMap" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mapIndex" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "isFrontier" BOOLEAN NOT NULL DEFAULT false,
    "noTeleport" BOOLEAN NOT NULL DEFAULT false,
    "noMove" BOOLEAN NOT NULL DEFAULT false,
    "isInstance" BOOLEAN NOT NULL DEFAULT false,
    "requiredTravel" INTEGER NOT NULL DEFAULT 0,
    "monsters" TEXT NOT NULL DEFAULT '[]',
    "spawnMonsters" TEXT NOT NULL DEFAULT '[]',
    "tempMonsters" TEXT NOT NULL DEFAULT '[]',
    "summons" TEXT NOT NULL DEFAULT '[]',
    "resources" TEXT NOT NULL DEFAULT '[]',
    "resources2" TEXT NOT NULL DEFAULT '[]',
    "connections" TEXT NOT NULL DEFAULT '[]',
    "npcs" TEXT NOT NULL DEFAULT '[]',
    "items" TEXT NOT NULL DEFAULT '[]',
    "buildings" TEXT NOT NULL DEFAULT '[]',
    "vehicles" TEXT NOT NULL DEFAULT '[]',
    "markers" TEXT NOT NULL DEFAULT '{}',
    "markers2" TEXT NOT NULL DEFAULT '[]',
    "mapBuffs" TEXT NOT NULL DEFAULT '[]',
    "requireMarkers" TEXT NOT NULL DEFAULT '[]',
    "failHint" TEXT NOT NULL DEFAULT '',
    "clearMarkers" TEXT NOT NULL DEFAULT '',
    "music" TEXT NOT NULL DEFAULT '',
    "monsterCount" INTEGER NOT NULL DEFAULT 3,
    "noSpecial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "value" REAL NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL DEFAULT '',
    "useEffects" TEXT NOT NULL DEFAULT '[]',
    "useMarkers" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameEquipment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "equipType" TEXT NOT NULL DEFAULT '',
    "specialSeq" INTEGER NOT NULL DEFAULT 0,
    "specialEffect" INTEGER NOT NULL DEFAULT 0,
    "damageType" TEXT NOT NULL DEFAULT '物理',
    "cooldown" REAL NOT NULL DEFAULT 5,
    "lockTime" INTEGER NOT NULL DEFAULT 0,
    "forcedEffect" BOOLEAN NOT NULL DEFAULT false,
    "vehicleForceDmg" BOOLEAN NOT NULL DEFAULT false,
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "baseBonus" TEXT NOT NULL DEFAULT '{}',
    "properties" TEXT NOT NULL DEFAULT '{}',
    "affixes" TEXT NOT NULL DEFAULT '[]',
    "attackText" TEXT NOT NULL DEFAULT '{}',
    "buffs" TEXT NOT NULL DEFAULT '[]',
    "negativeType" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameFamiliar" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "uniqueSkill" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "description2" TEXT NOT NULL DEFAULT '',
    "skillDesc" TEXT NOT NULL DEFAULT '',
    "specialSeq" INTEGER NOT NULL DEFAULT 0,
    "noSummon" BOOLEAN NOT NULL DEFAULT false,
    "hairDrop" TEXT NOT NULL DEFAULT '{}',
    "affinityDesc" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameMonster" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "specialSeq" INTEGER NOT NULL DEFAULT -1,
    "type" TEXT NOT NULL DEFAULT '怪物',
    "description" TEXT NOT NULL DEFAULT '',
    "level" INTEGER NOT NULL DEFAULT 1,
    "hp" REAL NOT NULL DEFAULT 100,
    "attack" REAL NOT NULL DEFAULT 10,
    "defense" REAL NOT NULL DEFAULT 0,
    "speed" REAL NOT NULL DEFAULT 100,
    "dodge" REAL NOT NULL DEFAULT 0,
    "hit" REAL NOT NULL DEFAULT 100,
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameBuff" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "duration" INTEGER NOT NULL DEFAULT 0,
    "chance" REAL NOT NULL DEFAULT 100,
    "stackTime" BOOLEAN NOT NULL DEFAULT false,
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "triggerText" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameCrafting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "noCraft" BOOLEAN NOT NULL DEFAULT false,
    "level" INTEGER NOT NULL DEFAULT 1,
    "deconstructMul" REAL NOT NULL DEFAULT 5,
    "expGain" REAL NOT NULL DEFAULT 0,
    "outputs" TEXT NOT NULL DEFAULT '[]',
    "requirements" TEXT NOT NULL DEFAULT '[]',
    "gainMarkers" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameBlueprint" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT '',
    "type2" TEXT NOT NULL DEFAULT '',
    "craftTime" INTEGER NOT NULL DEFAULT 0,
    "cost" REAL NOT NULL DEFAULT 0,
    "price" REAL NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "materials" TEXT NOT NULL DEFAULT '{}',
    "components" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameTask" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "chance" REAL NOT NULL DEFAULT 100,
    "level" INTEGER NOT NULL DEFAULT 1,
    "publisher" TEXT NOT NULL DEFAULT '',
    "requirements" TEXT NOT NULL DEFAULT '[]',
    "rewards" TEXT NOT NULL DEFAULT '[]',
    "nextTasks" TEXT NOT NULL DEFAULT '[]',
    "restrictMarkers" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameTitle" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "requirements" TEXT NOT NULL DEFAULT '[]',
    "rewards" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameVehicle" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT '',
    "owner" TEXT NOT NULL DEFAULT '',
    "driver" TEXT NOT NULL DEFAULT '',
    "moveType" INTEGER NOT NULL DEFAULT 0,
    "maxHp" REAL NOT NULL DEFAULT 100,
    "currentHp" REAL NOT NULL DEFAULT 100,
    "mapIndex" INTEGER NOT NULL DEFAULT 0,
    "weaponSlots" INTEGER NOT NULL DEFAULT 0,
    "defenseSlots" INTEGER NOT NULL DEFAULT 0,
    "moveSlots" INTEGER NOT NULL DEFAULT 0,
    "functionSlots" INTEGER NOT NULL DEFAULT 0,
    "maxWeapon" INTEGER NOT NULL DEFAULT 5,
    "maxDefense" INTEGER NOT NULL DEFAULT 5,
    "maxMove" INTEGER NOT NULL DEFAULT 5,
    "maxFunction" INTEGER NOT NULL DEFAULT 5,
    "slotStatus" INTEGER NOT NULL DEFAULT 0,
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "parts" TEXT NOT NULL DEFAULT '[]',
    "markers" TEXT NOT NULL DEFAULT '{}',
    "markers2" TEXT NOT NULL DEFAULT '[]',
    "recipes" TEXT NOT NULL DEFAULT '[]',
    "builtinParts" TEXT NOT NULL DEFAULT '[]',
    "coating" INTEGER NOT NULL DEFAULT 0,
    "reverseField" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameVehiclePart" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "partType" INTEGER NOT NULL DEFAULT 0,
    "moveType" INTEGER NOT NULL DEFAULT 0,
    "limit" INTEGER NOT NULL DEFAULT 0,
    "production" REAL NOT NULL DEFAULT 0,
    "tagRestrict" TEXT NOT NULL DEFAULT '',
    "weaponEffect" INTEGER NOT NULL DEFAULT 0,
    "defenseEffect" INTEGER NOT NULL DEFAULT 0,
    "moveEffect" INTEGER NOT NULL DEFAULT 0,
    "functionEffect" INTEGER NOT NULL DEFAULT 0,
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "builtinParts" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameShopItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemName" TEXT NOT NULL DEFAULT '',
    "itemType" TEXT NOT NULL DEFAULT '',
    "itemCount" REAL NOT NULL DEFAULT 1,
    "sellerQQ" TEXT NOT NULL DEFAULT '',
    "price" REAL NOT NULL DEFAULT 0,
    "expireAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameBuilding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "storage" REAL NOT NULL DEFAULT 0,
    "materials" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameNpc" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "taskId" TEXT NOT NULL DEFAULT '',
    "hostileChat" TEXT NOT NULL DEFAULT '[]',
    "friendlyChat" TEXT NOT NULL DEFAULT '[]',
    "followText" TEXT NOT NULL DEFAULT '[]',
    "stopText" TEXT NOT NULL DEFAULT '[]',
    "pickupText" TEXT NOT NULL DEFAULT '[]',
    "milkText" TEXT NOT NULL DEFAULT '[]',
    "killText" TEXT NOT NULL DEFAULT '[]',
    "boostStart" TEXT NOT NULL DEFAULT '[]',
    "boostEnd" TEXT NOT NULL DEFAULT '[]',
    "captureText" TEXT NOT NULL DEFAULT '[]',
    "lieDownText" TEXT NOT NULL DEFAULT '[]',
    "wakeUpText" TEXT NOT NULL DEFAULT '[]',
    "strengthenText" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameAttackText" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "forMonster" BOOLEAN NOT NULL DEFAULT false,
    "attackTexts" TEXT NOT NULL DEFAULT '[]',
    "shieldBreak" TEXT NOT NULL DEFAULT '[]',
    "armorBreak" TEXT NOT NULL DEFAULT '[]',
    "killTexts" TEXT NOT NULL DEFAULT '[]',
    "missTexts" TEXT NOT NULL DEFAULT '[]',
    "lockTexts" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channelId" INTEGER NOT NULL,
    "senderId" INTEGER,
    "type" TEXT NOT NULL DEFAULT 'chat',
    "content" TEXT NOT NULL,
    "commandId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CommandLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channelId" INTEGER NOT NULL,
    "senderId" INTEGER NOT NULL,
    "command" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'web',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Command" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "alias" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "handlerKey" TEXT NOT NULL,
    "argsSchema" TEXT NOT NULL DEFAULT '[]',
    "minRole" TEXT NOT NULL DEFAULT 'USER',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'string',
    "group" TEXT NOT NULL DEFAULT 'system',
    "options" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_qqNumber_key" ON "User"("qqNumber");

-- CreateIndex
CREATE INDEX "User_qqNumber_idx" ON "User"("qqNumber");

-- CreateIndex
CREATE UNIQUE INDEX "UserBinding_userId_botKey_key" ON "UserBinding"("userId", "botKey");

-- CreateIndex
CREATE UNIQUE INDEX "Player_userId_key" ON "Player"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GameMap_name_key" ON "GameMap"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameItem_name_key" ON "GameItem"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameEquipment_name_key" ON "GameEquipment"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameFamiliar_name_key" ON "GameFamiliar"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameMonster_name_key" ON "GameMonster"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameBuff_name_key" ON "GameBuff"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameCrafting_name_key" ON "GameCrafting"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameBlueprint_name_key" ON "GameBlueprint"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameTask_name_key" ON "GameTask"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameTitle_name_key" ON "GameTitle"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameVehicle_name_key" ON "GameVehicle"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameVehiclePart_name_key" ON "GameVehiclePart"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameBuilding_name_key" ON "GameBuilding"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameNpc_name_key" ON "GameNpc"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameAttackText_name_key" ON "GameAttackText"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");

-- CreateIndex
CREATE INDEX "ChatMessage_channelId_createdAt_idx" ON "ChatMessage"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "CommandLog_channelId_createdAt_idx" ON "CommandLog"("channelId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Command_name_key" ON "Command"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "SystemConfig"("key");
