/**
 * 数据库种子脚本
 * 初始化默认频道、基础指令表、游戏地图、物品、装备、使魔等。
 * 运行：npm run prisma:seed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 开始写入种子数据...');

  // 1. 默认世界频道
  const channel = await prisma.channel.upsert({
    where: { name: '世界频道' },
    update: {},
    create: { name: '世界频道', description: '所有玩家公屏频道' },
  });
  console.log(`✅ 频道: ${channel.name} (id=${channel.id})`);

  // 2. 基础指令表（中文指令名作为主名，英文作为别名）
  // 基础指令（help, info, inventory, move, map）保留独立 handlerKey
  // 其余游戏指令统一使用 handlerKey: 'game'，由 GameCommandHandler 统一分发
  const commands = [
    // 基础指令（独立处理器）
    { name: '帮助', alias: 'help,指令,命令', description: '查看所有可用指令', handlerKey: 'help', minRole: 'USER', sortOrder: 1 },
    { name: '信息', alias: 'info,资料,查看,状态', description: '查看自己的玩家信息', handlerKey: 'info', minRole: 'USER', sortOrder: 2 },
    { name: '背包', alias: 'inventory', description: '查看背包物品', handlerKey: 'inventory', minRole: 'USER', sortOrder: 3 },
    { name: '移动', alias: 'move,前往,去,飞到,go', description: '移动到指定地图', handlerKey: 'move', minRole: 'USER', sortOrder: 4 },
    { name: '地图', alias: 'map,查看地图', description: '查看当前地图信息', handlerKey: 'map', minRole: 'USER', sortOrder: 5 },
    // 战斗（统一 game 处理器）
    { name: '攻击', alias: 'attack,打,揍', description: '攻击当前地图的怪物', handlerKey: 'game', minRole: 'USER', sortOrder: 10 },
    { name: '炮击', alias: 'cannon', description: '使用载具炮台攻击', handlerKey: 'game', minRole: 'USER', sortOrder: 11 },
    { name: '技能', alias: 'skill,使魔技能', description: '查看使魔技能信息', handlerKey: 'game', minRole: 'USER', sortOrder: 12 },
    // 物品/装备（统一 game 处理器）
    { name: '装备', alias: 'equip,穿上', description: '装备物品到对应部位', handlerKey: 'game', minRole: 'USER', sortOrder: 20 },
    { name: '卸下', alias: 'unequip,脱下', description: '卸下指定部位的装备', handlerKey: 'game', minRole: 'USER', sortOrder: 21 },
    { name: '使用', alias: 'use', description: '使用背包中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 22 },
    { name: '制造', alias: 'craft,制作', description: '制造物品或装备', handlerKey: 'game', minRole: 'USER', sortOrder: 23 },
    { name: '分解', alias: 'deconstruct', description: '分解装备为材料', handlerKey: 'game', minRole: 'USER', sortOrder: 24 },
    { name: '丢弃', alias: 'discard,扔掉', description: '丢弃背包中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 25 },
    { name: '移除', alias: 'remove', description: '移除装备', handlerKey: 'game', minRole: 'USER', sortOrder: 26 },
    { name: '保护', alias: 'protect', description: '保护物品不被分解', handlerKey: 'game', minRole: 'USER', sortOrder: 27 },
    { name: '强化', alias: 'enhance,升级', description: '强化装备或法宝', handlerKey: 'game', minRole: 'USER', sortOrder: 28 },
    { name: '解析', alias: 'analyze', description: '解析装备属性', handlerKey: 'game', minRole: 'USER', sortOrder: 29 },
    { name: '锁定装备', alias: 'lock', description: '锁定装备防止误操作', handlerKey: 'game', minRole: 'USER', sortOrder: 30 },
    { name: '解锁', alias: 'unlock', description: '解锁被锁定的装备', handlerKey: 'game', minRole: 'USER', sortOrder: 31 },
    // 使魔系统（统一 game 处理器）
    { name: '选择使魔', alias: 'select,familiar,更换使魔', description: '选择或更换使魔', handlerKey: 'game', minRole: 'USER', sortOrder: 40 },
    { name: '召唤使魔', alias: 'summon', description: '召唤使魔到当前地图', handlerKey: 'game', minRole: 'USER', sortOrder: 41 },
    { name: '命名使魔', alias: 'name-familiar', description: '为你的使魔命名', handlerKey: 'game', minRole: 'USER', sortOrder: 42 },
    { name: '使魔数据', alias: 'familiar-data', description: '查看使魔详细数据', handlerKey: 'game', minRole: 'USER', sortOrder: 43 },
    { name: '使魔商店', alias: 'familiar-shop', description: '使魔商店', handlerKey: 'game', minRole: 'USER', sortOrder: 44 },
    { name: '兑换', alias: 'exchange', description: '兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 45 },
    // 家园系统（统一 game 处理器）
    { name: '家园', alias: 'home', description: '家园操作入口', handlerKey: 'game', minRole: 'USER', sortOrder: 50 },
    { name: '圈地', alias: 'claim-land', description: '在当前地图开始建造家园', handlerKey: 'game', minRole: 'USER', sortOrder: 51 },
    { name: '开挖地基', alias: 'dig-foundation', description: '开挖地基（家园建造阶段）', handlerKey: 'game', minRole: 'USER', sortOrder: 52 },
    { name: '建造地基', alias: 'build-foundation', description: '建造地基（家园建造阶段）', handlerKey: 'game', minRole: 'USER', sortOrder: 53 },
    { name: '建造房子', alias: 'build-house', description: '建造房子（家园建造完成）', handlerKey: 'game', minRole: 'USER', sortOrder: 54 },
    // 宠物系统（统一 game 处理器）
    { name: '宠物', alias: 'pet', description: '宠物操作入口', handlerKey: 'game', minRole: 'USER', sortOrder: 60 },
    { name: '捕捉', alias: 'capture', description: '开始捕捉宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 61 },
    // 地图/探索（统一 game 处理器）
    { name: '传送', alias: 'teleport,跃迁', description: '传送到指定地图', handlerKey: 'game', minRole: 'USER', sortOrder: 70 },
    { name: '探测', alias: 'probe,scout', description: '探测当前地图', handlerKey: 'game', minRole: 'USER', sortOrder: 71 },
    { name: '拾取', alias: 'pickup', description: '拾取地上的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 72 },
    { name: '开采', alias: 'mine', description: '开采当前地图的资源', handlerKey: 'game', minRole: 'USER', sortOrder: 73 },
    // 副本系统（统一 game 处理器）
    { name: '开启副本', alias: 'start-dungeon', description: '开启副本挑战', handlerKey: 'game', minRole: 'USER', sortOrder: 80 },
    { name: '刷新副本', alias: 'refresh-dungeon', description: '刷新当前副本', handlerKey: 'game', minRole: 'USER', sortOrder: 81 },
    // 载具系统（统一 game 处理器）
    { name: '安装', alias: 'install', description: '安装载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 90 },
    { name: '拆卸', alias: 'uninstall', description: '拆卸载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 91 },
    // 任务系统（统一 game 处理器）
    { name: '领取任务', alias: 'accept-quest', description: '领取任务', handlerKey: 'game', minRole: 'USER', sortOrder: 100 },
    { name: '查看任务', alias: 'quests,我的任务', description: '查看当前任务列表', handlerKey: 'game', minRole: 'USER', sortOrder: 101 },
    { name: '提交任务', alias: 'complete-quest', description: '提交任务完成', handlerKey: 'game', minRole: 'USER', sortOrder: 102 },
    { name: '放弃任务', alias: 'abandon-quest', description: '放弃当前任务', handlerKey: 'game', minRole: 'USER', sortOrder: 103 },
    // 社交系统（统一 game 处理器）
    { name: '对话', alias: 'talk,交谈', description: '与NPC对话', handlerKey: 'game', minRole: 'USER', sortOrder: 110 },
    { name: '对话露娜未知', alias: 'dialogue-luna', description: '与露娜对话，用未知物品兑换奖励', handlerKey: 'game', minRole: 'USER', sortOrder: 110 },
    { name: '来倒目的', alias: 'arrive', description: '延时移动到指定地图（系统内部命令）', handlerKey: 'game', minRole: 'USER', sortOrder: 110 },
    { name: '救助', alias: 'rescue', description: '救助倒地的玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 111 },
    { name: '赠予', alias: 'give,gift', description: '赠予物品给其他玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 112 },
    { name: '设置跟随', alias: 'follow', description: '设置跟随目标', handlerKey: 'game', minRole: 'USER', sortOrder: 113 },
    // 状态系统（统一 game 处理器）
    { name: '躺下', alias: 'lie-down', description: '躺下休息', handlerKey: 'game', minRole: 'USER', sortOrder: 120 },
    { name: '起床', alias: 'get-up', description: '起床', handlerKey: 'game', minRole: 'USER', sortOrder: 121 },
    // 设置（统一 game 处理器）
    { name: '设置', alias: 'settings', description: '个人设置', handlerKey: 'game', minRole: 'USER', sortOrder: 130 },
    // 战斗相关（统一 game 处理器）
    { name: '开始战斗', alias: 'start-battle', description: '手动进入战斗循环模式', handlerKey: 'game', minRole: 'USER', sortOrder: 140 },
    { name: '扫荡', alias: 'sweep', description: '快速战斗/扫荡模式', handlerKey: 'game', minRole: 'USER', sortOrder: 141 },
    { name: '闪避', alias: 'dodge', description: '释放闪避技能', handlerKey: 'game', minRole: 'USER', sortOrder: 142 },
    // 玩家信息/背包（统一 game 处理器）
    { name: '资源背包', alias: 'resource-bag', description: '查看资源类背包物品', handlerKey: 'game', minRole: 'USER', sortOrder: 150 },
    { name: '背包搜索', alias: 'search-bag', description: '搜索背包中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 151 },
    { name: '保险柜搜索', alias: 'search-safe', description: '搜索保险柜中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 152 },
    { name: '比较装备', alias: 'compare-equip', description: '比较两件装备的属性', handlerKey: 'game', minRole: 'USER', sortOrder: 153 },
    { name: '被动效果', alias: 'passive-effects', description: '查看当前被动效果', handlerKey: 'game', minRole: 'USER', sortOrder: 154 },
    { name: '图鉴', alias: 'handbook', description: '查看游戏图鉴', handlerKey: 'game', minRole: 'USER', sortOrder: 155 },
    // 物品操作（统一 game 处理器）
    { name: '切换武器', alias: 'switch-weapon', description: '切换当前武器', handlerKey: 'game', minRole: 'USER', sortOrder: 160 },
    { name: '强化植入体', alias: 'enhance-implant', description: '强化植入体', handlerKey: 'game', minRole: 'USER', sortOrder: 161 },
    { name: '查看植入体', alias: 'view-implant', description: '查看植入体信息', handlerKey: 'game', minRole: 'USER', sortOrder: 162 },
    { name: '切换植入体', alias: 'switch-implant', description: '切换植入体类型', handlerKey: 'game', minRole: 'USER', sortOrder: 163 },
    { name: '还原植入体', alias: 'reset-implant', description: '还原植入体', handlerKey: 'game', minRole: 'USER', sortOrder: 164 },
    { name: '查看增幅器', alias: 'view-amplifier', description: '查看增幅器信息', handlerKey: 'game', minRole: 'USER', sortOrder: 165 },
    { name: '切换增幅器', alias: 'switch-amplifier', description: '切换增幅器', handlerKey: 'game', minRole: 'USER', sortOrder: 166 },
    { name: '强化增幅器', alias: 'enhance-amplifier', description: '强化增幅器', handlerKey: 'game', minRole: 'USER', sortOrder: 167 },
    { name: '还原增幅器', alias: 'reset-amplifier', description: '还原增幅器', handlerKey: 'game', minRole: 'USER', sortOrder: 168 },
    { name: '增幅器说明', alias: 'amplifier-help', description: '查看增幅器系统说明', handlerKey: 'game', minRole: 'USER', sortOrder: 169 },
    { name: '炼丹', alias: 'alchemy', description: '炼丹操作', handlerKey: 'game', minRole: 'USER', sortOrder: 170 },
    { name: '融合', alias: 'merge', description: '融合物品', handlerKey: 'game', minRole: 'USER', sortOrder: 171 },
    { name: '锻造', alias: 'forge', description: '锻造装备', handlerKey: 'game', minRole: 'USER', sortOrder: 172 },
    { name: '育种', alias: 'breed', description: '育种操作', handlerKey: 'game', minRole: 'USER', sortOrder: 173 },
    { name: '修理', alias: 'repair-item', description: '修理装备或物品', handlerKey: 'game', minRole: 'USER', sortOrder: 174 },
    { name: '装填', alias: 'reload', description: '装填弹药或能量', handlerKey: 'game', minRole: 'USER', sortOrder: 175 },
    { name: '回充', alias: 'recharge', description: '回充能量', handlerKey: 'game', minRole: 'USER', sortOrder: 176 },
    // 使魔系统扩展（统一 game 处理器）
    { name: '使魔技能', alias: 'familiar-skills', description: '查看使魔技能详情', handlerKey: 'game', minRole: 'USER', sortOrder: 180 },
    { name: '使魔家园', alias: 'familiar-home', description: '进入使魔家园', handlerKey: 'game', minRole: 'USER', sortOrder: 181 },
    { name: '通用技能', alias: 'common-skills', description: '查看通用技能', handlerKey: 'game', minRole: 'USER', sortOrder: 182 },
    { name: '使魔称号', alias: 'familiar-titles', description: '查看使魔称号', handlerKey: 'game', minRole: 'USER', sortOrder: 183 },
    { name: '领取称号', alias: 'claim-title', description: '领取已获得的称号', handlerKey: 'game', minRole: 'USER', sortOrder: 184 },
    { name: '佩戴称号', alias: 'equip-title', description: '佩戴称号', handlerKey: 'game', minRole: 'USER', sortOrder: 185 },
    { name: '使魔排行', alias: 'familiar-rank', description: '查看使魔排行榜', handlerKey: 'game', minRole: 'USER', sortOrder: 186 },
    { name: '大召唤术', alias: 'mass-summon', description: '大规模召唤使魔', handlerKey: 'game', minRole: 'USER', sortOrder: 187 },
    { name: '复活使魔', alias: 'revive-familiar', description: '复活已阵亡的使魔', handlerKey: 'game', minRole: 'USER', sortOrder: 188 },
    { name: '使魔挑战', alias: 'familiar-challenge', description: '查看使魔挑战', handlerKey: 'game', minRole: 'USER', sortOrder: 189 },
    { name: '开始挑战', alias: 'start-challenge', description: '开始使魔挑战', handlerKey: 'game', minRole: 'USER', sortOrder: 190 },
    // 使魔技能（统一 game 处理器）
    { name: '安乐天使', alias: 'ease-angel', description: '使魔技能 - 安乐天使', handlerKey: 'game', minRole: 'USER', sortOrder: 200 },
    { name: '福音书', alias: 'gospel', description: '使魔技能 - 福音书', handlerKey: 'game', minRole: 'USER', sortOrder: 201 },
    { name: '启示录', alias: 'apocalypse', description: '使魔技能 - 启示录', handlerKey: 'game', minRole: 'USER', sortOrder: 202 },
    { name: '切换模式', alias: 'switch-mode', description: '切换使魔模式', handlerKey: 'game', minRole: 'USER', sortOrder: 203 },
    { name: '纳米生化装', alias: 'nano-suit', description: '纳米生化装', handlerKey: 'game', minRole: 'USER', sortOrder: 204 },
    { name: '铠甲合体', alias: 'armor-combine', description: '铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 205 },
    // 生产/建造（统一 game 处理器）
    { name: '生产', alias: 'produce', description: '家园生产操作', handlerKey: 'game', minRole: 'USER', sortOrder: 210 },
    { name: '建造', alias: 'build', description: '家园建造操作', handlerKey: 'game', minRole: 'USER', sortOrder: 211 },
    { name: '拆除', alias: 'demolish', description: '拆除家园建筑', handlerKey: 'game', minRole: 'USER', sortOrder: 212 },
    { name: '种植', alias: 'plant', description: '在家园种植作物', handlerKey: 'game', minRole: 'USER', sortOrder: 213 },
    { name: '收获', alias: 'harvest', description: '收获家园作物', handlerKey: 'game', minRole: 'USER', sortOrder: 214 },
    // 载具系统扩展（统一 game 处理器）
    { name: '载具', alias: 'vehicle', description: '查看载具状态', handlerKey: 'game', minRole: 'USER', sortOrder: 220 },
    { name: '组装', alias: 'assemble', description: '组装载具', handlerKey: 'game', minRole: 'USER', sortOrder: 221 },
    { name: '驾驶', alias: 'drive', description: '驾驶载具', handlerKey: 'game', minRole: 'USER', sortOrder: 222 },
    { name: '载具命名', alias: 'name-vehicle', description: '为载具命名', handlerKey: 'game', minRole: 'USER', sortOrder: 223 },
    { name: '载具模拟', alias: 'simulate-vehicle', description: '模拟载具操作', handlerKey: 'game', minRole: 'USER', sortOrder: 224 },
    { name: '维修', alias: 'repair', description: '维修载具', handlerKey: 'game', minRole: 'USER', sortOrder: 225 },
    { name: '脱出', alias: 'exit', description: '从载具中脱出', handlerKey: 'game', minRole: 'USER', sortOrder: 226 },
    { name: '接管', alias: 'takeover', description: '接管载具控制权', handlerKey: 'game', minRole: 'USER', sortOrder: 227 },
    { name: '架炮', alias: 'deploy-cannon', description: '架设载具炮台', handlerKey: 'game', minRole: 'USER', sortOrder: 228 },
    { name: '模式转换', alias: 'mode-change', description: '载具模式转换', handlerKey: 'game', minRole: 'USER', sortOrder: 229 },
    { name: '转换', alias: 'transform', description: '载具形态转换', handlerKey: 'game', minRole: 'USER', sortOrder: 230 },
    { name: '牵引', alias: 'tractor', description: '牵引载具', handlerKey: 'game', minRole: 'USER', sortOrder: 231 },
    { name: '控制终端', alias: 'control-terminal', description: '载具控制终端', handlerKey: 'game', minRole: 'USER', sortOrder: 232 },
    { name: '载具操作', alias: 'vehicle-ops', description: '载具操作菜单', handlerKey: 'game', minRole: 'USER', sortOrder: 233 },
    // 地图/探索扩展（统一 game 处理器）
    { name: '观察附近', alias: 'look-around', description: '观察附近环境', handlerKey: 'game', minRole: 'USER', sortOrder: 240 },
    { name: '召唤货舱', alias: 'summon-cargo', description: '召唤货舱', handlerKey: 'game', minRole: 'USER', sortOrder: 241 },
    { name: '发射信号枪', alias: 'signal-gun', description: '发射信号枪', handlerKey: 'game', minRole: 'USER', sortOrder: 242 },
    { name: '副本清空', alias: 'clear-dungeon', description: '清空副本', handlerKey: 'game', minRole: 'USER', sortOrder: 243 },
    // 宠物系统扩展（统一 game 处理器）
    { name: '开始捕捉', alias: 'start-capture', description: '开始捕捉宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 250 },
    { name: '停止捕捉', alias: 'stop-capture', description: '停止捕捉宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 251 },
    { name: '全部跟随', alias: 'follow-all,all-follow', description: '所有宠物跟随', handlerKey: 'game', minRole: 'USER', sortOrder: 252 },
    { name: '补魔', alias: 'refill', description: '补充魔力', handlerKey: 'game', minRole: 'USER', sortOrder: 253 },
    { name: '挤奶', alias: 'milk', description: '挤奶', handlerKey: 'game', minRole: 'USER', sortOrder: 254 },
    { name: '剪毛', alias: 'shear', description: '剪毛', handlerKey: 'game', minRole: 'USER', sortOrder: 255 },
    // 快捷输入（统一 game 处理器）
    { name: '快捷', alias: 'sc,shortcut', description: '快捷输入设置', handlerKey: 'game', minRole: 'USER', sortOrder: 260 },
    // 新手教程（统一 game 处理器）
    { name: '新手教程', alias: 'tutorial', description: '新手指引设置', handlerKey: 'game', minRole: 'USER', sortOrder: 270 },
    { name: '查看指定玩家', alias: 'view-player', description: '查看指定玩家信息', handlerKey: 'game', minRole: 'USER', sortOrder: 271 },
    // 其他扩展（统一 game 处理器）
    { name: '使魔大战', alias: 'game-intro', description: '游戏介绍', handlerKey: 'game', minRole: 'USER', sortOrder: 280 },
    { name: '游戏解释', alias: 'game-terms,名词解释', description: '游戏名词解释', handlerKey: 'game', minRole: 'USER', sortOrder: 281 },
    { name: '更多', alias: 'more', description: '更多帮助信息', handlerKey: 'game', minRole: 'USER', sortOrder: 282 },
    { name: '更新历史', alias: 'changelog', description: '查看更新历史', handlerKey: 'game', minRole: 'USER', sortOrder: 283 },
    { name: '贸易', alias: 'trade', description: '玩家间贸易', handlerKey: 'game', minRole: 'USER', sortOrder: 284 },
    { name: '购物', alias: 'shop', description: '商店购物', handlerKey: 'game', minRole: 'USER', sortOrder: 285 },
    // 基础社交类
    { name: '扶', alias: 'help-up', description: '扶起倒地的玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 286 },
    { name: '呼叫', alias: 'call', description: '呼叫载具到当前位置', handlerKey: 'game', minRole: 'USER', sortOrder: 287 },
    // 安装全部/拆卸全部
    { name: '安装全部', alias: 'install-all', description: '安装所有可用的载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 288 },
    { name: '拆卸全部', alias: 'uninstall-all', description: '拆卸所有载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 289 },
    // 背包操作
    { name: '背包操作', alias: 'bag-ops', description: '背包操作说明', handlerKey: 'game', minRole: 'USER', sortOrder: 290 },
    // 装备强化/加成
    { name: '装备强化', alias: 'equip-enhance', description: '强化已装备的装备', handlerKey: 'game', minRole: 'USER', sortOrder: 291 },
    { name: '装备加成', alias: 'equip-bonus', description: '查看装备加成信息', handlerKey: 'game', minRole: 'USER', sortOrder: 292 },
    { name: '装备预设', alias: 'equip-preset', description: '装备预设管理', handlerKey: 'game', minRole: 'USER', sortOrder: 293 },
    // 商店类
    { name: '活跃度商店', alias: 'activity-shop', description: '使用活跃度兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 294 },
    { name: '钻石商店', alias: 'diamond-shop', description: '使用钻石兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 295 },
    { name: '数据商店', alias: 'data-shop', description: '使用数据兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 296 },
    // 探测扩展
    { name: '探测雷达', alias: 'probe-radar', description: '使用雷达探测当前地图', handlerKey: 'game', minRole: 'USER', sortOrder: 297 },
    { name: '探测资源', alias: 'probe-resource', description: '探测当前地图资源', handlerKey: 'game', minRole: 'USER', sortOrder: 298 },
    { name: '探测拾取', alias: 'probe-pickup', description: '探测并拾取物品', handlerKey: 'game', minRole: 'USER', sortOrder: 299 },
    { name: '探测作物', alias: 'probe-crop', description: '探测当前地图的作物', handlerKey: 'game', minRole: 'USER', sortOrder: 300 },
    // 宠物扩展
    { name: '宠物操作', alias: 'pet-ops', description: '宠物操作菜单', handlerKey: 'game', minRole: 'USER', sortOrder: 301 },
    { name: '宠物改名', alias: 'pet-rename', description: '为宠物改名', handlerKey: 'game', minRole: 'USER', sortOrder: 302 },
    { name: '宠物转让', alias: 'pet-transfer', description: '转让宠物给其他玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 303 },
    { name: '宠物驾驶', alias: 'pet-drive', description: '骑乘宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 304 },
    { name: '宠物喂食', alias: 'pet-feed', description: '喂食宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 305 },
    { name: '宠物嗅探', alias: 'pet-sniff', description: '宠物嗅探搜索', handlerKey: 'game', minRole: 'USER', sortOrder: 306 },
    { name: '宠物觉醒', alias: 'pet-awaken', description: '宠物觉醒操作', handlerKey: 'game', minRole: 'USER', sortOrder: 307 },
    { name: '宠物攻击', alias: 'pet-attack', description: '宠物攻击指令', handlerKey: 'game', minRole: 'USER', sortOrder: 308 },
    { name: '宠物前往', alias: 'pet-goto', description: '宠物前往指定位置', handlerKey: 'game', minRole: 'USER', sortOrder: 309 },
    { name: '宠物装备', alias: 'pet-equip', description: '宠物装备管理', handlerKey: 'game', minRole: 'USER', sortOrder: 310 },
    // 全部指令（全部跟随已存在 sortOrder 252，此处跳过）
    { name: '全部停下', alias: 'all-stop', description: '所有宠物停下', handlerKey: 'game', minRole: 'USER', sortOrder: 311 },
    { name: '全部主动', alias: 'all-active', description: '所有宠物设为主动', handlerKey: 'game', minRole: 'USER', sortOrder: 312 },
    { name: '全部被动', alias: 'all-passive', description: '所有宠物设为被动', handlerKey: 'game', minRole: 'USER', sortOrder: 313 },
    { name: '全部挤奶', alias: 'all-milk', description: '给所有可挤奶的宠物挤奶', handlerKey: 'game', minRole: 'USER', sortOrder: 314 },
    { name: '全部指令', alias: 'all-commands', description: '查看所有宠物指令', handlerKey: 'game', minRole: 'USER', sortOrder: 315 },
    // 家园扩展
    { name: '家园操作', alias: 'home-ops', description: '家园操作菜单', handlerKey: 'game', minRole: 'USER', sortOrder: 316 },
    { name: '家园前线', alias: 'home-front', description: '家园前线防御', handlerKey: 'game', minRole: 'USER', sortOrder: 317 },
    { name: '家园产出', alias: 'home-output', description: '查看家园产出', handlerKey: 'game', minRole: 'USER', sortOrder: 318 },
    { name: '家园音乐', alias: 'home-music', description: '家园音乐设置', handlerKey: 'game', minRole: 'USER', sortOrder: 319 },
    { name: '家园搬迁', alias: 'home-relocate', description: '搬迁家园', handlerKey: 'game', minRole: 'USER', sortOrder: 320 },
    { name: '家园命名', alias: 'home-rename', description: '为家园命名', handlerKey: 'game', minRole: 'USER', sortOrder: 321 },
    // 开采扩展
    { name: '开采自动', alias: 'auto-mine', description: '开启自动开采模式', handlerKey: 'game', minRole: 'USER', sortOrder: 322 },
    { name: '开采停止', alias: 'stop-mine', description: '停止开采', handlerKey: 'game', minRole: 'USER', sortOrder: 323 },
    // 配方
    { name: '配方解锁', alias: 'recipe-unlock', description: '解锁新的制造配方', handlerKey: 'game', minRole: 'USER', sortOrder: 324 },
    // 求助/购物扩展
    { name: '求助确认', alias: 'confirm-help', description: '确认求助请求', handlerKey: 'game', minRole: 'USER', sortOrder: 325 },
    { name: '购物自动', alias: 'auto-shop', description: '自动购物模式', handlerKey: 'game', minRole: 'USER', sortOrder: 326 },
    // 管理扩展
    { name: '刷新怪物', alias: 'refresh-monster', description: '刷新当前地图怪物(管理员)', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 327 },
    { name: '删除怪物', alias: 'delete-monster', description: '删除当前地图怪物(管理员)', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 328 },
    { name: '生成人物', alias: 'spawn-npc', description: '生成NPC(管理员)', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 329 },
    // 生产模式
    { name: '生产0', alias: 'prod-mode-0', description: '切换生产模式为正常', handlerKey: 'game', minRole: 'USER', sortOrder: 330 },
    { name: '生产1', alias: 'prod-mode-1', description: '切换生产模式为超载', handlerKey: 'game', minRole: 'USER', sortOrder: 331 },
    // 铠甲合体
    { name: '炎龙', alias: 'yanlong', description: '炎龙铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 332 },
    { name: '黑犀', alias: 'heixi', description: '黑犀铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 333 },
    { name: '飞影', alias: 'feiying', description: '飞影铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 334 },
    { name: '地虎', alias: 'dihu', description: '地虎铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 335 },
    { name: '雪獒', alias: 'xueao', description: '雪獒铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 336 },
    // 其他
    { name: '转换文本', alias: 'transform-text', description: '文本转换操作', handlerKey: 'game', minRole: 'USER', sortOrder: 337 },
    { name: '保存图片', alias: 'save-image', description: '保存图片到本地', handlerKey: 'game', minRole: 'USER', sortOrder: 338 },
    { name: '保存图片开始', alias: 'start-save-image', description: '开始自动保存图片', handlerKey: 'game', minRole: 'USER', sortOrder: 339 },
    { name: '保存图片停止', alias: 'stop-save-image', description: '停止自动保存图片', handlerKey: 'game', minRole: 'USER', sortOrder: 340 },
    // 接管停止
    { name: '接管停止', alias: 'stop-takeover', description: '停止接管载具', handlerKey: 'game', minRole: 'USER', sortOrder: 341 },
    // 确认还原
    { name: '确认还原植入体等级', alias: 'confirm-reset-implant', description: '确认还原植入体等级', handlerKey: 'game', minRole: 'USER', sortOrder: 342 },
    { name: '确认还原增幅器等级', alias: 'confirm-reset-amplifier', description: '确认还原增幅器等级', handlerKey: 'game', minRole: 'USER', sortOrder: 343 },
    // 被挤出排序的旧指令（从原 286-291 移至此处）
    { name: '求助', alias: 'help-me', description: '获取帮助', handlerKey: 'game', minRole: 'USER', sortOrder: 344 },
    { name: '配方', alias: 'recipe', description: '查看制造配方', handlerKey: 'game', minRole: 'USER', sortOrder: 345 },
    { name: '逆向', alias: 'reverse', description: '逆向操作', handlerKey: 'game', minRole: 'USER', sortOrder: 346 },
    { name: '预设切换', alias: 'preset,切换预设', description: '切换装备预设', handlerKey: 'game', minRole: 'USER', sortOrder: 347 },
    { name: '签到', alias: 'daily-checkin', description: '每日签到', handlerKey: 'game', minRole: 'USER', sortOrder: 348 },
    { name: '文本发送', alias: 'text-send', description: '文本发送', handlerKey: 'game', minRole: 'USER', sortOrder: 349 },
    // 设置子指令（统一 game 处理器）
    { name: '设置指引', alias: 'setting-guide', description: '设置新手指引开关', handlerKey: 'game', minRole: 'USER', sortOrder: 350 },
    { name: '设置随机', alias: 'setting-random', description: '设置随机移动模式', handlerKey: 'game', minRole: 'USER', sortOrder: 351 },
    { name: '设置采集', alias: 'setting-gather', description: '设置自动采集模式', handlerKey: 'game', minRole: 'USER', sortOrder: 352 },
    { name: '设置活力', alias: 'setting-vitality', description: '设置活力管理', handlerKey: 'game', minRole: 'USER', sortOrder: 353 },
    { name: '设置不扶', alias: 'setting-no-help', description: '设置是否自动扶起', handlerKey: 'game', minRole: 'USER', sortOrder: 354 },
    { name: '设置音乐', alias: 'setting-music', description: '设置音乐播放', handlerKey: 'game', minRole: 'USER', sortOrder: 355 },
    { name: '设置倍率', alias: 'setting-multiplier', description: '设置显示倍率', handlerKey: 'game', minRole: 'USER', sortOrder: 356 },
    { name: '设置购物', alias: 'setting-shop', description: '设置自动购物', handlerKey: 'game', minRole: 'USER', sortOrder: 357 },
    { name: '设置位置', alias: 'setting-location', description: '设置位置显示', handlerKey: 'game', minRole: 'USER', sortOrder: 358 },
    { name: '设置标记', alias: 'setting-marker', description: '设置自定义标记', handlerKey: 'game', minRole: 'USER', sortOrder: 359 },
    // 管理（统一 game 处理器）
    { name: '管理', alias: 'admin,管理员', description: '管理员操作入口', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 999 },
  ] as const;

  for (const cmd of commands) {
    await prisma.command.upsert({
      where: { name: cmd.name },
      // 以代码为准：已存在也更新为 seed 中的最新值（便于改描述/别名/权限等）
      update: cmd as any,
      create: cmd as any,
    });
  }
  console.log(`✅ 指令表: ${commands.length} 条指令`);

  // 3. 系统配置中心初始项
  const systemConfigs = [
    { key: 'command.prefixes', value: JSON.stringify(['/', '！', '!']), label: '指令前缀', description: '以这些字符开头的输入会作为指令处理', type: 'string-array', group: 'command' },
    { key: 'command.requirePrefix', value: 'false', label: '必须带前缀才算指令', description: 'true=必须带前缀；false=无前缀时若命中指令名/别名也作为指令', type: 'boolean', group: 'command' },
    { key: 'game.playerBaseHp', value: '100', label: '玩家基础生命', description: '新玩家初始生命值', type: 'number', group: 'game' },
    { key: 'game.playerBaseAttack', value: '10', label: '玩家基础攻击', description: '新玩家初始攻击力', type: 'number', group: 'game' },
    { key: 'game.cooldownSeconds', value: '2', label: '指令冷却时间', description: '普通指令的冷却间隔(秒)', type: 'number', group: 'game' },
    { key: 'game.attackCooldownSeconds', value: '5', label: '攻击指令冷却时间', description: '攻击指令的冷却间隔(秒)', type: 'number', group: 'game' },
    { key: 'game.expMultiplier', value: '1.0', label: '经验倍率', description: '全局经验获取倍率', type: 'number', group: 'game' },
    { key: 'game.dropMultiplier', value: '1.0', label: '掉落倍率', description: '全局物品掉落倍率', type: 'number', group: 'game' },
    { key: 'game.maxPlayers', value: '1000', label: '最大玩家数', description: '服务器最大玩家数量', type: 'number', group: 'game' },
    { key: 'game.autoSaveInterval', value: '300', label: '自动保存间隔(秒)', description: '后台自动保存玩家数据的间隔', type: 'number', group: 'game' },
    { key: 'game.respawnTime', value: '30', label: '怪物重生时间(秒)', description: '怪物被击杀后重生时间', type: 'number', group: 'game' },
    { key: 'game.commandCooldownSeconds', value: '2', label: '指令冷却(秒)', description: '普通指令的冷却时间', type: 'number', group: 'game' },
    { key: 'game.weaponCooldownMultiplier', value: '1.0', label: '武器冷却倍率', description: '武器冷却时间倍率', type: 'number', group: 'game' },
    { key: 'game.spawnMonsterCooldown', value: '60', label: '怪物刷新时间(秒)', description: '地图怪物被清空后刷新时间', type: 'number', group: 'game' },
    { key: 'game.worldLevel', value: '1', label: '世界等级', description: '当前世界等级，影响怪物强度和掉落', type: 'number', group: 'game' },
    { key: 'game.adminQQ', value: '', label: '管理员QQ', description: '拥有管理员权限的QQ号（逗号分隔）', type: 'string', group: 'game' },
  ] as const;

  for (const cfg of systemConfigs) {
    await prisma.systemConfig.upsert({
      where: { key: cfg.key },
      update: {},
      create: cfg as any,
    });
  }
  console.log(`✅ 系统配置: ${systemConfigs.length} 项`);

  // 4. 初始游戏地图
  const maps = [
    { name: '新手村', description: '冒险开始的地方，到处是柔弱的史莱姆', mapIndex: 1, level: 1, monsterCount: 3, connections: JSON.stringify([{ name: '迷雾森林', distance: 10, frontier: false }]) },
    { name: '迷雾森林', description: '浓雾笼罩的森林，有野兽出没', mapIndex: 2, level: 5, monsterCount: 4, connections: JSON.stringify([{ name: '新手村', distance: 10, frontier: false }, { name: '古老遗迹', distance: 20, frontier: false }]) },
    { name: '古老遗迹', description: '上古文明留下的废墟，藏着珍贵的宝物', mapIndex: 3, level: 10, monsterCount: 5, connections: JSON.stringify([{ name: '迷雾森林', distance: 20, frontier: false }]) },
    { name: '火焰山', description: '终年燃烧的火山，炎热无比', mapIndex: 4, level: 20, monsterCount: 5, requiredTravel: 1, connections: JSON.stringify([{ name: '新手村', distance: 50, frontier: false }]) },
    { name: '冰霜峡谷', description: '极寒之地，冰雪覆盖的险峻峡谷', mapIndex: 5, level: 30, monsterCount: 6, requiredTravel: 2, connections: JSON.stringify([{ name: '新手村', distance: 80, frontier: false }]) },
    { name: '天空之城', description: '漂浮在云端的城市，需要飞行才能到达', mapIndex: 6, level: 40, monsterCount: 6, requiredTravel: 1, connections: JSON.stringify([{ name: '火焰山', distance: 100, frontier: false }]) },
    { name: '虚空裂隙', description: '时空错乱之地，危险与机遇并存', mapIndex: 7, level: 50, monsterCount: 7, requiredTravel: 3, connections: JSON.stringify([{ name: '冰霜峡谷', distance: 150, frontier: false }]) },
  ] as const;

  for (const map of maps) {
    await prisma.gameMap.upsert({
      where: { name: map.name },
      update: map as any, // 以代码为准，已存在也更新
      create: map as any,
    });
  }
  console.log(`✅ 游戏地图: ${maps.length} 个`);

  // 5. 初始物品
  const items = [
    { name: '生命药水', description: '恢复50点生命值', value: 10, type: '消耗品', useEffects: JSON.stringify(['恢复50点生命值']) },
    { name: '魔力药水', description: '恢复30点魔力', value: 15, type: '消耗品', useEffects: JSON.stringify(['恢复30点魔力']) },
    { name: '铁矿石', description: '常见的矿石，可用于锻造', value: 5, type: '材料' },
    { name: '银矿石', description: '稀有的银矿石，价值较高', value: 20, type: '材料' },
    { name: '金矿石', description: '珍贵的金矿石', value: 50, type: '材料' },
    { name: '木材', description: '普通的木材，可用于建造和制造', value: 2, type: '材料' },
    { name: '石材', description: '普通的石材，可用于建造', value: 3, type: '材料' },
    { name: '布匹', description: '柔软的布匹，可用于制作装备', value: 8, type: '材料' },
    { name: '皮革', description: '结实的皮革，可用于制作装备', value: 10, type: '材料' },
    { name: '魔法粉末', description: '蕴含魔力的粉末，用于附魔', value: 30, type: '材料' },
    { name: '史莱姆粘液', description: '史莱姆掉落的粘液，可用于炼金', value: 5, type: '材料' },
    { name: '野兽之骨', description: '强大野兽的骨头，可用于制作武器', value: 15, type: '材料' },
    { name: '龙鳞碎片', description: '传说中龙的鳞片碎片，极为珍贵', value: 200, type: '材料' },
    { name: '经验书', description: '记载着古老知识的书籍，使用可获得经验', value: 50, type: '消耗品', useEffects: JSON.stringify(['获得100点经验']) },
    { name: '传送卷轴', description: '可瞬间传送回新手村', value: 25, type: '消耗品', useEffects: JSON.stringify(['传送回新手村']) },
    { name: '钻石', description: '闪闪发光的钻石，游戏中的硬通货', value: 100, type: '货币' },
    { name: '金币', description: '游戏中的通用货币', value: 1, type: '货币' },
    { name: '未知物品', description: '具现装置凝聚出的未知物质，交给露娜可兑换奖励', value: 10, type: '材料' },
    { name: '工业建筑箱', description: '露娜赠予的箱子，内含工业建筑材料', value: 100, type: '材料' },
    { name: '专属装备补给箱', description: '露娜赠予的箱子，内含专属装备', value: 200, type: '材料' },
  ] as const;

  for (const item of items) {
    await prisma.gameItem.upsert({
      where: { name: item.name },
      update: item as any, // 以代码为准，已存在也更新
      create: item as any,
    });
  }
  console.log(`✅ 物品: ${items.length} 种`);

  // 6. 初始装备
  const equipment = [
    { name: '新手之剑', description: '冒险者协会发给新手的制式长剑', equipType: '武器', bonus: JSON.stringify({ attack: 5 }), baseBonus: '{}', properties: JSON.stringify({ phys: 100 }), attackText: JSON.stringify({ name: '新手之剑', attacks: ['斩击', '劈砍'] }) },
    { name: '木盾', description: '简陋的木制盾牌，能提供少量防御', equipType: '副手', bonus: JSON.stringify({ armor: 3, dodge: 2 }), properties: '{}' },
    { name: '布甲', description: '轻便的布制护甲，提供基本的防护', equipType: '护甲', bonus: JSON.stringify({ armor: 5, hp: 10 }), properties: '{}' },
    { name: '铁剑', description: '铁匠打造的锋利长剑', equipType: '武器', bonus: JSON.stringify({ attack: 12 }), properties: JSON.stringify({ phys: 100 }) },
    { name: '铁甲', description: '铁制的坚固护甲，提供良好的防护', equipType: '护甲', bonus: JSON.stringify({ armor: 10, hp: 20 }), properties: '{}' },
    { name: '铁头盔', description: '铁制的头盔，保护头部', equipType: '头部', bonus: JSON.stringify({ armor: 5, dodge: 1 }), properties: '{}' },
    { name: '皮靴', description: '轻便的皮靴，提高移动速度', equipType: '脚部', bonus: JSON.stringify({ speed: 10, dodge: 3 }), properties: '{}' },
    { name: '银戒指', description: '蕴含魔力的银戒指', equipType: '饰品', bonus: JSON.stringify({ attack: 5, magic: 10 }), properties: '{}' },
    { name: '钢剑', description: '精钢打造的长剑，锋利无比', equipType: '武器', bonus: JSON.stringify({ attack: 25 }), properties: JSON.stringify({ phys: 100 }) },
    { name: '板甲', description: '厚重的钢板护甲，防御力极高', equipType: '护甲', bonus: JSON.stringify({ armor: 20, hp: 40, dodge: -5 }), properties: '{}' },
  ] as const;

  for (const eq of equipment) {
    await prisma.gameEquipment.upsert({
      where: { name: eq.name },
      update: eq as any, // 以代码为准，已存在也更新
      create: eq as any,
    });
  }
  console.log(`✅ 装备: ${equipment.length} 种`);

  // 7. 初始使魔
  const familiars = [
    { name: '花园猫', uniqueSkill: '猫爪攻击', description: '可爱的花园猫，擅长快速攻击', specialSeq: 1, noSummon: false, hairDrop: JSON.stringify({ name: '猫毛', count: 1 }) },
    { name: '长萌', uniqueSkill: '长萌之光', description: '神秘的长萌，拥有治愈能力', specialSeq: 2, noSummon: false },
    { name: '绝灭天使', uniqueSkill: '灭绝之光', description: '强大的天使型使魔，拥有毁灭性力量', specialSeq: 3, noSummon: false },
    { name: '剑圣', uniqueSkill: '剑术精通', description: '剑术大师，近战攻击力极强', specialSeq: 4, noSummon: false },
    { name: '古月娜', uniqueSkill: '月光洗礼', description: '月之使者，拥有强大的辅助能力', specialSeq: 5, noSummon: false },
    { name: '恶毒', uniqueSkill: '毒液喷溅', description: '擅长使用毒素攻击的使魔', specialSeq: 6, noSummon: false },
    { name: '阿尔缇娜', uniqueSkill: '冰霜新星', description: '冰之魔女，擅长冰系魔法', specialSeq: 7, noSummon: false },
    { name: '战斗女仆', uniqueSkill: '女仆的守护', description: '全能型战斗女仆，能打能奶', specialSeq: 8, noSummon: false },
    { name: '冥鱼', uniqueSkill: '暗影潜行', description: '来自深渊的鱼型使魔，擅长暗杀', specialSeq: 9, noSummon: false },
    { name: '小樱', uniqueSkill: '樱花飞舞', description: '如樱花般美丽的使魔，拥有多种能力', specialSeq: 10, noSummon: false },
  ] as const;

  for (const f of familiars) {
    await prisma.gameFamiliar.upsert({
      where: { name: f.name },
      update: f as any, // 以代码为准，已存在也更新
      create: f as any,
    });
  }
  console.log(`✅ 使魔: ${familiars.length} 种`);

  // 8. 初始怪物
  const monsters = [
    { name: '史莱姆', specialSeq: -1, type: '怪物', description: '最基础的怪物，软软的', hp: 30, attack: 5, defense: 1, speed: 50, dodge: 5, hit: 90, bonus: '{}' },
    { name: '野狼', specialSeq: -1, type: '怪物', description: '凶猛的野狼，速度快', hp: 50, attack: 8, defense: 3, speed: 80, dodge: 10, hit: 85, bonus: '{}' },
    { name: '哥布林', specialSeq: -1, type: '怪物', description: '狡猾的哥布林，会使用简单武器', hp: 40, attack: 7, defense: 2, speed: 60, dodge: 8, hit: 80, bonus: '{}' },
    { name: '石巨人', specialSeq: -1, type: '怪物', description: '由岩石组成的巨人，防御力极高', hp: 200, attack: 15, defense: 20, speed: 30, dodge: 2, hit: 70, bonus: '{}' },
    { name: '火焰精灵', specialSeq: -1, type: '怪物', description: '由火焰组成的精灵，攻击附带灼烧', hp: 60, attack: 12, defense: 5, speed: 70, dodge: 15, hit: 80, bonus: '{}' },
    { name: '冰霜巨龙', specialSeq: -1, type: '怪物', description: '冰霜系的巨龙，极为强大', hp: 500, attack: 35, defense: 25, speed: 60, dodge: 8, hit: 85, bonus: '{}' },
    { name: '暗影刺客', specialSeq: -1, type: '怪物', description: '隐匿在暗处的刺客，闪避极高', hp: 80, attack: 20, defense: 5, speed: 95, dodge: 30, hit: 75, bonus: '{}' },
    { name: '虚空行者', specialSeq: -1, type: '怪物', description: '来自虚空的强大存在', hp: 800, attack: 50, defense: 30, speed: 80, dodge: 15, hit: 90, bonus: '{}' },
  ] as const;

  for (const m of monsters) {
    await prisma.gameMonster.upsert({
      where: { name: m.name },
      update: m as any, // 以代码为准，已存在也更新
      create: m as any,
    });
  }
  console.log(`✅ 怪物: ${monsters.length} 种`);

  // 9. 初始增益/减益
  const buffs = [
    { name: '灼烧', description: '持续受到火焰伤害', duration: 10, chance: 80, stackTime: false, bonus: JSON.stringify({ fireDamage: 5, attack: -2 }), triggerText: '感到灼烧的痛苦' },
    { name: '冰冻', description: '移动速度和攻击速度降低', duration: 8, chance: 70, stackTime: false, bonus: JSON.stringify({ speed: -30, dodge: -10 }), triggerText: '被冻住了' },
    { name: '中毒', description: '持续受到毒素伤害', duration: 15, chance: 75, stackTime: true, bonus: JSON.stringify({ poisonDamage: 3 }), triggerText: '中毒了' },
    { name: '护盾', description: '获得一个吸收伤害的护盾', duration: 30, chance: 100, stackTime: false, bonus: JSON.stringify({ shield: 50 }), triggerText: '获得护盾' },
    { name: '狂暴', description: '攻击力大幅提升但防御降低', duration: 15, chance: 100, stackTime: false, bonus: JSON.stringify({ attack: 30, defense: -10 }), triggerText: '进入狂暴状态' },
    { name: '治愈', description: '持续恢复生命值', duration: 10, chance: 100, stackTime: true, bonus: JSON.stringify({ regenHp: 5 }), triggerText: '感到一股暖流' },
    { name: '虚弱', description: '攻击力和防御力降低', duration: 12, chance: 80, stackTime: false, bonus: JSON.stringify({ attack: -10, defense: -5 }), triggerText: '变得虚弱无力' },
    { name: '加速', description: '移动速度和闪避提升', duration: 20, chance: 100, stackTime: false, bonus: JSON.stringify({ speed: 30, dodge: 15 }), triggerText: '感觉身轻如燕' },
  ] as const;

  for (const b of buffs) {
    await prisma.gameBuff.upsert({
      where: { name: b.name },
      update: b as any, // 以代码为准，已存在也更新
      create: b as any,
    });
  }
  console.log(`✅ 增益/减益: ${buffs.length} 种`);

  // 10. 初始制造配方
  const craftings = [
    { name: '制作木盾', description: '用木材制作一个木盾', level: 1, outputs: JSON.stringify([{ name: '木盾', count: 1 }]), requirements: JSON.stringify([{ name: '木材', count: 5 }]) },
    { name: '制作铁剑', description: '用铁矿石锻造铁剑', level: 5, outputs: JSON.stringify([{ name: '铁剑', count: 1 }]), requirements: JSON.stringify([{ name: '铁矿石', count: 10 }, { name: '木材', count: 3 }]) },
    { name: '制作铁甲', description: '用铁矿石锻造铁甲', level: 8, outputs: JSON.stringify([{ name: '铁甲', count: 1 }]), requirements: JSON.stringify([{ name: '铁矿石', count: 15 }, { name: '布匹', count: 5 }]) },
    { name: '制作生命药水', description: '调配生命药水', level: 2, outputs: JSON.stringify([{ name: '生命药水', count: 1 }]), requirements: JSON.stringify([{ name: '史莱姆粘液', count: 3 }, { name: '魔法粉末', count: 1 }]) },
    { name: '分解铁矿石', description: '将铁矿石分解为基础材料', noCraft: true, level: 1, outputs: JSON.stringify([{ name: '石材', count: 2 }]), requirements: JSON.stringify([{ name: '铁矿石', count: 1 }]), deconstructMul: 2 },
  ] as const;

  for (const c of craftings) {
    await prisma.gameCrafting.upsert({
      where: { name: c.name },
      update: c as any, // 以代码为准，已存在也更新
      create: c as any,
    });
  }
  console.log(`✅ 制造配方: ${craftings.length} 种`);

  // 11. 默认管理员账号
  const existingAdmin = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (!existingAdmin) {
    const bcrypt = await import('bcrypt');
    const hashed = await bcrypt.hash('admin123', 10);
    await prisma.user.create({
      data: {
        username: 'admin',
        password: hashed,
        nickname: '管理员',
        role: 'SUPER_ADMIN',
      },
    });
    console.log('✅ 默认管理员已创建: admin / admin123');
  } else {
    console.log('ℹ️ 管理员账号已存在，跳过');
  }

  // 12. 同步删除：以代码为准，删除 seed 中已不存在的记录(处理"删除/重命名"场景)
  // 每类数据取 seed 里的 name 集合，删除数据库中不在该集合内的记录
  const syncDeleted = async (label: string, seedNames: string[], findMany: any, deleteMany: any) => {
    const seedSet = new Set(seedNames);
    const existing = await findMany({ select: { name: true } });
    const toDelete = existing
      .map((r: any) => r.name)
      .filter((n: string) => n && !seedSet.has(n));
    if (toDelete.length > 0) {
      await deleteMany({ where: { name: { in: toDelete } } });
      console.log(`🗑️ ${label}: 已删除 ${toDelete.length} 条(代码中已移除): ${toDelete.join(', ')}`);
    }
  };
  await syncDeleted('指令', commands.map((c) => c.name), (q: any) => prisma.command.findMany(q), (q: any) => prisma.command.deleteMany(q));
  await syncDeleted('地图', maps.map((m) => m.name), (q: any) => prisma.gameMap.findMany(q), (q: any) => prisma.gameMap.deleteMany(q));
  await syncDeleted('物品', items.map((i) => i.name), (q: any) => prisma.gameItem.findMany(q), (q: any) => prisma.gameItem.deleteMany(q));
  await syncDeleted('装备', equipment.map((e) => e.name), (q: any) => prisma.gameEquipment.findMany(q), (q: any) => prisma.gameEquipment.deleteMany(q));
  await syncDeleted('使魔', familiars.map((f) => f.name), (q: any) => prisma.gameFamiliar.findMany(q), (q: any) => prisma.gameFamiliar.deleteMany(q));
  await syncDeleted('怪物', monsters.map((m) => m.name), (q: any) => prisma.gameMonster.findMany(q), (q: any) => prisma.gameMonster.deleteMany(q));
  await syncDeleted('增益/减益', buffs.map((b) => b.name), (q: any) => prisma.gameBuff.findMany(q), (q: any) => prisma.gameBuff.deleteMany(q));
  await syncDeleted('制造配方', craftings.map((c) => c.name), (q: any) => prisma.gameCrafting.findMany(q), (q: any) => prisma.gameCrafting.deleteMany(q));

  console.log('🎉 种子数据写入完成');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });