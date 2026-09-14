FROM quay.io/keycloak/keycloak:26.7.3 AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.3
COPY --from=build /opt/keycloak/ /opt/keycloak/
COPY --chown=1000:0 mailmcp-realm.json /opt/keycloak/data/import/mailmcp-realm.json
USER 1000:0
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
