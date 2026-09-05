import { GameService } from '../src/modules/game/game.service';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';

function parseJson(value: any, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

const SETTINGS_MENU = '1@设置指引#2@设置随机#3@设置采集#4@设置活力#5@设置不扶#6@设置音乐#7@设置倍率#8@设置购物';
const PET_OPS_MENU = '1@宠物改名#2@宠物转让#3@全部跟随#4@全部停下#5@全部被动#6@全部主动#7@大召唤术#8@救助全部#9@全部挤奶#10@宠物驾驶#11@呼叫#12@宠物装备#13@宠物觉醒#14@宠物前往#15@宠物攻击#16@宠物喂食#17@宠物嗅探';

describe('菜单链：设置/宠物操作 编号临时输入替换（原版 L5199/L8025 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeGameService() {
    const service: any = Object.create(GameService.prototype);
    const tempInput: string[] = [];
    const player = {
      id: 1, userId: 42, name: '冒险者', mapId: 7,
      markers: JSON.stringify({ 指引: 0, 自动战斗: 1, 自动采集: 0, 使用活力: 0, 不扶: 1, bgm: 0, bl: 0, 自动购物: '工业、窝' }),
      markers2: '[]',
    };
    service.playerService = {
      getPlayerData: jest.fn(async () => ({ player, markers: parseJson(player.markers, {}), markers2: [] })),
      getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
      savePlayer: jest.fn(async () => undefined),
    };
    service.shortcutService = {
      setTempInput: jest.fn(async (_uid: number, value: string) => {
        tempInput.push(value);
      }),
    };
    service.logger = { log: jest.fn(), warn: jest.fn() };
    return { service, tempInput, player };
  }

  it('设置无参：输出八项状态并生成 1@设置指引…8@设置购物 临时输入替换', async () => {
    const { service, tempInput } = makeGameService();

    const result = await service.handleSettings(42);

    expect(result).toContain('1、新手指引：开');
    expect(result).toContain('8、自动购物：工业、窝');
    expect(tempInput).toEqual([SETTINGS_MENU]);
  });

  function makeFamiliarSystem() {
    const service: any = Object.create(FamiliarSystemService.prototype);
    const tempInput: string[] = [];
    const player = { id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]' };
    service.playerService = {
      getPlayerData: jest.fn(async () => ({ player, markers: {}, markers2: [] })),
      savePlayer: jest.fn(async () => undefined),
    };
    service.shortcutService = {
      setTempInput: jest.fn(async (_uid: number, value: string) => {
        tempInput.push(value);
      }),
    };
    service.logger = { log: jest.fn(), warn: jest.fn() };
    return { service, tempInput };
  }

  it('宠物操作：生成 17 项编号临时输入替换并恢复原版完整帮助长文', async () => {
    const { service, tempInput } = makeFamiliarSystem();

    const result = await service.handlePet(42, '操作');

    expect(tempInput).toEqual([PET_OPS_MENU]);
    // 编号直达项与临时替换一一对应
    expect(result).toContain('17. 宠物嗅探');
    // 原版 L8026 帮助长文恢复（此前被删减为4行）
    expect(result).toContain('宠物自主行为(仅当前地图):');
    expect(result).toContain('◆互动:触发几率【好感-100】%');
    expect(result).toContain('◆搜索:触发几率【(好感-100)÷4】%');
    expect(result).toContain('当宠物好感超过200时，会额外获得一件装备，并且优先触发搜索');
    expect(result).toContain('宠物嗅探可以让狩猎类宠物在当前地图寻找怪物');
  });

  it('宠物操作无子命令同样走菜单链', async () => {
    const { service, tempInput } = makeFamiliarSystem();

    await service.handlePet(42, '');

    expect(tempInput).toEqual([PET_OPS_MENU]);
  });
});
