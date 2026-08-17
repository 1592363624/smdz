# 使魔大战3 网页版 · 复刻对照追踪表 (Replica Tracking / RKT)

> **唯一真相来源 (SSOT)**: `e/源码解析成为txt/*.ecode`（易语言可读中文文本）
> **目标**: 后端 NestJS+TS / 前端 Vue3 / Prisma，1:1 逐行复刻
> **状态图例**: ✅已完成 · 🔶部分完成 · ⬜未开始 · ⚠️已知偏差(按原版保留)
>
> 本表用于逐模块/逐函数追踪复刻进度，每次复刻完一个单元后更新其状态，并补充「原文行号 + 复刻代码 + 自检结论」到本表对应条目。

---

## 0. 源码体量基线 (e/源码解析成为txt/*.ecode 行数)

| 文件 | 行数 | 角色 |
|------|------|------|
| _主程序.ecode | 12070 | 主流程 / 指令分发 (134+ 命令分支) |
| 战斗相关.ecode | 5438 | 伤害/战斗/反伤/掉落核心 |
| 加成计算.ecode | 4342 | 玩家/怪物属性计算、升级公式、套装、增益 |
| 物品操作.ecode | 3019 | 装备/武器/制造/分解/载具/箱子 |
| 数据显示.ecode | 3875 | 面板/信息文本渲染 |
| 使魔技能.ecode | 2745 | 使魔被动/主动技能、召唤 |
| 数据存取.ecode | 1717 | 存档读写 |
| 后台运作.ecode | 1696 | 定时器/每分钟/世界事件 |
| 地图操作.ecode | 1691 | 地图移动/连接/怪物刷新 |
| 数据分析.ecode | 1096 | 统计/排行榜 |
| 接口1.ecode | 1523 | 外部接口(DULU/MYQQ 对接原版) |
| 使魔家园.ecode | 375 | 家园系统 |
| 管理操作.ecode | 97 | 管理命令 |
| 文本操作.ecode | 406 | 文本工具 |
| 快捷输入.ecode | 165 | 快捷指令 |
| 主程序集_DULU.ecode | 198 | DULU 机器人入口 |
| 主程序集_MYQQ.ecode | 146 | MYQQ 机器人入口 |
| @Struct.ecode | 806 | 数据结构定义 |
| @Global.ecode | 91 | 全局变量 |
| @Constant.ecode | 281 | 常量 |
| 窗口程序集_窗口1.ecode | 257 | 原版 Windows 窗口(映射为无 UI 逻辑) |

---

## 1. 基础设施 / 已建成

| 单元 | 原文 | TS 实现 | 状态 | 备注 |
|------|------|---------|------|------|
| 指令引擎分发 | _主程序.ecode L3-259 (Main) | `command/command.service.ts` dispatch | ✅ | 前缀路由(两/三/四字命令) → DB Command 表 + handler |
| 选使魔门禁 | _主程序.ecode L798 | `command.service.ts` getFirstFamiliarGate | ✅ | 非老玩家发任何指令拦截 |
| 离线时间补偿 | 加成计算 L2383-2408 | `game.service.calculateTimeElapsed` | ✅ | 距上次>10秒按回复率回血/盾/甲 |
| Socket 实时推送 | (原版无, 新增) | `command.service.pushState` | ✅ | 指令后 pushPlayerUpdate/pushMapUpdate |
| 静态配置加载 | @Resource*.txt / 常量 | `static-data.service.ts` + `prisma/data/*.json` | ✅ | 22 文件进版本控制, 懒加载 |
| 玩家身份字段 | (原版 QQ) | `User.qqNumber` / `User.externalId` | ✅ | openid 与 QQ 号分离兼容 |

---

## 2. 加成计算.ecode (4342 行)

| 单元 | 原文行号 | TS 实现 | 状态 | 备注 |
|------|----------|---------|------|------|
| 加成限制 | L3 | — | ⬜ | |
| 加成限制1 | L64 | — | ⬜ | |
| 计算增益 | L81 | `bonus.service`? | ⬜ | 不要放修改.属性的增益 |
| 获得地图增益 | L577 | `map.service`? | ⬜ | |
| 计算战斗力 | L653 | — | ⬜ | |
| 获得增益2 | L664 | — | ⬜ | 战斗中获得 buff |
| 叠加加成 | L682 | — | ⬜ | |
| **升级经验公式** | **L1781-1794** | `player.service.calcUpgradeExp` L64 | ✅ | `(c*c+5)*(1+升级经验/100)*(1-风月入墨/100)`；注意 addExp 尚未接入 bonus.升级经验/风月入墨减益(暂按0) |
| _计算玩家 (玩家属性构建) | L1567-1833 | `bonus.service` / `player.service` | 🔶 | 等级差距/世界等级/全套加成已部分; 待逐字段核对 |
| _初始化怪物 (怪物属性构建·等级成长) | L2644-2777 / 2847-2861 | `map.service.refreshMapMonsters` | ✅ | 三层池血量对齐 L2764-2766：`(1+等级*0.05)*(基础+等级*20)*(1+觉醒/200)`；其余属性(L2767-2777)仅×lvFactor×觉醒因子；旧实现漏 `+等级*20` 与觉醒因子已修正；见下方「2.2 _初始化怪物 深层」 |
| 法宝加成2 | L3053 | — | ⬜ | |
| 计算buff | L3097 | — | ⬜ | 修改.属性的增益 |
| 法宝加成 | L3143 | — | ⬜ | |
| 最终加成 | L3233 | — | ⬜ | |
| 载具加成 | L3334 | — | ⬜ | |
| 套装判断2 | L3381 | — | ⬜ | |
| 增加穿透 | L3446 | `combat-system`? | ⬜ | |
| 增强器 | L3453 | — | ⬜ | 1护盾2装甲3生命 |
| 计算载具 | L3556 | `combat-system.computeVehicle` + `vehicle-parts.json` | ✅ | 1:1 还原(L3556-3912)：载具.加成重置；展开内置零件+匹配部件列表套用上限/行走/防御/武器/功能四类(正负二分支，原版L3647-3714)；硅基核心阿尔法=1.035/贝塔=1.025；核心partType=0设上限与行走方式；逆转力场攻击/攻击2/韧性×0.34+全抗加成(L3752)；湮灭圣光+氢弹→贯穿+20/审判/星爆/炼狱导弹+导弹→贯穿+10/8/5并加穿透(L3769-3801)；小雫/小凰/小蓝/小粉上限+1(L3804-3815)；超限判定当前生命=0/行走方式=0(L3836-3854)；部件限制超限清零(L3855)；上限标志1→3/2(L3887-3894)；封顶当前生命≤加成.生命(L3895)。⚠️产出分支L3898-3911调取生产产出→RKT⬜(独立生产系统大项)；部件限制全局当前无数据→空数组。`vehicle-parts.json`(74个类型=载具节，由使魔大战.txt提取)为硬前置数据。新增 test/combat.spec.ts 5用例 |
| 叠加载具加成 | L3913 | `combat-system.stackVehicleBonus` | ✅ | 1:1 还原(L3913-4020)：核心负面降低=硅基核心加成>1?1-(硅基核心加成-1)*2:1；逐字段>0用硅基核心加成否则用核心负面降低(攻击2/生命2/护盾2/装甲2/闪避2/命中2/电火冰物伤2/溅射2/速度2/生命回复2/护盾回复2/装甲回复2/攻击/护盾/装甲/生命/闪避/命中/电火冰物伤/溅射/速度)；生产字段生产类?×1:×1/4；攻击次数累加 |

### 2.2 _初始化怪物 深层 (buildMonsterBonusFromDef) 自检 (🔶 阶段A)

> 迁移背景：原 `GameMap.spawnMonsters/tempMonsters` 是 JSON 快照，已废弃；怪物现持久化于 `GameMonster` 表（1:1 对齐 @Struct.ecode 玩家结构 L287-341）。`refreshMapMonsters` 读取 `monsters.json`（bonus 已预合并的中文 key JSON），再经本函数套用 `_初始化怪物` L2748-3052 的**纯计算层**（属性已由 JSON 提供，故跳过"生成装备"那步）。

【原文 L2748-3052 关键句（节选）】
```
' L2764-2766 三层池(生命/护盾/装甲)等级成长
生命/护盾/装甲 = (1 + 等级*0.05) * (基础 + 等级*20) * (1 + 觉醒/200)
' L2767-2777 其余属性等级成长
攻击/防御/速度/闪避/命中/暴击... = 成长因子 × 基础 × 好感系数(a1) × 觉醒因子
' L2829 击杀标记加成 (觉醒>0 时按标记叠抗/攻)
' L2847-2861 觉醒分层: 觉醒≥100 / ≥200 / ≥400 逐级强化
' L2871 一拳套: 攻击 +25%
' L2873 雪心套: 闪避 -25%
' L2875 恶智套: 再生减半
' L2877 线圈套: 四系伤害减半(原版 冰伤=火伤/2 疑似笔误, 按原版保留)
' L1581 套装判断 → 写入 玩家.套装
```

【复刻】`map.service.ts` `buildMonsterBonusFromDef(defBonus, opts)`:
```ts
// 好感系数 a1：从 defBonus.affinity / 好感 取，缺省 1
const a1 = 1 + (affinity / 1000);  // 原版好感/1000 形式
// 觉醒因子 lvFactor 见 L2764-2784
const lvFactor = (1 + level * 0.05);                  // 三层池
const otherFactor = (1 + level * 0.05);               // 其余(原版系数)
// 三层池：基础+等级*20 然后 ×觉醒因子
b.生命 = lvFactor * (baseHp + level*20) * (1 + awaken/200);
// 觉醒分层 ≥100/200/400
if (awaken >= 100) { /* 强化 */ }
// 一拳/雪心/恶智/线圈 → 调用 combatState.setJudgment 按 equipments 名称判定
const setData = combatState.setJudgment(setData, eqName, specialSeq);
// 一拳: attack *= 1.25 ；雪心: dodge *= 0.75 ；恶智: regen/2 ；线圈: 四系伤害/2
```

【自检】阶段 A 已对齐：三层池 `+等级*20` 与觉醒因子、好感系数、觉醒分层、一拳/雪心/恶智/线圈四套效果（线圈保留原版 `冰伤=火伤/2` 疑似笔误）、套装判定经 `combatState.setJudgment` 写入 `b.套装`。⚠️已知偏差：原版 L2748-2760「生成装备」步在本次实现中跳过（JSON 的 bonus 已预合并，无需再生成），后续若需动态装备生成再补；法宝加成(L2863)/载具加成/增益计算/战斗力(L3031) 仍⬜，依赖怪物对象扩展 markers/sets/好感/成就/活力 字段。

### 2.3 端到端实测 + setJudgment 短路 bug 修复 (2026-08-17)
经 `NestFactory.createApplicationContext` 直接调 `MapService.refreshMapMonsters` 并查远程 MySQL GameMonster 表验证：
- **等级成长 1:1 对齐 L2764-2777**：医疗室 L1 史莱姆 hp=52(=1.05×(30+20)×1)、shield/armor=21、atk=10、speed=105、dodge/hit=10、物伤=5.25、四抗=10、暴伤=157.5；飞龙谷 L1 冰霜飞龙 hp=2121、dodge=210、hit=241、冰伤=315 —— 全部命中公式。
- **发现并修复 2 个真实 bug**（setJudgment 翻译错误）：
  1. `combat-state.service.ts` `setJudgment` 第一段 `if(特殊序号!==0){switch{...}return;}` —— 无论 switch 是否命中都 `return`，导致 specialSeq 非0时**名称判定段永远不执行**（原版语义是"命中才返回"）。改为每个 case 命中 `return`、default `break` 后继续第二段名称判定。
  2. `map.service.ts` `buildMonsterBonusFromDef` 仅遍历 `opts.equipments` 调 setJudgment，**未用怪物自身 specialSeq 调一次** → 怪物穿线圈套(specialSeq=123)不触发。补 `setJudgment(setData,'',selfSeq)`。
  3. 一拳套装判定原误用 `w1=substring(0,4)==='一拳'`（"一拳套装"4字="一拳套"不匹配），改为 `w2==='一拳'`（取2字，对齐原版 取文本左边(名称,2)）。
  4. 一拳加攻原误用 `addMonsterAttackPercent`（乘四伤），原版「增加攻击(玩家,,25)」第二参数为空→加**攻击力**，改 `b.攻击*=1.25`；`refreshMapMonsters` 写 attack 字段优先用 `finalBonus.攻击`（含一拳加成）。
- **修复验证**：一拳套(4件)→攻击125、线圈(动能线圈123)→物伤÷2=75、雪心增益(xuexin)→闪避×0.75、觉醒400→生命×3，全部正确。
- 经完整原版数据重建后，monsters.json **已含带套装装备的怪物**（34 个：防爆16/生命19/无畏5/动力5/圣诞6/强袭6/纳米3/纯白9/黑婚1/黑手1/心形2/创可贴1/线圈1），怪物套装效果已随 refreshMapMonsters 写入 GameMonster.set 生效；玩家侧套装经 2026-08-17 recomputeSets 修复后亦生效。

---

### 2.1 升级经验公式 自检 (✅ 已对齐)

【原文 L1786-1794】
```
a2 = (c * c + 5) * (1 + 玩家.加成.升级经验 / 100) * (1 - a3 / 100)
.判断循环首 (a1 - a2 > 0)
    a1 = a1 - a2
    c = c + 1
    a2 = (c * c + 5) * (1 + 玩家.加成.升级经验 / 100) * (1 - a3 / 100)
.判断循环尾 ()
玩家.等级 = c
玩家.升级经验 = a2
玩家.剩余经验 = a1
```
【复刻】`player.service.ts` L64 `calcUpgradeExp(level, upgradeExpBonus=0, fengyueReduction=0)`:
```ts
const base = level * level + 5;
const exp = base * (1 + upgradeExpBonus / 100) * (1 - fengyueReduction / 100);
```
【自检】数值 1:1。原版循环累减求等级，TS 直接按公式算单级门槛(等价)。**偏差**: 原版 `a3`=风月入墨减益在 `_计算玩家` 中经 `增益要求("风月入墨",...)` 取; 当前 `calcUpgradeExp` 默认 0, addExp 未接入 → ⚠️已知偏差, 待 _计算玩家 完整后接入。

---

## 3. 战斗相关.ecode (5438 行)

| 单元 | 原文行号 | TS 实现 | 状态 | 备注 |
|------|----------|---------|------|------|
| 武器攻击 | L3 | `combat-system.weaponAttack` | 🔶 | 已接攻击入口 |
| **造成伤害 (核心伤害模型)** | **L872** | `combat-system.calcDamage` L1417 | 🔶 | 命中/闪避倍率、下限归一、随机区间、三段暴击评级、百分比穿透、等级差距新人加成 **已对齐**; 待补: 伤害过低未破防L3440/暴击被暴击率修正/贯穿L3192/格挡L2583/反伤L4791/免死L5020/载具受击L3175/卷土重来L3674/套装特效 |
| 攻击目标 | L4021 | `combat-system` + `combat-state` | 🔶 | **基石层已建**：`combat-state.service.ts` 1:1 复刻 添加成就L678/取成就熟练度L719/置成就熟练度L850/标记要求L747/添加标记L778/增益要求L799/获得增益L1522/时间间隔要求L1008。待补：护盾层(L4113-4271)/装甲层(L4275-4396)/生命层(L4398-4511)特效分支（激变星/强袭/坚韧护盾/盾逆/吸血姬/兰音护盾文本/破盾成就/捕捉模式/免死/麻醉等）需怪物对象扩展 markers/sets/好感/成就/活力 字段后接入 |
| _初始化怪物(深层) | L2748-3052 | `map.service.buildMonsterBonusFromDef`/`combat-state` | 🔶 | **基石层+阶段A已建**：状态机helper + `套装判断`(物品操作L1581,完整specialSeq常量映射 `constants/special-seq.constant.ts`)+`装备要求`(L1512)+`buildMonsterBonusFromDef`(整合L2748-3052等级成长/好感/击杀标记/觉醒/一拳/雪心/恶智/线圈/套装判定)。待补：装备生成(L2748)/法宝加成(L2863)/载具加成/增益计算/战斗力(L3031)。依赖怪物对象扩展 markers/sets/好感/成就/活力 字段 |
| 套装判断 | L1581 | `combat-state.setJudgment` | ✅ | 1:1 复刻：按 specialSeq switch + 按名称前缀(取文本左边4/2字)累加 SetData 字段；增幅器71-75/植入体76-79范围、动力封顶5 等已对齐 |
| 套装效果生效(玩家) | _计算玩家 L2284/L3381 | `item.service.recomputeSets`+`buildAttackerBonus` | ✅ | **2026-08-17 修复**：原 player.sets 永不被写入→玩家穿套装全不生效。新增 recomputeSets 在 equipItem/unequipItem/equipImplantItem/equipAmplifierItem/equipmentPreset 装备变更后遍历 equipment+weapons 调 setJudgment 累加写入 player.sets；buildAttackerBonus 实时消费 maid/amplifier/lifeBless/onePunch/implan/coil 等（植入体×1.25/L2329、增幅器==1冷却/L2609、科学家≥4/L2619、晚礼服≥4/L2590、线圈÷2/L2596、一拳==4/L2239 等已就位）。test/item-system.spec.ts 5 用例回归 |
| 装备要求 | L1512 | `combat-state.equipRequire` | ✅ | 1:1 复刻：武器(当前手持)/装备(名称或specialSeq)检索，增幅器/植入体范围判断 |
| 战斗 | L4512 | `combat.service` / `game-command` | 🔶 | 怪物闪避/幻时/移动临时怪物已部分 |
| 挑战怪物 | L4726 | `combat-system.challengeMonsterName` | ✅ | 按整数 a 分段返回怪物名(绿毛龟/水元素/.../精英兔子/露娜)；新增 test/combat.spec.ts 5用例 |
| 计算反伤 | L4791 | — | ⬜ | |
| 战利品 | L4874 | `item-system.distributeLoot` + `combat-system.handleMonsterDeath` | ✅ | 装备展开/资源(好感·经验·默认)/成就/背包写入/掉落文本；combat-system注入itemSystem；新增 test/item-system.spec.ts 4用例 |
| 掉落残骸 | L4947 | `combat-system.dropWreckage` | ✅ | 地精系列累加载具残骸次数；新增 test/combat.spec.ts 3用例 |
| 光荣弹 | L4987 | — | ⬜ | 死亡触发一次性反击：构造临时装备(四伤25+必中)、按 死方(生命+装甲+护盾)与 攻方(四伤*0.25) 比值算倍率a1、护盾/装甲/生命穿透+50、调造成伤害(光荣弹a)；依赖完整造成伤害对外调用链(临时装备+返回伤害文本w1)，当前 calcDamage 闭包未暴露该入口，待接入 |
| 免死 | L5020 | `combat-system.avoidDeath` + 接入 `playerDeath` | ✅ | 1:1 还原(L5020-5096)：龙姬(specialSeq=12)怒吼→b=2、伊芙利特(specialSeq=11)五番冷却未过→获得增益五番a、战斗女仆(specialSeq=8)守护3→b=5、吸血姬(活力=-15)与分身(活力=-16)互换生命、猫爪吊坠(specialSeq=23)猫爪冷却未过→获得增益猫爪；L5072 独立判断 增益要求猫爪→b=4/五番a→b=3/默认→b=1（⚠️原版 L5072 默认 b=1 会覆盖 龙姬b=2/战斗女仆b=5，致怒吼/守护3 实际不免死，原版疑似冗余分支，按原版保留）；b==2 总伤害+当前生命-1且当前生命=1、b==3/4/5 生命-0免死返回真。依赖 combatState.gainBuff/timeIntervalRequire + playerService.getMarkerValue；新增 test/combat.spec.ts 10用例 |
| 行动无限制 | L5097 | `combat-system.actionUnrestricted` | ✅ | 1移动2复活3采集4工作5躺下6自动开采；markers2秒级expireAt一致；新增 test/combat.spec.ts 9用例 |
| 玩家死亡 | L5173 | `combat-system.playerDeath` | ✅ | 卷土重来/军姬森罗万象/死亡行者/石中剑 复活豁免；军姬宠物存活借 map.summons 近似；**已接入 avoidDeath（原版 免死 优先于 玩家死亡，L5020 先于 L5173 调用）**；新增 test/combat.spec.ts 5用例 |
| 选择目标 | L5233 | — | ⬜ | |
| 置掉落 | L5245 | `combat-system.setDrop` | ✅ | 掉落率dl/品质dp/传说率xy/宝石缎带ds 写入怪物标记；⚠️原版L5291传说率段误用掉落品质按原版保留；新增 test/combat.spec.ts 4用例 |
| 生成前线 | L5319 | `combat-system.generateFrontline` + 私有 `stackVehicleBonus`/`computeVehicle`/`getAttackTextByName` | ✅ | 1:1 还原：前线召唤物(必中/生命1/闪避1/四伤1/命中=等级+1/特殊序号-2)、遍历建筑加成.攻击!=0加射弹武器(26/25/25/25×攻×数量,c+=生命×数量)、无建筑默认火力自动步枪(攻击文本.名称清空)、套装.增幅器=3、阵地载具(阵地核心×1+轻型装甲×(10+c+等级))、置成就熟练度跟随/阵地、按g2.编号新增/更新。⚠️依赖原版战斗建筑(含加成.攻击)，当前buildings.json仅生产建筑→武器数组常空走默认分支，逻辑完整保留待数据补全；生成前线调用完整 `computeVehicle`(L3556已✅)计算阵地载具真实属性 |
| 选择高血量目标 | L5423 | `combat-system.selectHighHpTarget` | ✅ | 返回生命+装甲+护盾总和最大者索引；新增 test/combat.spec.ts 4用例 |

### 3.1 造成伤害 核心已对齐段 自检 (🔶)

【原文 L2274-2379 摘要】
```
总伤害倍率 = 攻击命中 / 防御闪避      ' L2274
倍率×下限 > 1 时归一为 1              ' L2289 (防高命中爆炸)
随机区间 [倍率×伤害下限, 1+伤害上限] ' L2317
三段暴击评级 绝杀/完美/致命/强力/正中/擦过/描边 ' L2309-2379
百分比穿透: 有效抗性=(单项抗+全抗)×(1-穿透/100) ' L4140
等级差距新人加成: 等级<世界等级×10 → gap=1-等级/(世界等级×10) ' L1817
```
【复刻】`combat-system.service.ts` calcDamage (L1417起):
- 命中/闪避倍率 + 索敌计算机保留逻辑 ✅
- 随机区间 + 下限归一 ✅
- 七级暴击评级 + 熟练度累加 ✅
- 百分比穿透 ✅ (effectiveResist = (single+all)*(1-pen/100))
- 等级差距放大 ✅
【自检】核心模型已对齐。待补清单见上表 L3440/L3192/L2583 等。

---

## 4. 物品操作.ecode (3019 行)

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 计算价值 | L3 | `item-system`? | ⬜ |
| 强化植入体 | L57 | `handlers/info?` | ⬜ |
| 强化增幅器 | L211 | — | ⬜ |
| 制造 | L365 | `handlers`? | ⬜ |
| 加成转数据 | L541 | — | ⬜ |
| 背包操作 (搜索/查看/丢弃/保护) | L696 | `inventory.handler` | 🔶 |
| 操作保险柜 | L1009 | `inventory.handler`? | ⬜ |
| 丢弃物品 | L1050 | `inventory`? | ⬜ |
| 生成装备 | L1128 | `item-system.generateEquipment` | ✅ | 深度还原(L1128-1261)：品质随机/词条展开(随机护盾等)/去重/词条转换/特效生成/序列化 |
| 词条转换 | L1838 | `item-system.rollAffix` | ✅ | 深度还原(L1838-1996)：中文词条→英文BonusData键，按品质倍率随机区间(护盾500-1000×倍率等) |
| 词条数据层(静态JSON) | 数据存取 L513 / 使魔大战.txt 属性= | `convert-e-to-json.ts`+`StaticDataService` | ✅ | equipments.json 296/307 装备已带属性=词条(原硬编码'[]')；generateEquipment 经 gameEquip.affixes 读取并展开 |
| 解析装备 | L1262 | `item-system.parseEquip` | ⬜ |
| 物品要求 | L1784 | `item-system.itemRequire` | ✅ | 1:1 还原(L1784-1811)：遍历物品数组，空要求数量→存在即满足写回下标；指定数量→数量≥要求才满足；不足→found=false 且 hint="需要X的NAME，你只有Y"；未命中→false。返回封装{found,index,hint}；test/item-system.spec.ts 6用例 |
| 装备要求 | L1512 | `item-system` | ⬜ |
| 套装判断 | L1581 | `bonus`? | ⬜ |
| 物品要求 | L1784 | — | ⬜ |
| 判断物品2 | L1812 | — | ⬜ |
| 寻找装备 | L1824 | — | ⬜ |
| 资源需求 | L1997 | — | ⬜ |
| 取物品数量 | L2022 | — | ⬜ |
| 装备特效要求 | L2042 | — | ⬜ |
| 是否装备 | L2065 | — | ⬜ |
| 分解装备 | L2076 | `handlers/use?` | ⬜ |
| 取逆向值 | L2158 | — | ⬜ |
| 部件类型转换 | L2180 | — | ⬜ |
| 是否部件 | L2196 | — | ⬜ |
| 打开箱子 | L2220 | `gather`? | ⬜ |
| 激活装备特效 | L2459 | — | ⬜ |
| 宠物觉醒装备 | L2493 | — | ⬜ |
| 组装载具 | L2518 | — | ⬜ |
| 取咏星加成 | L2599 | — | ⬜ |
| 配方配平 | L2612 | — | ⬜ |
| 取生产产出 | L2692 | — | ⬜ |
| 叠加物品数组 | L2955 | — | ⬜ |
| 获得物品 | L2964 | `item-system.gainItem` | 🔶 |

---

## 5. 使魔技能.ecode (2745 行)

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 军姬X传送判断 | L3 | `familiar-skills`? | ⬜ |
| 普拉娜幼崽剪毛 | L14 | — | ⬜ |
| 全属性调整 | L87 | — | ⬜ |
| 取羽毛 | L125 | `familiar-skills` | ⬜ |
| 纯白之翼 | L164 | — | ⬜ |
| 释放使魔技能 (自动释放) | L179 | `familiar-skills` | ⬜ |
| 召唤物存在 | L210 | — | ⬜ |
| 攻击召唤 | L236 | `combat-system.summonCoAttack` | 🔶 |
| 宠物搜索物品 | L374 | — | ⬜ |
| 随机未冷却武器 | L486 | — | ⬜ |
| 技能经验 | L506 | — | ⬜ |
| 急救包 | L539 | — | ⬜ |
| 释放闪避 | L550 | `combat-system` | 🔶 |
| **使魔技能 (触发)** | **L634** | `familiar-skills` | 🔶 | 7专属加成(战斗女仆/花园猫/龙姬/小樱/伊卡洛斯/恶毒/长萌)已部分; 兰音 specialSeq=23 |
| 月落寸光 | L2603 | — | ⬜ |
| 反转童话 | L2631 | — | ⬜ |

---

## 6. 地图操作.ecode (1691 行)

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 地图移动/连接/怪物刷新 | 全文件 | `map.service` | 🔶 | 出生刷怪/semiDynamicFields 已修; 移动/连接逻辑待逐行 |

---

## 7. 后台运作.ecode (1696 行) / 定时

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 每分钟刷新怪物/世界事件 | 全文件 | `schedule.service` | ⬜ |

---

## 8. 数据显示.ecode (3875 行) / 面板

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 玩家/使魔/装备/任务 信息文本 | 全文件 | `info.handler` / `status.handler` | 🔶 |

---

## 9. _主程序.ecode 指令分发 (134+ 分支)

> 完整分支已在 `command.service.ts` 经 DB Command 表 + handler 分发。以下为**已注册 handler** 与**原始命令**的对照（部分命令尚未实现内部逻辑）：

| 原始命令 | 行号 | Handler | 状态 |
|----------|------|---------|------|
| 攻击 / 覅攻击pd | L131 / L200 | `attack` | 🔶 |
| 炮击 | L800 | — | ⬜ |
| 安乐天使 | L995 | — | ⬜ |
| 福音书 | L1044 | — | ⬜ |
| 设置跟随 | L1121 | — | ⬜ |
| 救助 / 救起了 | L1192 / L1240 | `rescue` | 🔶 |
| 对话 / 对话露娜未知 | L1361 / L1410 | `talk` | 🔶 |
| 飞到 | L1574 | `teleport` | 🔶 |
| 传送 / 跃迁 | L1676 | `teleport` | 🔶 |
| 安装 / 拆卸 | L1854 / L2043 | `equip`? | ⬜ |
| 家园 / 家园音乐 / 搬迁 / 命名 | L2172-2319 | `home` | 🔶 |
| 使魔商店 / 兑换 | L2621 / L2629 | — | ⬜ |
| 背包搜索 / 保险柜搜索 / 比较装备 | L2804 | `inventory` | 🔶 |
| 探测 / 探测资源 / 拾取 / 作物 | L2873 | `gather` | 🔶 |
| 制造 / 移除 / 保护 / 丢弃 / 分解 | L3280 | `use`/`inventory` | 🔶 |
| 锁定装备 / 解锁 | L3527 / L3617 | `inventory` | ⬜ |
| 拾取 | L3710 | `gather` | 🔶 |
| 开启副本 / 刷新副本 | L3863 / L3924 | `dungeon` | ⬜ |
| 召唤使魔 / 命名使魔 | L3969 / L3999 | `game-command` | ✅ |
| 切换预设 / 装备 / 切换武器 / 卸下 | L4114 / L4156 / L4303 / L4434 | `equip`/`unequip` | 🔶 |
| 图鉴 / 使用 | L4505 / L4508 | `use` | 🔶 |
| 切换/强化 植入体/增幅器 | L4724-4908 | — | ⬜ |
| 解析 / 强化 | L4910 / L5050 | `item-system` | ⬜ |
| 设置 / 设置购物 / 肉食比例 / 位置 / 标记 | L5155-5328 | `game-command`? | ⬜ |
| 查看 / 查看保险柜 / 使魔详细 / 使魔 / 任务 / 装备 | L5428-5596 | `info`/`status` | 🔶 |
| 呼叫 | L5819 | — | ⬜ |
| 捕捉 / 开始捕捉 / 停止捕捉 | L6096-6257 | `combat`? | ⬜ |
| (其余分支见于 L6257-12070，见 RKT 续表) | — | — | ⬜ |

---

## 10. 待建立自动化测试 (见 test/ 目录)

| 测试目标 | 覆盖算法 | 状态 |
|----------|----------|------|
| 升级经验公式 | 加成计算 L1786 | ✅ 已建 `test/bonus.spec.ts` |
| 伤害计算模型 | 战斗相关 L2274-2379 | ✅ 已建 `test/combat.spec.ts` |
| 生成装备+词条转换 | 物品操作 L1128/L1838 | ✅ 已建 `test/item-system.spec.ts` |
| 指令分发路由 | _主程序 L126-130 | ⬜ |
| 怪物抗性映射 | buildMonsterBonus | ⬜ |

---

## 使用说明
1. 复刻时**先**在 ecode 中 `search_content` 定位目标子程序行号。
2. 在对应表格单元补充「原文 Lxxx + 复刻代码 + 自检结论」，并把状态改为 ✅/🔶。
3. 遇到原版疑似 bug/死分支 → 仍按原版实现，备注写 `// 原版逻辑 Lxxx 疑似笔误，按原版保留`，并在本表"备注"列标注。
4. 每完成一个文件级单元，运行 `npm test` 确保回归护栏通过。
