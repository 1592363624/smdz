/**
 * 系统公告富文本渲染组件（函数式组件）
 *
 * 输入公告原文（Markdown 子集，见 utils/annRich.js），
 * 通过 h() 渲染结构化 VNode：
 * - 不经过 v-html / innerHTML，天然免疫 XSS
 * - 链接新窗口打开（rel=noopener）；非白名单协议的链接降级为纯文本并提示
 * - 图片懒加载，点击触发 image-click 事件（供父级做放大预览）
 *
 * 用法：<AnnRichText :content="text" @image-click="onZoom" />
 */
import { h, computed } from 'vue';
import { parseAnnouncement } from '../utils/annRich';

export default {
  name: 'AnnRichText',
  props: {
    content: { type: String, default: '' },
  },
  emits: ['image-click'],
  setup(props, { emit }) {
    const blocks = computed(() => parseAnnouncement(props.content));

    /** 递归渲染行内 token 流 */
    function renderInline(tokens) {
      return tokens.map((tk, i) => {
        switch (tk.t) {
          case 'text':
            return tk.text;
          case 'link':
            return tk.safe
              ? h(
                  'a',
                  { href: tk.href, target: '_blank', rel: 'noopener noreferrer', class: 'ann-link' },
                  tk.text,
                )
              : h('span', { class: 'ann-link-unsafe', title: '该链接协议不受支持，未转为超链接' }, tk.text);
          case 'img':
            return tk.safe
              ? h('img', {
                  src: tk.src,
                  alt: tk.alt || '公告配图',
                  class: 'ann-img',
                  loading: 'lazy',
                  style: { cursor: 'zoom-in' },
                  onClick: () => emit('image-click', { src: tk.src, alt: tk.alt }),
                })
              : h('span', { class: 'ann-link-unsafe', title: '该图片地址协议不受支持' }, `[图片：${tk.alt || tk.src}]`);
          case 'code':
            return h('code', null, tk.text);
          case 'bold':
            return h('strong', null, renderInline(tk.children));
          case 'italic':
            return h('em', null, renderInline(tk.children));
          case 'strike':
            return h('del', null, renderInline(tk.children));
          default:
            return null;
        }
      });
    }

    return () =>
      h(
        'div',
        { class: 'ann-rich' },
        blocks.value.map((b, i) => h('p', { key: i }, renderInline(b.children))),
      );
  },
};
