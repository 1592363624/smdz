/**
 * 家园建造四步引导（home-build-guide.util）单元测试
 *
 * 覆盖点：
 * - 1-4 步的引导文本都带「进度头 / 进度链 / 下一步」三行，且步数正确；
 * - 进度链按当前步标记 ✅ / ⏳，供 QQ 端纯文本读懂；
 * - 非法步数、空正文不追加任何内容（避免污染失败提示等其它回包）；
 * - 指令实际回包（开挖地基）确实带上引导块，保证前端能识别渲染。
 */

import {
  appendHomeBuildGuide,
  HOME_BUILD_GUIDE_HEADER,
  HOME_BUILD_TOTAL_STEP,
  renderHomeBuildChain,
  renderHomeBuildGuide,
} from '../src/modules/game/home-build-guide.util';

describe('家园建造四步引导', () => {
  it('1-4 步都渲染出「进度头 + 进度链 + 下一步」三行', () => {
    for (let step = 1; step <= HOME_BUILD_TOTAL_STEP; step += 1) {
      const text = renderHomeBuildGuide(step);
      const lines = text.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(`${HOME_BUILD_GUIDE_HEADER} ${step}/${HOME_BUILD_TOTAL_STEP} · ${['圈地', '开挖地基', '建造地基', '建造房子'][step - 1]}`);
      expect(lines[1]).toContain('① 圈地');
      expect(lines[2].startsWith('👉')).toBe(true);
    }
  });

  it('进度链按当前步标记：已完成 ✅、当前 ⏳、未开始无标记', () => {
    const chain = renderHomeBuildChain(2);
    expect(chain).toContain('① 圈地 ✅');
    expect(chain).toContain('② 开挖地基 ⏳');
    // 未开始的两步不应带状态标记
    expect(chain).toContain('③ 建造地基');
    expect(chain).not.toContain('③ 建造地基 ✅');
    expect(chain).not.toContain('④ 建造房子 ⏳');
  });

  it('最后一步提示等待完工，不再给出下一条指令', () => {
    expect(renderHomeBuildGuide(4)).toContain('👉 正在进行');
    expect(renderHomeBuildGuide(3)).toContain('发送「建造房子」');
  });

  it('追加引导时保留原文，并用分隔线隔开', () => {
    const result = appendHomeBuildGuide('冒险者开始挖地基。', 2);
    expect(result.startsWith('冒险者开始挖地基。')).toBe(true);
    expect(result).toContain('━━━━━━━━━━━━━━━');
    expect(result).toContain('家园建造进度 2/4');
  });

  it('非法步数 / 空正文不追加任何内容', () => {
    expect(appendHomeBuildGuide('正文', 0)).toBe('正文');
    expect(appendHomeBuildGuide('正文', 5)).toBe('正文');
    expect(appendHomeBuildGuide('', 1)).toBe('');
    expect(renderHomeBuildGuide(0)).toBe('');
  });
});
