FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm

# Copy website package
COPY frontend/packages/website/package.json ./

# Install dependencies
RUN pnpm install

# Copy website source
COPY frontend/packages/website/ .

# Build
RUN pnpm build

FROM caddy:alpine
COPY --from=build /app/dist /srv
RUN cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	root * /srv
	file_server
	try_files {path} /index.html
}
EOF
EXPOSE 80
