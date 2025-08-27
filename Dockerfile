ARG NODE_VERSION=lts-alpine
# ARG NGINX_VERSION=1.28.0

# Build the client files in a build stage
FROM node:${NODE_VERSION} AS builder

#
RUN apk add --no-cache git

# Set the working directory inside the container
WORKDIR /app

# Copy package-related files first
COPY  package.json package-lock.json .npmrc ./

# Install project dependencies using npm ci (ensures a clean, reproducible install)
RUN --mount=type=cache,target=/root/.npm npm ci

# Copy the rest of the application source code into the container
COPY . .

# Build the Angular application
RUN npm run build

FROM alpine:latest AS output

# Install rsync for file operations (optional, can use cp)
RUN apk add --no-cache rsync

# Create output directory
RUN mkdir -p /usr/share/nginx/html

COPY --from=builder /app/dist/hydrus-web /usr/share/nginx/html

VOLUME [ "/usr/share/nginx/html" ]

EXPOSE 8000