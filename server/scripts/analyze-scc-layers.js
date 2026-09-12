/**
 * 只读分析脚本：把 game.service.ts 的方法按限界上下文归类，
 * 构建「组级依赖图」，用 Tarjan 求强连通分量（SCC）并缩点得到 DAG 分层。
 * 输出可直接作为重构方案的依据：哪些组是叶子、哪些环必须 forwardRef、共享支撑层成员是谁。
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
  // 只排除箭头函数属性行与注释行；不能排除含 `=` 的行——
  // 带默认参数值的方法声明（如 `handleSweep(userId, requestedCount = 0)`）
  // 曾被 `includes('=')` 一并误杀，导致其方法体并入前一个方法、调用边错归属
  //（P1-0 刷新时修复，2026-09-12）。
  if (m && !/=>\s*\{?\s*$/.test(lines[i]) && !lines[i].trim().startsWith('*')) {
    methods.push({ name: m[3], start: i, end: lines.length - 1 });
  }
}
for (let i = 0; i < methods.length; i++) {
  methods[i].end = i + 1 < methods.length ? methods[i + 1].start - 1 : lines.length - 1;
  methods[i].size = methods[i].end - methods[i].start + 1;
}
const byName = new Map(methods.map((m) => [m.name, m]));

// 组定义：每个组给一组精确方法名（来自实测方法清单），避免正则误吞。
const G = {
  quest: ['handleViewUnit','handleTalk','genericNpcChatLine','buildUnitDialogue','handleDialogueLuna','handleArriveAt','handleDialogueYongxing','handleDialogueLittleDemon','handleSetMeatRatio','handleAcceptQuest','parseNpcMarkers','getQuestSources','splitQuestNames','questUnitName','handleViewQuests','handleCompleteQuest','handleAbandonQuest','handleHandbook','handleGameIntro','handleGameTerms','handleMoreHelp','handleChangelog','handleHelpMe','handlePrivateChat','handleFeedback','handleTextSend','handleCalculate','handleMenu','handleFunctionMenu','handleGameMenu','handleRefreshData','handleReloadData','handleConfirmReloadData','handleSettings','toggleSetting','handleSettingsGuide','handleSettingsRandom','handleSettingsGather','handleSettingsVitality','handleSettingsNoHelp','handleSettingsMusic','handleSettingsMultiplier','handleSettingsShop','handleSettingsLocation','handleSettingsMarker','getFirstFamiliarGate','triggerAutoFamiliarSkill','millisecondsToText','round2Text','handleConfirmHelp','handleProduce'],
  vehicle: ['handleVehicleProduction','getSlotLimit','calcVehicleTotalBonus','toRuntimeVehicle','toStoredVehicle','vehicleDbData','persistRuntimeVehicle','findProductionVehicle','vehicleProductionOptions','formatVehicleItems','formatVehicleTime','handleVehicleStatus','handleAssembleVehicle','handleDriveVehicle','parseVehicleAssemblyParts','craftVehiclePart','assembleVehicleFromParts','hasOwnedProductionVehicle','handleNameVehicle','handleSimulateVehicle','handleRepairVehicle','completeVehicleRepair','applyCompleteVehicleRepair','applyVehicleRepair','findVehicleOverLimitPart','handleExitVehicle','handleTakeoverVehicle','handleStopTakeover','handleDeployCannon','handleCallVehicle','handleViewVehicles','handleVehicleOps','pushVehicleParts','handleVehicleValueRanking'],
  gather: ['handleMine','mineByVehicle','mineResourcePoint','settleManualMine','collectVehiclePartNames','summonFollowDisplay','randomInt','hasGatherCmd','getOpenBoxLockText','handleGatherResource','settleGatherResource','applySettleGatherResource','takePendingGather','clearStaleGatherLock','countFollowingSummons','getGatherExpBonus','parseResourceOutputs','resolveGatherCmd','getGatherResources','getGatherResourceField','isGatherResourceAvailable','getPlayerMarkers','hasOutputs2','parseResourceOutputName','getResourceTimes','parseGatherCommand','getGatherMultiplier','getGatherDropRate','formatGatherNumber','handleProbe','handleProbeRadar','handleProbeResources','handleProbeAndPickup','handleProbeCrops','hasBuildingOnMap','formatMapResourceYield','handlePickup','handleAutoMine','handleStopMine'],
  panel: ['buildPlayerInfo','buildPendingActions','buildActiveTasks','buildEquipmentSnapshot','formatBuffList','buildActiveBuffs','pushPlayerUpdate','doPushPlayerUpdate','pushMapUpdate','doPushMapUpdate','nextRev','getMapOverview','getNearbyPlayers','handleInfo','handleStatus','handleLookAround','handleViewPlayer','getDistance','handleMap','handleLieDown','handleGetUp'],
  movement: ['handleMove','handleTeleport','handleFlyTo','findTravelVehicle','scheduleArrival','performArrival','applyPerformArrival','applyFoxAutoAttack','applyArrivalTriggers','shearPranaCubsOnArrival','migratePlayerAssetsOnMove','getMovementPathLength'],
  shop: ['withTradeLock','handleTrade','handleHomeTrade','handleShop','handleActivityShop','handleDiamondShop','handleDataShop','handleAutoShop','handleGive','findMerchantInSummons','checkMerchantPurchaseGate','formatMerchantItem','formatMerchantItems','hasEnoughResources','generateMerchantResource','generateMerchantInventory','buildMerchantInventory','purchaseMerchantItem','handleRecipe','handleRecipeUnlock','handleReverse','readReverseProficiencies','reverseProficiency','setReverseProficiency','reverseValue','reverseItemFailure','reverseOne','reverseAllEligible','formatReverseMenu','formatReverseBatchResult','formatReverseSingleResult','saveReverseResult'], // P2-8 起为门面委托
  dungeon: ['handleStartBattle','handleSweep','handleSweepInner','parseSweepMonsterNames','getSweepRequirement','buildSweepRequirementText','handleDodge','handleStartDungeon','handleRefreshDungeon','handleClearDungeon','parseDungeonArray','normalizeDungeonMarkers2','handleFamiliarChallenge','handleStartChallenge','familiarChallengeNextLayer','handleSpawnArtisan','handleSpawnWreck','handleRefreshMonster','handleSpawnNpc','handleDeleteMonster'],
  skill: ['handleSkill','handleFamiliarSkills','handleCommonSkills','skillLevelInfo','handleFamiliarTitles','handleClaimTitle','handleEquipTitle','handleSwitchMode','handleModeChange','handleTransform','handleTransformText','handleNanoSuit','handleArmorCombine','handleEaseAngel','handleGospel','handleApocalypse','handleTractorBeam','handleControlTerminal','bondSkillLabel','handleWhiteBondTerminal','handleViewSkills','handleProductionMode','handleAmplifierHelp'], // P2-7 起为门面委托
  home: ['handleHome','handleFamiliarHome','handleBuildHouse','handleDigFoundation','handleBuildFoundation','handleClaimLand','handleInstall','handleInstallHomeFuel','handleAssembleBuilding','handleInstallPart','handleUninstallPart','tryUninstallHomeBuilding','handleInstallAll','handleUninstallAll','handleViewCrops','handleViewBuildings','handleViewHomes','handleViewFamiliar','handleFamiliarData','handleFamiliarMore','handleSignalGun','completeCargoSummon','applyCargoSummon','updateMapBuildings'],
  equip: ['handleEquip','handleUnequip','handleSwitchWeapon','handleEquipEnhance','handleEquipBonus','handleEquipPreset','listEquipPresets','calcPresetBonus','formatBonusText','handlePresetSwitch','handleRepairItem','handleEnhanceImplant','handleViewImplant','handleSwitchImplant','handleResetImplant','handleConfirmResetImplant','handleViewAmplifier','handleSwitchAmplifier','handleEnhanceAmplifier','handleResetAmplifier','handleConfirmResetAmplifier','handlePassiveEffects','handleViewEquip','handleCompareEquip','handleViewSafe'], // P2-6 起为门面委托（实体在 commands/equip-command.service.ts）
  rescue: ['handleRescue','handleHelpUp','handleReviveFamiliar','beginSelfRescue','parseRescueArray','parseRescueMarkers','createRescueMarker','getActiveRescueMarker','rescueExpireAtSeconds','remainingRescueSeconds','rescueActionText','formatRescueSeconds','rescueHp','rescueMaxHp','firstPositiveNumber','parseRescueObject','setRescueHp','rescueUnitId','rescueUnitName','rescueVehicleKey','rescueVehicleKeys','rescueVehicleMaxHp','rescueVehicleHp','isDamagedRescueVehicle','setRescueVehicleHp','hasActiveRescueBuff','shortenRescueBuff','saveRescueMap','claimRescueMarker','scheduleRescueCompletion','completeRescue','applyCompleteRescue','applyWhiteAngelRevivalTeleport','materializeWhiteSummon','ensurePlayerWhite','syncWhiteAffinity','resolveRespawnMapId','findWhiteAngelMapId'],
  pet: ['handleViewPets','handlePetOps','handlePetRename','handlePetTransfer','handleAllStop','handleAllActive','handleAllPassive','handleAllMilk','handleAllCommands','handleMilk','settleMilk','formatMilkRemaining','hasActiveMilkMarker','isMilkSpecial','getMilkAmount','addSummonMilkAffinity','handleShear','handleFollowAll','handleStartCapture','handleStopCapture','handleMassSummon','handlePetDrive','handlePetFeed','handlePetSniff','handlePetAwaken','handlePetAttack','handlePetGoto','handlePetEquip'], // P2-5 起为门面委托 // P2-5 起为门面委托
  time: ['calculateTimeElapsed','settleTimeElapsedOnDisconnect','settleTimeElapsedOnReconnect','mutateForTimeElapsed','localTodayString','settleDailyLogin','getActionHints','hasTrainerAccess','handleDailyCheckin','handleRecharge'],
  delayed: ['onModuleInit','recoverOrphanDelayedMarkers','handleReload','scheduleReloadCompletion','completeReload','currentWeaponItem','equipmentSpecialSeq','hasEquippedSpecial','incrementMarker','normalizeMarkers2','handleRefill','completeRefill','handleSaveImage','handleStartSaveImage','handleStopSaveImage','setMarkers2'],
  inventory: ['handleInventory','getBackpackDisplayItems','handleResourceBag','handleSearchBag','handleSearchSafe','handleBagOps','handleUseItem','handleUseAllItems','getSeedCropName','handleUseSeed','handleViewDescription','handleViewMarkers','handleViewMarkers2','backpackQuantity','addBackpackItem'],
  fusion: ['handleForge','handleMerge','fusionHelpText','handleFusion23','activateFusionEffectWithoutArtisan','handleFusion23WangDamage','handleFusion23SelectedEffect','hasFusionArtisan','isFusionAmplifier','fusionHasEffect','isFusionWeapon','getFusionEffects','randomFusionEffectId','fusionDataParts','rewriteFusionData','setFusionBonus','upgradeFusionData','correctFusionAttributes','handleBreed','handleAlchemy'], // P2-3 起为门面委托（实体在 commands/fusion-craft.service.ts）
  admin: ['handleAdminFinishNow','handleAdminCommand','getAdminHelpText','handleAdminStatus','handleAdminAnnounce','handleAdminSetWorldLevel','handleAdminGiveItem','handleAdminPlayerList','handleAdminToggleBan','handleAdminUpdateConfig','handleAdminUserList','handleAdminBanByQQ','handleAdminResetPlayer','handleAdminModifyPlayer','handleAdminIntervalMessage','handleAdminBroadcast','finishNowForUser'],
  facade: ['constructor'], // 门面构造器：dts.registerHandler 延时接线 + 启动迁移，永久留门面（C5）
  combat: ['handleAttack'], // 战斗域：一期已知留白（附录 B），L0 无环叶子
  achievement: ['handleViewAchievements'], // 成就域：单方法叶子，随收尾批
  ranking: ['handleFamiliarRank','isRankablePlayer','collectPlayerMarkerEntries','handleCombatPowerRanking','handleLevelRanking','handleTheoreticalDamageRanking','handleMaxDamageRanking','handleKillCountRanking','handleOnlineTimeRanking','handlePetRanking','recordRankingStats','handleRanking','handleWealthRanking','formatRankingText','handleVehicleValueRanking'],
};
// 共享支撑层候选：被 ≥3 个组调用的底层辅助
const SHARED_CANDIDATES = ['advanceTask','pushVehicleParts','buildNumberedMenu','incrementMarker','normalizeMarkers2','hasEquip','setMarkers2','itemName','itemType','itemQuantity','deductBackpackItem','addItemToCollection','addItemToCollection','getPlayerName','getCurrentMap','round2Text','millisecondsToText','formatUptime','randomInt','parseJsonArray','firstPositiveNumber','secondsToTimeText','formatGatherNumber','formatReverseNumber','resolveGatherCmd','updateOwnedSummonMode','hasTrainerAccess'];

const methodGroup = new Map();
for (const [g, list] of Object.entries(G)) for (const n of list) if (byName.has(n) && !methodGroup.has(n)) methodGroup.set(n, g);
for (const n of SHARED_CANDIDATES) if (byName.has(n)) methodGroup.set(n, 'support');

const groups = [...Object.keys(G), 'support', 'unassigned'];
const idx = new Map(groups.map((g, i) => [g, i]));
const adj = new Map(groups.map((g) => [g, new Map()]));

for (const m of methods) {
  const from = methodGroup.get(m.name) || 'unassigned';
  const body = lines.slice(m.start, m.end + 1).join('\n');
  for (const c of body.matchAll(/this\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    const callee = c[1];
    if (!byName.has(callee) || callee === m.name) continue;
    const to = methodGroup.get(callee) || 'unassigned';
    if (to === from) continue;
    adj.get(from).set(to, (adj.get(from).get(to) || 0) + 1);
  }
}

// Tarjan SCC
const N = groups.length;
const index = new Array(N).fill(-1), low = new Array(N).fill(0), onstk = new Array(N).fill(false);
const stk = []; let counter = 0; const sccs = [];
function strongconnect(v) {
  index[v] = low[v] = counter++; stk.push(v); onstk[v] = true;
  for (const to of adj.get(groups[v]).keys()) {
    const w = idx.get(to);
    if (index[w] < 0) { strongconnect(w); low[v] = Math.min(low[v], low[w]); }
    else if (onstk[w]) low[v] = Math.min(low[v], index[w]);
  }
  if (low[v] === index[v]) { const c = []; let w; do { w = stk.pop(); onstk[w] = false; c.push(groups[w]); } while (w !== v); sccs.push(c); }
}
for (let v = 0; v < N; v++) if (index[v] < 0) strongconnect(v);

// 缩点后 DAG 分层（最长路径分层）
const comp = new Map(); sccs.forEach((c, i) => c.forEach((g) => comp.set(g, i)));
const cadj = new Map(sccs.map((_, i) => [i, new Set()]));
const cindeg = new Array(sccs.length).fill(0);
for (const [from, m] of adj) for (const to of m.keys()) {
  const a = comp.get(from), b = comp.get(to);
  if (a !== b && !cadj.get(a).has(b)) { cadj.get(a).add(b); cindeg[b]++; }
}
const layer = new Array(sccs.length).fill(0);
let queue = [];
for (let i = 0; i < sccs.length; i++) if (cindeg[i] === 0) queue.push(i);
const indeg2 = [...cindeg]; let head = 0;
while (head < queue.length) {
  const u = queue[head++];
  for (const v of cadj.get(u)) { layer[v] = Math.max(layer[v], layer[u] + 1); if (--indeg2[v] === 0) queue.push(v); }
}

console.log('='.repeat(72));
console.log('组级依赖（from → to : 调用次数）');
console.log('='.repeat(72));
const rows = [];
for (const [from, m] of adj) for (const [to, n] of m) rows.push({ from, to, n });
rows.sort((a, b) => b.n - a.n);
for (const r of rows) console.log(`  ${String(r.n).padStart(3)}  ${r.from} → ${r.to}`);

console.log('\n' + '='.repeat(72));
console.log('强连通分量（>1 个成员即为必须 forwardRef / 合并的环）');
console.log('='.repeat(72));
let cyclic = 0;
sccs.forEach((c, i) => {
  if (c.length > 1) { cyclic++; console.log(`  SCC#${i} (${c.length} 个): ${c.join(', ')}  → 层级 ${layer[i]}`); }
});
if (!cyclic) console.log('  无环');

console.log('\n' + '='.repeat(72));
console.log('DAG 分层（数字越小越底层，越适合先拆）');
console.log('='.repeat(72));
const byLayer = new Map();
sccs.forEach((c, i) => { const L = layer[i]; if (!byLayer.has(L)) byLayer.set(L, []); byLayer.get(L).push(c.join('+')); });
[...byLayer.keys()].sort((a, b) => a - b).forEach((L) => console.log(`  L${L}: ${byLayer.get(L).join('  |  ')}`));

console.log('\n' + '='.repeat(72));
console.log('各组规模');
console.log('='.repeat(72));
const stat = new Map();
for (const m of methods) { const g = methodGroup.get(m.name) || 'unassigned'; const s = stat.get(g) || { c: 0, l: 0 }; s.c++; s.l += m.size; stat.set(g, s); }
[...stat.entries()].sort((a, b) => b[1].l - a[1].l).forEach(([g, s]) => console.log(`  ${g.padEnd(12)} ${String(s.c).padStart(4)} 方法 ${String(s.l).padStart(6)} 行`));

const un = methods.filter((m) => !methodGroup.has(m.name)).map((m) => m.name);
console.log(`\n未归类 ${un.length} 个：${un.join(', ')}`);

console.log('\n' + '='.repeat(72));
console.log('共享支撑层候选：按「被多少个不同组调用」排序');
console.log('='.repeat(72));
const inDeg = new Map();
for (const m of methods) {
  const from = methodGroup.get(m.name) || 'unassigned';
  const body = lines.slice(m.start, m.end + 1).join('\n');
  for (const c of body.matchAll(/this\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    const callee = c[1];
    if (!byName.has(callee) || callee === m.name) continue;
    if (methodGroup.get(callee) !== 'support') continue;
    if (!inDeg.has(callee)) inDeg.set(callee, new Set());
    inDeg.get(callee).add(from);
  }
}
[...inDeg.entries()]
  .sort((a, b) => b[1].size - a[1].size)
  .forEach(([n, set]) => console.log(`  ${String(set.size).padStart(2)} 组  ${n.padEnd(26)} ${byName.get(n).size} 行  ← ${[...set].join(', ')}`));

console.log('\n' + '='.repeat(72));
console.log('抽走 support 后的残环（模拟：把 support 视为已独立，忽略其边）');
console.log('='.repeat(72));
const adj2 = new Map(groups.map((g) => [g, new Map()]));
for (const [from, m] of adj) {
  if (from === 'support') continue;
  for (const [to, n] of m) { if (to === 'support') continue; adj2.get(from).set(to, n); }
}
const index2 = new Array(N).fill(-1), low2 = new Array(N).fill(0), on2 = new Array(N).fill(false);
const stk2 = []; let c2 = 0; const sccs2 = [];
function sc2(v) {
  index2[v] = low2[v] = c2++; stk2.push(v); on2[v] = true;
  for (const to of adj2.get(groups[v]).keys()) {
    const w = idx.get(to);
    if (index2[w] < 0) { sc2(w); low2[v] = Math.min(low2[v], low2[w]); }
    else if (on2[w]) low2[v] = Math.min(low2[v], index2[w]);
  }
  if (low2[v] === index2[v]) { const cc = []; let w; do { w = stk2.pop(); on2[w] = false; cc.push(groups[w]); } while (w !== v); sccs2.push(cc); }
}
for (let v = 0; v < N; v++) if (index2[v] < 0) sc2(v);
let n2 = 0;
sccs2.forEach((cc) => { if (cc.length > 1) { n2++; console.log(`  残环 (${cc.length}): ${cc.join(', ')}`); } });
if (!n2) console.log('  残环已全部消解');
const free = sccs2.filter((cc) => cc.length === 1).map((cc) => cc[0]);
console.log(`\n  可独立拆出（无环）: ${free.length} 个 → ${free.join(', ')}`);
