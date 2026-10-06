import { defineConfig } from 'vite';

// The documentation pages are static files in public/<page>/index.html. Production hosting
// serves each folder's index.html, but the Vite dev server would fall back to the app's
// index.html, so rewrite those paths during development.
const DOC_PAGES = ['tutorial', 'methodology', 'custom'];
const serveDocumentationIndex = {
  name: 'serve-documentation-index',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path, query] = req.url.split('?');
      const page = path.replace(/^\/|\/$/g, '');
      if (DOC_PAGES.includes(page)) {
        req.url = `/${page}/index.html${query ? `?${query}` : ''}`;
      }
      next();
    });
  },
};

// Served at https://imadeitfor.you/app/roosevelt-networks/ (portfolio repo),
// so assets must be requested with that base path in production.
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/app/roosevelt-networks/' : '/',
  plugins: [serveDocumentationIndex],
});
