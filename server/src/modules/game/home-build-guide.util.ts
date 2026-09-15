/**
 * 家园建造流程引导（圈地 → 开挖地基 → 建造地基 → 建造房子）
 *
 * 背景：家园在「家园进度 = 4（建成）」之前会拦截家园产出结算、家园前线、
 * 屋内野战、地牢挑战等玩法，但原版只有一句纯文本提示，玩家很容易卡在中间
 * 步骤（实测出现过「房子都盖好了，页面还显示建造进度 0/4」的疑问）。
 *
 * 方案：在四条建造指令的回包**末尾追加**一段格式固定的进度文本，一份内容两端通用：
 * - QQ / AstrBot：纯文本即可读（① ② ③ ④ 进度链 + 下一步指令）；
 * - 网页端：`web/src/components/HomeBuildGuide.vue` 识别同一段文本后渲染成
 *   带动画的四步引导卡片，并提供「打开家园」「发送下一步指令」按钮。
 *
 * 约定：
 * - 只追加文本，**不改任何写入口、不新增接口**，写操作仍只有指令通道一条路径；
 * - 步骤名、材料提示、下一条指令集中在本文件，改文案不需要动业务 service；
 * - 文本以 `HOME_BUILD_GUIDE_HEADER` 开头，是网页端识别卡片的唯一依据，
 *   修改前缀时必须同步 `web/src/config.js` 的 `HOME_BUILD_GUIDE_CONFIG.headerRegex`。
 */

/** 单步引导定义 */
export interface HomeBuildStepDef {
  /** 执行完该步后的 `家园进度` 值：1=已圈地 2=已开挖 3=地基开工 4=房子开工 */
  step: number;
  /** 步骤名（与原版指令同名，便于玩家对照指令列表） */
  name: string;
  /** 该步完成后玩家要发送的下一条指令；最后一步为空（只需等待完工） */
  command: string;
  /** 该步的前置条件 / 材料提示 */
  tip: string;
}

/** 引导文本头（网页端识别卡片的依据，改动需同步前端 config） */
export const HOME_BUILD_GUIDE_HEADER = '\u{1F3D7}\u{FE0F} 家园建造进度';

/** 建造总步数：进度值达到该数即视为建成 */
export const HOME_BUILD_TOTAL_STEP = 4;

/**
 * 四步流程定义：步骤名与原版指令一致，tip 对齐原版材料要求
 * （建造地基 80木头/120石头/40铁矿/40绳子，建造房子 300木头/500石头/160铁矿/120绳子）。
 */
export const HOME_BUILD_STEPS: readonly HomeBuildStepDef[] = [
  {
    step: 1,
    name: '圈地',
    command: '开挖地基',
    tip: '清理院子里的土堆和杂草（「挖土」「割草」）',
  },
  {
    step: 2,
    name: '开挖地基',
    command: '建造地基',
    tip: '挖掉新出现的土堆，备好 80木头、120石头、40铁矿、40绳子',
  },
  {
    step: 3,
    name: '建造地基',
    command: '建造房子',
    tip: '备好 300木头、500石头、160铁矿、120绳子',
  },
  {
    step: 4,
    name: '建造房子',
    command: '',
    tip: '房子正在建造，2 分钟后完工',
  },
];

/**
 * 按步渲染进度链（纯文本形态，QQ 端直接可读）：
 * 已完成 → ✅，当前步 → ⏳，未开始 → 只显示序号。
 *
 * @param currentStep 已完成到的步数（1-4）
 * @returns 形如 `① 圈地 ✅　② 开挖地基 ⏳　③ 建造地基　④ 建造房子`
 */
export function renderHomeBuildChain(currentStep: number): string {
  const marks = ['①', '②', '③', '④'];
  return HOME_BUILD_STEPS.map((def, index) => {
    const mark = marks[index] ?? `${index + 1}.`;
    const label = `${mark} ${def.name}`;
    if (def.step < currentStep) return `${label} ✅`;
    if (def.step === currentStep) return `${label} ⏳`;
    return label;
  }).join('　');
}

/**
 * 生成完整的家园建造引导文本块（三行：进度头 / 进度链 / 下一步）。
 *
 * @param step 执行完当前指令后的 `家园进度` 值（1-4）
 * @returns 引导文本块；不在 1-4 范围内时返回空串
 */
export function renderHomeBuildGuide(step: number): string {
  const current = HOME_BUILD_STEPS.find((def) => def.step === step);
  if (!current) return '';
  const lines: string[] = [
    `${HOME_BUILD_GUIDE_HEADER} ${step}/${HOME_BUILD_TOTAL_STEP} · ${current.name}`,
    renderHomeBuildChain(step),
  ];
  // 最后一步没有下一条指令，只提示等待完工
  lines.push(
    current.command
      ? `👉 下一步：${current.tip} → 发送「${current.command}」`
      : `👉 正在进行：${current.tip}`,
  );
  return lines.join('\n');
}

/**
 * 在指令回包正文后追加家园建造引导块。
 *
 * @param text 指令原本的返回文本
 * @param step 执行完该指令后的 `家园进度` 值（1-4）
 * @returns 追加引导后的文本；step 非法或正文为空时原样返回
 */
export function appendHomeBuildGuide(text: string, step: number): string {
  if (!text) return text;
  const guide = renderHomeBuildGuide(step);
  if (!guide) return text;
  return `${text}\n━━━━━━━━━━━━━━━\n${guide}`;
}
