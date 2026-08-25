# Build the Vue client, then serve it with nginx (which also proxies /api).
FROM node:26-bookworm-slim AS build
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM nginx:1.31-alpine
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
# Included by both vhosts, so it has to be in the image even when the TLS
# override mounts its own template over the config above.
COPY nginx/cache.conf /etc/nginx/snippets/cache.conf
# The policy itself is a `map`, which only exists at the http level: conf.d is
# included there, and survives the TLS override (which replaces default.conf
# alone). The add_header lines that carry it go in snippets/, because they are
# included per location.
COPY nginx/csp.conf /etc/nginx/conf.d/00-csp.conf
COPY nginx/csp-headers.conf /etc/nginx/snippets/csp-headers.conf
COPY --from=build /client/dist /usr/share/nginx/html
