ARG NODE_VERSION=lts-alpine
ARG NGINX_VERSION=alpine

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

FROM nginx:alpine

# Install rsync for file operations (optional, can use cp)
RUN apk add --no-cache rsync

# Create output directory
RUN mkdir -p /usr/share/nginx/html/hydrus-web

# Copy in nginx config
COPY nginx/default.conf /etc/nginx/conf.d/

# Copy in the built Angular app from the build stage
COPY --from=builder /app/dist/hydrus-web /usr/share/nginx/html/hydrus-web

# Note: The default NGINX container now listens on port 8080 instead of 80 
EXPOSE 8080

# Start Nginx directly with custom config
ENTRYPOINT ["nginx", "-c", "/etc/nginx/nginx.conf"]
CMD ["nginx", "-g", "daemon off;"]