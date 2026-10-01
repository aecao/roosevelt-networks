import { defineConfig } from 'vite';

// Served at https://imadeitfor.you/app/roosevelt-networks/ (portfolio repo),
// so assets must be requested with that base path in production.
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/app/roosevelt-networks/' : '/',
});
