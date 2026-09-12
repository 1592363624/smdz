/**
 * 只读分析脚本：构建 game.service.ts 内的方法级调用图，
 * 统计「跨分组调用边」，用于判断按限界上下文拆分的可行性（是否成环）。
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
    methods.push({ name: m[3], start: i, end: lines.length - 1 });
  }
}
for (let i = 0; i < methods.length; i++) {
  methods[i].end = i + 1 < methods.length ? methods[i + 1].start - 1 : lines.length - 1;
}
const byName = new Map(methods.map((m) => [m.name, m]));

// 已入库的注入依赖名（这些是服务字段，不是方法）
const deps = [...src.matchAll(/private readonly ([a-zA-Z][a-zA-Z0-9_]*)\s*[,:)]/g)].map((m) => m[1]);
const depSet = new Set(deps);
const selfFields = [...src.matchAll(/this\.([a-zA-Z][a-zA-Z0-9_]*)\s*=/g)].map((m) => m[1]);

// 分组规则（与 analyze-god-service.js 一致的简化版：按名字前缀粗分）
const GROUP_RULES = [
  ['vehicle', /^(handleVehicle|handleAssembleVehicle|handleDriveVehicle|handleNameVehicle|handleSimulateVehicle|handleRepairVehicle|handleExitVehicle|handleTakeoverVehicle|handleStopTakeover|handleDeployCannon|handleCallVehicle|handleViewVehicles|getSlotLimit|calcVehicleTotalBonus|toRuntimeVehicle|toStoredVehicle|vehicleDbData|persistRuntimeVehicle|findProductionVehicle|vehicleProductionOptions|formatVehicleItems|formatVehicleTime|parseVehicleAssemblyParts|craftVehiclePart|assembleVehicleFromParts|hasOwnedProductionVehicle|completeVehicleRepair|applyCompleteVehicleRepair|applyVehicleRepair|findVehicleOverLimitPart|pushVehicleParts|handleVehicleOps)/],
  ['gather', /^(handleMine|handleGather|handleAutoMine|handleStopMine|handleProbe|handlePickup|mineByVehicle|mineResourcePoint|settleManualMine|collectVehiclePartNames|summonFollowDisplay|randomInt|hasGatherCmd|getOpenBoxLockText|applySettleGatherResource|takePendingGather|clearStaleGatherLock|countFollowingSummons|getGatherExpBonus|parseResourceOutputs|resolveGatherCmd|getGatherResources|getGatherResourceField|isGatherResourceAvailable|getPlayerMarkers|hasOutputs2|parseResourceOutputName|getResourceTimes|parseGatherCommand|getGatherMultiplier|getGatherDropRate|formatGatherNumber|hasBuildingOnMap|formatMapResourceYield|settleGatherResource)/],
  ['shop', /^(handleTrade|handleHomeTrade|handleShop|handleActivityShop|handleDiamondShop|handleDataShop|handleAutoShop|handleGive|findMerchantInSummons|parseJsonArray|checkMerchantPurchaseGate|itemQuantity|formatMerchantItem|formatMerchantItems|addItemToCollection|hasEnoughResources|generateMerchantResource|generateMerchantInventory|buildMerchantInventory|purchaseMerchantItem|deductBackpackItem|handleRecipe|handleRecipeUnlock|handleReverse|readReverseProficiencies|reverse[A-Za-z]*|setReverseProficiency|formatReverse[A-Za-z]*|saveReverseResult)/],
  ['ranking', /^(handleRanking|handleFamiliarRank|handleCombatPowerRanking|handleLevelRanking|handleTheoreticalDamageRanking|handleMaxDamageRanking|handleKillCountRanking|handleOnlineTimeRanking|handlePetRanking|handleWealthRanking|handleVehicleValueRanking|recordRankingStats|collectPlayerMarkerEntries|isRankablePlayer|formatRankingText|displayDamage|secondsToTimeText)/],
  ['rescue', /^(handleRescue|handleHelpUp|handleReviveFamiliar|beginSelfRescue|parseRescue[A-Za-z]*|createRescueMarker|getActiveRescueMarker|rescue[A-Z][A-Za-z]*|firstPositiveNumber|hasActiveRescueBuff|shortenRescueBuff|saveRescueMap|claimRescueMarker|scheduleRescueCompletion|completeRescue|applyCompleteRescue|applyWhiteAngel[A-Za-z]*|materializeWhiteSummon|ensurePlayerWhite|syncWhiteAffinity|resolveRespawnMapId|findWhiteAngelMapId|setRescueHp|setRescueVehicleHp|isDamagedRescueVehicle|claimRescueMarker)/],
  ['pet', /^(handlePet|handleViewPets|handleAll[A-Z][A-Za-z]*|handleMilk|settleMilk|formatMilkRemaining|hasActiveMilkMarker|isMilkSpecial|getMilkAmount|addSummonMilkAffinity|handleShear|handleFollowAll|handleStartCapture|handleStopCapture|updateOwnedSummonMode|handleMassSummon)/],
  ['admin', /^(handleAdmin|finishNowForUser|getAdminHelpText|formatUptime)/],
  ['movement', /^(handleMove|handleTeleport|handleFlyTo|handleArriveAt|findTravelVehicle|scheduleArrival|performArrival|applyPerformArrival|applyArrivalTriggers|shearPranaCubsOnArrival|migratePlayerAssetsOnMove|applyFoxAutoAttack|getMovementPathLength|getDistance)/],
  ['panel', /^(buildPlayerInfo|buildPendingActions|buildActiveTasks|buildEquipmentSnapshot|formatBuffList|buildActiveBuffs|pushPlayerUpdate|doPushPlayerUpdate|pushMapUpdate|doPushMapUpdate|nextRev|getMapOverview|getNearbyPlayers|handleInfo|handleStatus|handleLookAround|handleViewPlayer)/],
  ['home', /^(handleHome|handleFamiliarHome|handleBuildHouse|handleDigFoundation|handleBuildFoundation|handleClaimLand|handleProduce|handleInstall|handleUninstall|handleAssembleBuilding|tryUninstallHomeBuilding|handleViewCrops|handleViewBuildings|handleViewHomes|handleViewFamiliar|handleFamiliarData|handleFamiliarMore|handleSignalGun|completeCargoSummon|applyCargoSummon)/],
  ['skill', /^(handleSkill|handleFamiliarSkills|handleCommonSkills|skillLevelInfo|handleFamiliarTitles|handleClaimTitle|handleEquipTitle|handleSwitchMode|handleModeChange|handleTransform|handleTransformText|handleNanoSuit|handleArmorCombine|handleEaseAngel|handleGospel|handleApocalypse|handleTractorBeam|handleControlTerminal|bondSkillLabel|handleWhiteBondTerminal|handleViewSkills|handleProductionMode|handleAmplifierHelp)/],
  ['equip', /^(handleEquip|handleUnequip|handleSwitchWeapon|handleEquip[A-Z][A-Za-z]*|listEquipPresets|calcPresetBonus|formatBonusText|handlePresetSwitch|handleRepairItem|handleEnhance[A-Za-z]*|handleViewImplant|handleSwitchImplant|handleResetImplant|handleViewAmplifier|handleSwitchAmplifier|handleResetAmplifier|handleConfirmReset[A-Za-z]*|handlePassiveEffects|handleViewSafe|handleCompareEquip)/],
  ['dungeon', /^(handleStartBattle|handleSweep|handleSweepInner|parseSweepMonsterNames|getSweepRequirement|buildSweepRequirementText|handleDodge|handleStartDungeon|handleRefreshDungeon|handleClearDungeon|parseDungeonArray|normalizeDungeonMarkers2|handleFamiliarChallenge|handleStartChallenge|familiarChallengeNextLayer|handleSpawnArtisan|handleSpawnWreck|handleRefreshMonster|handleSpawnNpc|handleDeleteMonster|setMarkers2)/],
  ['quest', /^(handleAcceptQuest|parseNpcMarkers|getQuestSources|splitQuestNames|questUnitName|handleViewQuests|handleCompleteQuest|handleAbandonQuest|handleHandbook|handleGameIntro|handleGameTerms|handleMoreHelp|handleChangelog|handleHelpMe|handleTalk|genericNpcChatLine|buildUnitDialogue|millisecondsToText|round2Text|handleDialogue[A-Za-z]*|handlePrivateChat|handleFeedback|handleTextSend|handleCalculate|handleMenu|handleFunctionMenu|handleGameMenu|handleRefreshData|handleReloadData|handleConfirmReloadData|handleSetMeatRatio|handleSettings|toggleSetting|getFirstFamiliarGate|triggerAutoFamiliarSkill|buildNumberedMenu)/],
  ['time', /^(calculateTimeElapsed|settleTimeElapsed[A-Za-z]*|mutateForTimeElapsed|localTodayString|settleDailyLogin|getActionHints|hasTrainerAccess|handleDailyCheckin|handleRecharge)/],
  ['delayed', /^(onModuleInit|recoverOrphanDelayedMarkers|handleReload|scheduleReloadCompletion|completeReload|currentWeaponItem|equipmentSpecialSeq|hasEquippedSpecial|incrementMarker|normalizeMarkers2|handleRefill|completeRefill|handleSaveImage|handleStartSaveImage|handleStopSaveImage|mutatePlayer|hasEquip)/],
];

function groupOf(name) {
  for (const [g, re] of GROUP_RULES) if (re.test(name)) return g;
  return '(base)';
}

const edges = new Map(); // "from->to" -> count
let selfCall = 0;
let depCall = 0;
for (const m of methods) {
  const body = lines.slice(m.start, m.end + 1).join('\n');
  for (const c of body.matchAll(/this\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    const callee = c[1];
    if (depSet.has(callee)) { depCall++; continue; }
    if (!byName.has(callee)) continue;
    if (callee === m.name) { selfCall++; continue; }
    const key = `${groupOf(m.name)} -> ${groupOf(callee)}`;
    edges.set(key, (edges.get(key) || 0) + 1);
  }
}

const cross = [...edges.entries()].filter(([k]) => {
  const [a, b] = k.split(' -> ');
  return a !== b;
}).sort((a, b) => b[1] - a[1]);

console.log(`方法数 ${methods.length}；服务依赖调用 ${depCall} 处；同方法自递归 ${selfCall} 处`);
console.log(`跨分组调用边 ${cross.length} 条，总计 ${cross.reduce((s, [, c]) => s + c, 0)} 次\n`);
console.log('跨分组调用 TOP 40（from -> to : 次数）：');
for (const [k, v] of cross.slice(0, 40)) console.log(`  ${String(v).padStart(4)}  ${k}`);

// 检测双向环（A->B 且 B->A）
const pairSet = new Set(cross.map(([k]) => k));
const cycles = [];
for (const [k] of cross) {
  const [a, b] = k.split(' -> ');
  if (pairSet.has(`${b} -> ${a}`)) cycles.push(`${a} <-> ${b}`);
}
console.log(`\n双向环（需要 forwardRef 或调整分组的组对）：${cycles.length ? [...new Set(cycles)].join(', ') : '无'}`);
