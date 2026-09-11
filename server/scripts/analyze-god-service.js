/**
 * 只读分析脚本：把 game.service.ts 的方法按「限界上下文」归类并统计行数。
 * 仅用于重构规划，不修改任何业务代码。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '../src/modules/game/game.service.ts');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);

const NAME_RE = /^  (private |public |protected )?(async )?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const methods = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(NAME_RE);
  if (m && !lines[i].includes('=') && !lines[i].trim().startsWith('*')) {
    methods.push({ name: m[3], start: i + 1 });
  }
}
for (let i = 0; i < methods.length; i++) {
  methods[i].end = i + 1 < methods.length ? methods[i + 1].start - 1 : lines.length;
  methods[i].size = methods[i].end - methods[i].start + 1;
}

// 分组规则：按方法名匹配，顺序敏感（先匹配者优先）
const GROUPS = [
  ['管理/GM 指令', /^(handleAdmin|finishNowForUser|getAdminHelpText|formatUptime)/],
  ['排行系统', /^(handleRanking|handleFamiliarRank|handleCombatPowerRanking|handleLevelRanking|handleTheoreticalDamageRanking|handleMaxDamageRanking|handleKillCountRanking|handleOnlineTimeRanking|handlePetRanking|handleWealthRanking|handleVehicleValueRanking|recordRankingStats|collectPlayerMarkerEntries|isRankablePlayer|formatRankingText|displayDamage|secondsToTimeText|pushVehicleParts|RANKING_SUB_TYPES)/],
  ['救援/白系统', /^(handleRescue|handleHelpUp|handleReviveFamiliar|beginSelfRescue|parseRescue|createRescueMarker|getActiveRescueMarker|rescue[A-Z]|firstPositiveNumber|hasActiveRescueBuff|shortenRescueBuff|saveRescueMap|claimRescueMarker|scheduleRescueCompletion|completeRescue|applyCompleteRescue|applyWhiteAngelRevivalTeleport|materializeWhiteSummon|ensurePlayerWhite|syncWhiteAffinity|resolveRespawnMapId|findWhiteAngelMapId|setRescueHp|isDamagedRescueVehicle|hasActiveRescueBuff)/],
  ['载具系统', /^(handleVehicle|handleAssembleVehicle|handleDriveVehicle|handleDriveVehicle|handleNameVehicle|handleSimulateVehicle|handleRepairVehicle|handleExitVehicle|handleTakeoverVehicle|handleStopTakeover|handleDeployCannon|handleCallVehicle|handleViewVehicles|getSlotLimit|calcVehicleTotalBonus|toRuntimeVehicle|toStoredVehicle|vehicleDbData|persistRuntimeVehicle|findProductionVehicle|vehicleProductionOptions|formatVehicleItems|formatVehicleTime|parseVehicleAssemblyParts|craftVehiclePart|assembleVehicleFromParts|hasOwnedProductionVehicle|completeVehicleRepair|applyCompleteVehicleRepair|applyVehicleRepair|findVehicleOverLimitPart|pushVehicleParts)/],
  ['采集/探测系统', /^(handleMine|handleGather|handleAutoMine|handleStopMine|handleProbe|handlePickup|mineByVehicle|mineResourcePoint|settleManualMine|collectVehiclePartNames|summonFollowDisplay|randomInt|hasGatherCmd|getOpenBoxLockText|applySettleGatherResource|takePendingGather|clearStaleGatherLock|countFollowingSummons|getGatherExpBonus|parseResourceOutputs|resolveGatherCmd|getGatherResources|getGatherResourceField|isGatherResourceAvailable|getPlayerMarkers|hasOutputs2|parseResourceOutputName|getResourceTimes|parseGatherCommand|getGatherMultiplier|getGatherDropRate|formatGatherNumber|hasBuildingOnMap|formatMapResourceYield)/],
  ['商店/交易系统', /^(handleTrade|handleHomeTrade|handleShop|handleActivityShop|handleDiamondShop|handleDataShop|handleAutoShop|handleGive|findMerchantInSummons|parseJsonArray|checkMerchantPurchaseGate|itemQuantity|formatMerchantItem|formatMerchantItems|addItemToCollection|hasEnoughResources|generateMerchantResource|generateMerchantInventory|buildMerchantInventory|purchaseMerchantItem|deductBackpackItem|handleRecipe|handleRecipeUnlock|handleReverse|readReverseProficiencies|reverse[A-Z]|setReverseProficiency|itemName|itemType|reverseValue|formatReverse[A-Z]|saveReverseResult)/],
  ['合成/融合/培育', /^(handleForge|handleMerge|fusion[A-Z]|handleFusion|activateFusionEffectWithoutArtisan|hasFusionArtisan|isFusion[A-Za-z]*|getFusionEffects|randomFusionEffectId|fusionDataParts|rewriteFusionData|setFusionBonus|upgradeFusionData|correctFusionAttributes|handleBreed|handleAlchemy)/],
  ['副本/挑战/刷怪', /^(handleStartBattle|handleSweep|handleSweepInner|parseSweepMonsterNames|getSweepRequirement|buildSweepRequirementText|handleDodge|handleStartDungeon|handleRefreshDungeon|handleClearDungeon|parseDungeonArray|normalizeDungeonMarkers2|handleFamiliarChallenge|handleStartChallenge|familiarChallengeNextLayer|handleSpawnArtisan|handleSpawnWreck|handleRefreshMonster|handleSpawnNpc|handleDeleteMonster|hasEquip|setMarkers2)/],
  ['宠物/召唤物', /^(handlePet|handleViewPets|handleAll[A-Z]|handleMilk|settleMilk|formatMilkRemaining|hasActiveMilkMarker|isMilkSpecial|getMilkAmount|addSummonMilkAffinity|handleShear|handleFollowAll|handleStartCapture|handleStopCapture|updateOwnedSummonMode|handleMassSummon)/],
  ['家园/建造系统', /^(handleHome|handleFamiliarHome|handleBuildHouse|handleDigFoundation|handleBuildFoundation|handleClaimLand|handleProduce|handleInstall|handleUninstall|handleAssembleBuilding|tryUninstallHomeBuilding|handleViewCrops|handleViewBuildings|handleViewHomes|handleViewFamiliar|handleFamiliarData|handleFamiliarMore|handleSignalGun|completeCargoSummon|applyCargoSummon)/],
  ['技能/变身系统', /^(handleSkill|handleFamiliarSkills|handleCommonSkills|skillLevelInfo|handleFamiliarTitles|handleClaimTitle|handleEquipTitle|handleSwitchMode|handleModeChange|handleTransform|handleTransformText|handleNanoSuit|handleArmorCombine|handleEaseAngel|handleGospel|handleApocalypse|handleTractorBeam|handleControlTerminal|bondSkillLabel|handleWhiteBondTerminal|handleViewSkills|handleProductionMode|handleAmplifierHelp|handleVehicleOps)/],
  ['装备/强化系统', /^(handleEquip|handleUnequip|handleSwitchWeapon|handleEquip[A-Z]|listEquipPresets|calcPresetBonus|formatBonusText|handlePresetSwitch|handleRepairItem|handleEnhance|handleViewImplant|handleSwitchImplant|handleResetImplant|handleViewAmplifier|handleSwitchAmplifier|handleResetAmplifier|handleConfirmReset|handlePassiveEffects|handleViewEquip|handleCompareEquip|handleViewSafe)/],
  ['背包/物品系统', /^(handleInventory|getBackpackDisplayItems|handleResourceBag|handleSearchBag|handleSearchSafe|handleBagOps|handleUseItem|handleUseAllItems|getSeedCropName|handleUseSeed|handleViewUnit|handleViewDescription|handleViewMarkers)/],
  ['玩家面板/属性渲染', /^(buildPlayerInfo|buildPendingActions|buildActiveTasks|buildEquipmentSnapshot|formatBuffList|buildActiveBuffs|pushPlayerUpdate|doPushPlayerUpdate|pushMapUpdate|doPushMapUpdate|nextRev|getMapOverview|getNearbyPlayers|handleInfo|handleStatus|handleLookAround|handleViewPlayer|handleMap|handleViewAchievements|handleViewDescription)/],
  ['移动/传送/导航', /^(handleMove|handleTeleport|handleFlyTo|handleArriveAt|findTravelVehicle|scheduleArrival|performArrival|applyPerformArrival|applyArrivalTriggers|shearPranaCubsOnArrival|migratePlayerAssetsOnMove|applyFoxAutoAttack|getMovementPathLength|getDistance)/],
  ['时间结算/登录', /^(calculateTimeElapsed|settleTimeElapsed|mutateForTimeElapsed|localTodayString|settleDailyLogin|getActionHints|hasTrainerAccess|handleDailyCheckin|handleRecharge)/],
  ['延时任务/结算入口', /^(onModuleInit|recoverOrphanDelayedMarkers|handleReload|scheduleReloadCompletion|completeReload|currentWeaponItem|equipmentSpecialSeq|hasEquippedSpecial|incrementMarker|normalizeMarkers2|handleRefill|completeRefill|handleSaveImage|handleStartSaveImage|handleStopSaveImage|mutatePlayer)/],
  ['任务/图鉴/对话/帮助', /^(handleAcceptQuest|parseNpcMarkers|getQuestSources|splitQuestNames|questUnitName|handleViewQuests|handleCompleteQuest|handleAbandonQuest|handleHandbook|handleGameIntro|handleGameTerms|handleMoreHelp|handleChangelog|handleHelpMe|handleTalk|genericNpcChatLine|buildUnitDialogue|millisecondsToText|round2Text|handleDialogue|handlePrivateChat|handleFeedback|handleTextSend|handleCalculate|handleMenu|handleFunctionMenu|handleGameMenu|handleRefreshData|handleReloadData|handleConfirmReloadData|handleSetMeatRatio|handleSettings|toggleSetting|handleChat|normalizeDungeonMarkers2|getFirstFamiliarGate|triggerAutoFamiliarSkill|buildNumberedMenu|handleGive|handleFeedback|roundText|parseRescueObject|resolveGatherCmd)/],
];

const assigned = new Set();
const result = [];
for (const [label, re] of GROUPS) {
  const hit = methods.filter((m) => !assigned.has(m.name) && re.test(m.name));
  hit.forEach((m) => assigned.add(m.name));
  result.push({ label, count: hit.length, size: hit.reduce((s, m) => s + m.size, 0) });
}
const leftover = methods.filter((m) => !assigned.has(m.name));
result.push({ label: '（未归类·兜底）', count: leftover.length, size: leftover.reduce((s, m) => s + m.size, 0) });

result.sort((a, b) => b.size - a.size);
const total = methods.reduce((s, m) => s + m.size, 0);
console.log(`总方法数 ${methods.length}，方法体总行数 ${total}（文件 ${lines.length} 行）\n`);
console.log('组名'.padEnd(24) + '方法数'.padStart(8) + '行数'.padStart(10) + '占比'.padStart(9));
for (const r of result) {
  console.log(r.label.padEnd(24) + String(r.count).padStart(8) + String(r.size).padStart(10) + ((r.size / total) * 100).toFixed(1).padStart(8) + '%');
}
console.log('\n--- 未归类明细（前 80）---');
console.log(leftover.slice(0, 80).map((m) => `${m.name}(${m.size})`).join(', '));
