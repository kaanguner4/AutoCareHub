# AutoCare Türkiye web app + API. Build context: repo root (see .dockerignore).
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

ENV NODE_ENV=production
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
# Front-end packages are served from node_modules (see VENDOR in src/app.js); drop the parts never served.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && rm -rf node_modules/@fortawesome/fontawesome-free/js node_modules/@fortawesome/fontawesome-free/svgs \
           node_modules/@fortawesome/fontawesome-free/sprites node_modules/@fortawesome/fontawesome-free/scss \
           node_modules/@fortawesome/fontawesome-free/less node_modules/@fortawesome/fontawesome-free/metadata \
           node_modules/bootstrap/scss node_modules/bootstrap/js node_modules/bootstrap/site

COPY backend/src ./src
COPY index.html register.html dashboard.html appointment.html admin.html main.js admin.js style.css admin.css hero.svg ./public/

USER node
ENV PORT=3000 STATIC_DIR=/app/public
EXPOSE 3000
CMD ["node", "src/server.js"]
