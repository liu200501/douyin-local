import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/grid' },
  { path: '/feed', name: 'feed', component: () => import('@/views/FeedView.vue'), meta: { fullscreen: true } },
  { path: '/grid', name: 'grid', component: () => import('@/views/GridView.vue') },
  { path: '/watch/:id', name: 'watch', component: () => import('@/views/WatchView.vue'), meta: { fullscreen: true } },
  { path: '/collections', name: 'collections', component: () => import('@/views/CollectionsView.vue') },
  {
    path: '/collections/:name',
    name: 'collection',
    component: () => import('@/views/GridView.vue'),
    props: (route: any) => ({ collection: route.params.name }),
  },
  { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
  { path: '/favorites', name: 'favorites', component: () => import('@/views/FavoritesView.vue') },
  { path: '/history', name: 'history', component: () => import('@/views/HistoryView.vue') },
  { path: '/admin', name: 'admin', component: () => import('@/views/AdminView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/grid' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
