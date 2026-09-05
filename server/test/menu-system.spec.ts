import { GameService } from '../src/modules/game/game.service';

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

function makeService() {
  const service: any = Object.create(GameService.prototype);
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
  return { service, tempInput, player };
}

describe('菜单体系（原版 接口1.ecode L325-355 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('菜单：生成游戏菜单/功能菜单两层入口', async () => {
    const { service, tempInput } = makeService();

    const result = await service.handleMenu(42);

    expect(result).toContain('游戏菜单');
    expect(result).toContain('功能菜单');
    expect(tempInput).toEqual(['1@游戏菜单#2@功能菜单']);
  });

  it('功能菜单：7 项临时输入替换（子项映射到新版指令）', async () => {
    const { service, tempInput } = makeService();

    const result = await service.handleFunctionMenu(42);

    expect(result).toContain('1、分赃');
    expect(result).toContain('7、管理菜单');
    expect(tempInput).toEqual(['1@分赃#2@计算#3@生产配平#4@分赃2#5@快捷 查看#6@制造助手#7@管理']);
  });

  it('游戏菜单：5 项临时输入替换', async () => {
    const { service, tempInput } = makeService();

    const result = await service.handleGameMenu(42);

    expect(result).toContain('1、使魔大战');
    expect(result).toContain('5、快捷输入');
    expect(tempInput).toEqual(['1@使魔大战#2@几率测试#3@数据刷新#4@重新读取数据#5@快捷 查看']);
  });

  it('计算：四则/乘方/三角函数求值，并保留原版回复格式', async () => {
    const { service } = makeService();

    expect(await service.handleCalculate(42, '1+1')).toBe('计算1+1:\n2');
    expect(await service.handleCalculate(42, 'x*2+1', )).toContain('错误'); // 空参在先，此处 '*' 开头非法
    expect(await service.handleCalculate(42, '2^10')).toBe('计算2^10:\n1024');
    expect(await service.handleCalculate(42, 'sin(0)')).toBe('计算sin(0):\n0');
    expect(await service.handleCalculate(42, '(2+3)*4')).toBe('计算(2+3)*4:\n20');
    expect(await service.handleCalculate(42, '1、2')).toBe('计算1/2:\n0.5');
  });

  it('计算：空参返回用法提示，非法字符与无括号三角函数报错', async () => {
    const { service } = makeService();

    expect(await service.handleCalculate(42, '')).toContain('输入算式进行计算');
    const bad = await service.handleCalculate(42, '1+abc');
    expect(bad).toContain('错误');
    expect(await service.handleCalculate(42, 'sin30')).toContain('三角函数需要括号');
  });

  it('数据刷新/重新读取数据/确认重新读取数据：三层链路', async () => {
    const { service, tempInput, player } = makeService();

    expect(await service.handleRefreshData(42)).toBe('已刷新。');
    const reload = await service.handleReloadData(42);
    expect(reload).toContain('确定要重新读取数据吗');
    expect(tempInput).toEqual(['a@确认重新读取数据']);
    const confirm = await service.handleConfirmReloadData(42);
    expect(confirm).toBe('冒险者已经重新读取了你的存档数据');
    expect(parseJson(player.markers, {})).toEqual({});
  });
});
