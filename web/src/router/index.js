/**
 * 前端路由
 * /login 登录注册页
 * /chat  公屏聊天页(需登录)
 */
import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../views/LoginView.vue';
import ChatView from '../views/ChatView.vue';
import AdminView from '../views/AdminView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/chat', name: 'chat', component: ChatView, meta: { requiresAuth: true } },
    { path: '/admin', name: 'admin', component: AdminView, meta: { requiresAuth: true, requiresAdmin: true } },
  ],
});

// 全局路由守卫：未登录跳转登录页
router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (to.meta.requiresAuth && !token) {
    return { name: 'login' };
  }
  if (to.name === 'login' && token) {
    return { name: 'chat' };
  }
  return true;
});

export default router;
