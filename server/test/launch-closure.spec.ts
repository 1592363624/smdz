import { BonusService } from '../src/modules/game/bonus.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { ItemService } from '../src/modules/game/item.service';
import { PlayerService } from '../src/modules/game/player.service';
import { MapService } from '../src/modules/game/map.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { AchievementService } from '../src/modules/game/achievement.service';
import { parseJson } from './parse-json.util';

describe('上线闭环补齐：取对话/反转童话/贯穿抵抗词条', () => {
  describe('取对话（数据显示.ecode L119-287）', () => {
    const staticData = new StaticDataService();

    it('类型归一化：去精英/神兽/深蓝前缀后命中专属台词', () => {
      const line = staticData.getDialogue('测试者', { type: '精英神兽白' }, '白', 2);
      // 白 对话条目存在（npcs.json"白对话"），跟随台词池非空 → 命中专属条目
      expect(line).not.toBe('……');
      const entry = staticData.getNpcByName('白对话');
      const pool = parseJson(entry.followText, []);
      expect(pool).toContain(line);
    });

    it('npc1g 映射为神之工匠；巨型宇航兔→宇航兔', () => {
      // npc1g → 类型"神之工匠" → 命中"神之工匠对话"条目（stopText 非空，取专属台词）
      const line = staticData.getDialogue('测试者', { qq: 'npc1g' }, '神之工匠', 3);
      const entry = staticData.getNpcByName('神之工匠对话');
      const pool = parseJson(entry?.stopText, []);
      expect(pool.length).toBeGreaterThan(0);
      expect(pool).toContain(line);
    });

    it('对应类别为空时回落通用对话并替换【名称】/【目标】', () => {
      // 通用对话的 followText 含【名称】占位
      const genericFollow = parseJson(staticData.getNpcByName('通用对话').followText, []) as string[];
      const hasPlaceholder = genericFollow.some((t) => t.includes('【名称】'));
      if (!hasPlaceholder) return;
      let matched = false;
      for (let i = 0; i < 20; i++) {
        const line = staticData.getDialogue('阿虚', { type: '不存在的物种' }, '三三', 2);
        expect(line).not.toContain('【名称】');
        expect(line).not.toContain('【目标】');
        if (line.includes('阿虚')) { matched = true; break; }
      }
      expect(matched).toBe(true);
    });

    it('完全无台词时返回省略号', () => {
      const svc = new StaticDataService();
      jest.spyOn(svc as any, 'getNpcByName').mockReturnValue(null);
      expect(svc.getDialogue('玩家', { type: '未知' }, '对象', 6)).toBe('……');
    });
  });

  describe('反转童话 消费端（使魔技能.ecode L2631-2745）', () => {
    const bonus = new BonusService();

    it('fzth1 只翻转正值护盾四抗，负值/零不动', () => {
      const attrs: any = {
        护盾电抗: 10, 护盾火抗: -20, 护盾冰抗: 0, 护盾物抗: 5,
      };
      bonus.consumeReverseFairytaleBuffs(attrs, [{ name: 'fzth1' }]);
      expect(attrs.护盾电抗).toBe(-10);
      expect(attrs.护盾火抗).toBe(-20); // 已负不再翻
      expect(attrs.护盾冰抗).toBe(0);   // 零不动
      expect(attrs.护盾物抗).toBe(-5);
    });

    it('fzth7 翻转三回复与三回复2；fzth10 翻转四伤', () => {
      const attrs: any = {
        护盾回复: 1, 装甲回复: 2, 生命回复: 3,
        护盾回复2: 4, 装甲回复2: 5, 生命回复2: 6,
        电伤: 100, 火伤: 200, 冰伤: 300, 物伤: 400,
      };
      bonus.consumeReverseFairytaleBuffs(attrs, [
        { name: 'fzth7' }, { 名称: 'fzth10' },
      ]);
      expect(attrs.护盾回复).toBe(-1);
      expect(attrs.装甲回复).toBe(-2);
      expect(attrs.生命回复).toBe(-3);
      expect(attrs.护盾回复2).toBe(-4);
      expect(attrs.装甲回复2).toBe(-5);
      expect(attrs.生命回复2).toBe(-6);
      expect(attrs.电伤).toBe(-100);
      expect(attrs.物伤).toBe(-400);
    });

    it('无 fzth 增益时不改动任何属性', () => {
      const attrs: any = { 闪避: 50 };
      bonus.consumeReverseFairytaleBuffs(attrs, [{ name: '幻时' }]);
      expect(attrs.闪避).toBe(50);
      bonus.consumeReverseFairytaleBuffs(attrs, []);
      expect(attrs.闪避).toBe(50);
    });
  });

  describe('反转童话 触发端（战斗相关.ecode L378-440）', () => {
    const buildCombat = () => {
      const staticData = new StaticDataService();
      const playerService = new PlayerService({} as any, staticData, {} as any);
      const mapService = new MapService({} as any, staticData, {} as any, {} as any, { emit: jest.fn() } as any);
      const achievementService = new AchievementService({} as any, {} as any, staticData);
      const combatSystem = new (require('../src/modules/game/combat-system.service').CombatSystemService)(
        {} as any, playerService, new BonusService(), mapService, staticData,
        achievementService, {} as any, new CombatStateService(), {} as any,
      );
      return { combatSystem };
    };

    it('几率必中时随机获得 fzth1-fzth10 并输出类别文本', () => {
      const { combatSystem } = buildCombat();
      const target: any = { buffs: '[]', markers: '{}', bonus: '{}', armor: 100, shield: 50 };
      const text = (combatSystem as any).applyReverseFairytale(
        { equipment: '[]', qqNumber: '42' }, target, 100,
      );
      expect(text).toMatch(/（反转:(盾抗|甲抗|血抗|闪避|装甲|护盾|回复|暴击|命中|伤害)）/);
      const buffs = parseJson(target.buffs, []);
      expect(buffs.length).toBe(1);
      expect(buffs[0].name).toMatch(/^fzth(10|[1-9])$/);
      // 持续 600 秒（无库洛牌）
      expect(buffs[0].expireAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 500);
    });

    it('几率失败输出（反转:失败）且不给目标加增益', () => {
      const { combatSystem } = buildCombat();
      const target: any = { buffs: '[]', markers: '{}', bonus: '{}' };
      const text = (combatSystem as any).applyReverseFairytale({ equipment: '[]' }, target, 0);
      expect(text).toBe('（反转:失败）');
      expect(parseJson(target.buffs, [])).toEqual([]);
    });

    it('已有同名 fzth 增益时重复获得则移除（原版 L389-391）', () => {
      const { combatSystem } = buildCombat();
      const target: any = {
        buffs: JSON.stringify([{ name: 'fzth3', expireAt: 9999999999 }]),
        markers: '{}',
        bonus: '{}',
      };
      // 固定 a=3：多次尝试直至命中 fzth3 或确认移除逻辑（几率100%）
      let removed = false;
      for (let i = 0; i < 200 && !removed; i++) {
        (combatSystem as any).applyReverseFairytale({ equipment: '[]', qqNumber: '42' }, target, 100);
        const names = parseJson(target.buffs, []).map((b: any) => b.name);
        if (!names.includes('fzth3')) removed = true;
      }
      expect(removed).toBe(true);
    });

    it('a==5 时立即反转目标属性装甲并把正当前值同步翻负计入成就（原版 L393-409）', () => {
      const { combatSystem } = buildCombat();
      // 多次触发直到抽到 a=5（几率100%，期望≤几十次）
      for (let i = 0; i < 500; i++) {
        const target: any = { buffs: '[]', markers: '{}', bonus: '{"装甲":80}', armor: 60, shield: 0 };
        const text = (combatSystem as any).applyReverseFairytale(
          { equipment: '[]', qqNumber: '42' }, target, 100,
        );
        if (text === '（反转:装甲）') {
          const bonusObj = parseJson(target.bonus, {});
          expect(bonusObj.装甲).toBe(-80);
          expect(target.armor).toBe(-60);
          const markers = parseJson(target.markers, {});
          expect(markers['攻击者42']).toBe(120); // 当前装甲60×2
          return;
        }
      }
      throw new Error('500 次内未抽到 a==5');
    });
  });

  describe('贯穿抵抗 词条映射（物品操作.ecode 数据直存 @Struct L119-120）', () => {
    const staticData = new StaticDataService();
    const service = new ItemSystemService(
      {} as any,
      {} as any,
      {} as any,
      new ItemService({} as any, staticData, {} as any, {} as any, {} as any),
      {} as any,
      staticData,
    );

    it('变体拼写"贯穿抵抗"统一归一到 BonusData.抗贯穿', () => {
      const map = (ItemSystemService as any).AFFIX_TO_BONUS;
      expect(map['贯穿抵抗']).toBe('抗贯穿');
      expect(map['抗贯穿']).toBe('抗贯穿');
    });
  });
});
