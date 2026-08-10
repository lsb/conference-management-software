# Deployment, kept as boring as the app.
#
# There is no build step and there are no dependencies, so this copies source
# and runs it. `npm ci` would fail on a project with no lockfile and nothing to
# install; that absence is the point, not an oversight.
#
# The database migrates itself on open (src/db.js), so there is no release
# command, no entrypoint script, and nothing to remember to run first. Starting
# the container is the whole deployment.

FROM node:22-alpine

# Not root. The only thing worth writing to is the data volume, and it is
# chowned below.
RUN addgroup -S conf && adduser -S conf -G conf

WORKDIR /app

# Source only. No node_modules, because there are none.
COPY --chown=conf:conf package.json ./
COPY --chown=conf:conf bin ./bin
COPY --chown=conf:conf src ./src

# The SQLite file and uploaded files live here, and both have to survive a
# restart. Mount a volume over it. Without one the conference is a scratch pad:
# the app will run, and the first redeploy will erase every submission.
RUN mkdir -p /app/data/uploads && chown -R conf:conf /app/data
VOLUME ["/app/data"]

USER conf

# HOST is 0.0.0.0 because the container's own loopback reaches nobody. This is
# no longer a security decision -- authorization is a database fact and does not
# consult the interface (see docs/DECISIONS.md, D12).
ENV HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080

# Cold start has to stay under 30 seconds (D11). It is currently well under one:
# no build, no dependency resolution, and the migration is a handful of DDL
# statements against a file that is already migrated.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
