import { defineConfig } from 'vite';

// Repo is served at https://aecao.github.io/roosevelt-networks/, so assets
// must be requested with that base path in production.
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/roosevelt-networks/' : '/',
});
