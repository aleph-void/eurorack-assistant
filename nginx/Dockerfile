# Build the Vue client, then serve it with nginx (which also proxies /api).
FROM node:20-bookworm-slim AS build
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /client/dist /usr/share/nginx/html
