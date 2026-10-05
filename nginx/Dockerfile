# Build the Vue client, then serve it with nginx (which also proxies /api).
FROM node:26-bookworm-slim AS build
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build
# One .gz beside every compressible asset, so nginx serves the compressed
# bytes (gzip_static in cache.conf) rather than compressing the same hashed
# file for every request. Fonts are left alone: woff2 is already compressed.
RUN find dist/assets -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.wasm' -o -name '*.json' \) \
    -exec gzip -k -9 {} +

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
# The API upstream is an `upstream` block, which also only exists at the http
# level, so it rides in conf.d the same way and survives the TLS override.
COPY nginx/upstream.conf /etc/nginx/conf.d/01-upstream.conf
COPY nginx/csp-headers.conf /etc/nginx/snippets/csp-headers.conf
COPY --from=build /client/dist /usr/share/nginx/html
