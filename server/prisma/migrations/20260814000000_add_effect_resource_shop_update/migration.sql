-- CreateTable
CREATE TABLE "GameEffect" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "limit" TEXT NOT NULL DEFAULT '',
    "bonus" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameResource" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "times" INTEGER NOT NULL DEFAULT 1,
    "gatherCmd" TEXT NOT NULL DEFAULT '',
    "timeScale" REAL NOT NULL DEFAULT 1,
    "renewable" BOOLEAN NOT NULL DEFAULT true,
    "gatherText" TEXT NOT NULL DEFAULT '',
    "marker" TEXT NOT NULL DEFAULT '',
    "proxySpeak" TEXT NOT NULL DEFAULT '',
    "outputs" TEXT NOT NULL DEFAULT '[]',
    "outputs2" TEXT NOT NULL DEFAULT '[]',
    "useGet" TEXT NOT NULL DEFAULT '[]',
    "useMarkers" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameShop" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopActivity" TEXT NOT NULL DEFAULT '[]',
    "shopDiamond" TEXT NOT NULL DEFAULT '[]',
    "shopData" TEXT NOT NULL DEFAULT '[]',
    "dungeons" TEXT NOT NULL DEFAULT '[]',
    "dungeons2" TEXT NOT NULL DEFAULT '[]',
    "robotQQ" TEXT NOT NULL DEFAULT '',
    "familiarImg" TEXT NOT NULL DEFAULT '{}',
    "characterImg" TEXT NOT NULL DEFAULT '{}',
    "monsterImg" TEXT NOT NULL DEFAULT '{}',
    "mapImg" TEXT NOT NULL DEFAULT '{}',
    "travelingEquip" TEXT NOT NULL DEFAULT '[]',
    "travelingItem" TEXT NOT NULL DEFAULT '[]',
    "bgm" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameUpdateLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GameEffect_name_key" ON "GameEffect"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameResource_name_key" ON "GameResource"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GameUpdateLog_name_key" ON "GameUpdateLog"("name");
