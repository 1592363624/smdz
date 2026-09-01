/**
 * 一次性验证脚本：数据文件干净化 + loadRaw 归一化后，关键静态数据路径输出正常。运行后删除。
 */
import { StaticDataService } from '../src/modules/game/static-data.service';
import { asJsonValue } from '../src/common/utils/json-value.util';

const svc = new StaticDataService();
let failed = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' | ' + extra : ''}`);
  if (!ok) failed++;
};

// 1. 怪物 bonus 现为对象
const monster = (svc as any).getMonsterByName('史莱姆') || (svc as any).getAllMonsters()[0];
check('怪物模板 bonus 为对象', typeof monster?.bonus === 'object' && !Array.isArray(monster?.bonus));

// 2. 物品 useEffects / useMarkers 为数组
const item = (svc as any).getAllItems().find((i: any) => Array.isArray(i.useEffects) && i.useEffects.length) || (svc as any).getAllItems()[0];
check('物品 useEffects 为数组', Array.isArray(item?.useEffects), JSON.stringify(item?.useEffects)?.slice(0, 60));

// 3. 装备 affixes / bonus 为真实结构
const equip = (svc as any).getAllEquipments()[0];
check('装备 affixes 为数组', Array.isArray(equip?.affixes));
check('装备 bonus 为对象', typeof equip?.bonus === 'object');

// 4. 制造配方 requirements/outputs 为数组
const recipe = (svc as any).getAllCraftings().find((c: any) => Array.isArray(c.requirements) && c.requirements.length);
check('制造配方 requirements 为数组', !!recipe, JSON.stringify(recipe?.requirements)?.slice(0, 80));
check('asJsonValue 吃对象数组', JSON.stringify(asJsonValue(recipe?.requirements, [])) === JSON.stringify(recipe?.requirements));

// 5. 地图 resources 为对象数组（用户痛点字段）
const maps = (svc as any).getAllMaps();
const mapWithRes = maps.find((m: any) => Array.isArray(m.resources) && m.resources.length);
check('地图 resources 为对象数组', !!mapWithRes, mapWithRes ? `示例: ${mapWithRes.name} -> ${JSON.stringify(mapWithRes.resources[0]).slice(0, 80)}` : '');
const mapWithConn = maps.find((m: any) => Array.isArray(m.connections) && m.connections.length);
check('地图 connections 为对象数组', !!mapWithConn);
const conn = asJsonValue<any[]>(mapWithConn?.connections, []);
check('getConnections 语义(asJsonValue 吃数组)', Array.isArray(conn) && typeof conn[0] === 'object');

// 6. NPC 台词 / 攻击文本字段
const npc = (svc as any).loadRaw('npcs')[0];
check('NPC friendlyChat 为数组', Array.isArray(npc?.friendlyChat));
const at = (svc as any).loadRaw('attackTexts')[0];
check('攻击文本 attackTexts 为数组', Array.isArray(at?.attackTexts));

// 7. 使魔 affinityDesc / hairDrop
const fam = (svc as any).getAllFamiliars()[0];
check('使魔 affinityDesc 为数组', Array.isArray(fam?.affinityDesc));
check('使魔 hairDrop 为数组', Array.isArray(fam?.hairDrop));

// 8. 商店 + 行商（此前已验证，回归确认）
const shop = svc.getShopConfig();
check('兑换商店三栏', shop.activity.length === 8 && shop.diamond.length === 3 && shop.dataCore.length === 14, `活跃${shop.activity.length}/钻石${shop.diamond.length}/数据${shop.dataCore.length}`);
const merchant = svc.getMerchantConfig();
check('行商配置', merchant.equipmentText.length > 0 && merchant.itemText.length > 0);

// 9. 载具模板 bonus/parts 为真实结构（seed 边界 stringify 前的输入形态）
const vehicle = (svc as any).loadRaw('vehicles').find((v: any) => v.parts !== undefined) || (svc as any).loadRaw('vehicles')[0];
check('载具 bonus 为对象', typeof vehicle?.bonus === 'object');
check('载具 parts 为数组', Array.isArray(vehicle?.parts));

console.log(failed === 0 ? '\n🎉 全部验证通过' : `\n💥 ${failed} 项验证失败`);
if (failed > 0) process.exit(1);
