#!/bin/bash
set -eu

# Bootstrap options are a pair: Keycloak rejects a username without a password.
# After provisioning, omit both options instead of passing an empty password.
if [[ -z "${KC_BOOTSTRAP_ADMIN_PASSWORD:-}" ]]; then
  unset KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD
fi
exec /opt/keycloak/bin/kc.sh "$@"
