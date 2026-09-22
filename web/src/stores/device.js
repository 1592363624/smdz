/**
 * 设备与视口状态（Pinia）
 *
 * 全站唯一的「现在是不是手机」真相源。此前只有 ChatView 内部一个局部的
 * isMobileViewport()（matchMedia 读一次，不响应变化），其它页面各自用
 * @media 硬撑，导致底栏/HUD 这类跨路由常驻元素无处判断该不该渲染。
 *
 * 职责：
 * 1. 断点：isMobile(≤768) / isPhone(≤480)，用 matchMedia 监听，旋转与分屏都实时生效；
 * 2. 触控：isTouch（pointer: coarse 且 hover: none），手感增强只给真触屏，不动桌面端；
 * 3. 可视高度：把 visualViewport 的真实高度写进 --vvh，并据此判定键盘是否弹起
 *    （手机端键盘会顶掉近半个屏幕，靠 CSS 猜不出来）；
 * 4. 独立运行：display-mode: standalone（加到主屏后全屏无浏览器地址栏）。
 *
 * 注意：SSR/无 DOM 环境不初始化；App.vue 里 init() 只调用一次。
 */
import { defineStore } from 'pinia';

/** 手机端断点：与 styles.css 里 @media (max-width: 768px) 保持一致 */
const MOBILE_MQ = '(max-width: 768px)';
/** 小屏手机断点：与 @media (max-width: 480px) 保持一致 */
const PHONE_MQ = '(max-width: 480px)';
/** 触屏判定：粗指针 + 不支持悬停（桌面带触屏显示器不会命中） */
const TOUCH_MQ = '(pointer: coarse) and (hover: none)';
/** 横屏 */
const LANDSCAPE_MQ = '(orientation: landscape)';
/** 独立运行（PWA 加到主屏 / 全屏 WebView） */
const STANDALONE_MQ = '(display-mode: standalone)';

/** 键盘顶起的最小高度差（px）：低于此值当作地址栏收展，不算键盘 */
const KEYBOARD_MIN_SHRINK = 140;

export const useDeviceStore = defineStore('device', {
  state: () => ({
    /** 是否手机端布局（≤768px） */
    isMobile: false,
    /** 是否小屏手机（≤480px） */
    isPhone: false,
    /** 是否真触屏（无悬停能力） */
    isTouch: false,
    /** 是否横屏 */
    isLandscape: false,
    /** 是否独立运行（已加到主屏幕） */
    standalone: false,
    /** 虚拟键盘是否弹起 */
    keyboardOpen: false,
    /** visualViewport 实测高度（px）；无 vv 时回落到 innerHeight */
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
    /** 已初始化标记，避免重复挂监听 */
    _inited: false,
    /** matchMedia 监听器句柄（teardown 用） */
    _mqls: [],
  }),
  getters: {
    /** 该不该显示手机外壳（顶部 HUD + 底部标签栏）：手机布局且不在键盘顶起的全屏输入态 */
    hasShell: (s) => s.isMobile,
  },
  actions: {
    /** 挂载监听；幂等 */
    init() {
      if (this._inited || typeof window === 'undefined') return;
      this._inited = true;
      const watches = [
        [MOBILE_MQ, 'isMobile'],
        [PHONE_MQ, 'isPhone'],
        [TOUCH_MQ, 'isTouch'],
        [LANDSCAPE_MQ, 'isLandscape'],
        [STANDALONE_MQ, 'standalone'],
      ];
      watches.forEach(([mq, key]) => {
        const mql = window.matchMedia(mq);
        const apply = () => { this[key] = mql.matches; };
        apply();
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', apply);
        else mql.addListener?.(apply); // 老 Safari 兜底
        this._mqls.push({ mql, apply });
      });
      this._measureViewport();
      window.addEventListener('resize', this._onViewportChange, { passive: true });
      const vv = window.visualViewport;
      if (vv) vv.addEventListener('resize', this._onViewportChange, { passive: true });
      // 从主屏切回时键盘高度可能残留，重新量一次
      document.addEventListener('visibilitychange', this._onViewportChange);
    },
    teardown() {
      if (typeof window === 'undefined') return;
      this._mqls.forEach(({ mql, apply }) => mql.removeEventListener?.('change', apply));
      this._mqls = [];
      window.removeEventListener('resize', this._onViewportChange);
      window.visualViewport?.removeEventListener('resize', this._onViewportChange);
      document.removeEventListener('visibilitychange', this._onViewportChange);
      this._inited = false;
    },
    _onViewportChange() {
      // 先同步量一次：后台标签页里 requestAnimationFrame 根本不触发，
      // 只等下一帧会让 --vvh 停在旧高度，键盘/旋转后整条底部操作栏被顶出屏幕。
      this._measureViewport();
      // 再补一帧：部分安卓浏览器要等布局稳定后 visualViewport 才反映键盘高度
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => this._measureViewport());
      }
    },
    /**
     * 量可视高度并写入 --vvh / --kb-open。
     * --vvh 供各页面用 height: calc(var(--vvh) * 1px) 取代 100vh —— iOS Safari 的 100vh
     * 含被地址栏遮住的部分，会把底部操作条顶出屏幕。
     */
    _measureViewport() {
      const vv = window.visualViewport;
      const h = Math.round(vv?.height || window.innerHeight || 0);
      const full = window.innerHeight || h;
      this.viewportHeight = h;
      const root = document.documentElement;
      root.style.setProperty('--vvh', h + 'px');
      // 键盘判定：可视高度比布局视口矮一大截，才算键盘顶起（地址栏收展只有几十 px）
      const shrunk = full - h >= KEYBOARD_MIN_SHRINK;
      if (shrunk !== this.keyboardOpen) {
        this.keyboardOpen = shrunk;
        document.body.classList.toggle('kb-open', shrunk);
      }
    },
  },
});
