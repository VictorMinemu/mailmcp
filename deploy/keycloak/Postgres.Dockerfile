FROM postgres:18-alpine
# Run directly as postgres. The root-only privilege-switch helper is unnecessary.
RUN apk upgrade --no-cache && rm /usr/local/bin/gosu
USER postgres
