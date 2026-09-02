FROM docker.io/apitable/backend-server@sha256:8dbb0f2bee6c2d572b1e93f7de246bc07a723cd620d5bb15f6e8265561582258

LABEL org.opencontainers.image.title="APITable community collaboration backend"
LABEL org.opencontainers.image.version="v1.13.0-beta.1-ce-collaboration.3"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.source="https://github.com/apitable/apitable/tree/v1.13.0-beta.1"

COPY src/SelfHostedSubscriptionFeature.java /tmp/src/com/apitable/interfaces/billing/model/SelfHostedSubscriptionFeature.java
COPY src/DefaultEntitlementServiceFacadeImpl.java /tmp/src/com/apitable/interfaces/billing/facade/DefaultEntitlementServiceFacadeImpl.java
COPY src/SubscribeAssembler.java /tmp/src/com/apitable/space/assembler/SubscribeAssembler.java
COPY src/CommunityNodeRoleController.java /tmp/src/com/apitable/workspace/controller/CommunityNodeRoleController.java

RUN set -eu; \
    mkdir -p /tmp/classes; \
    cd /tmp/classes; \
    jar xf /app/app.jar BOOT-INF/classes BOOT-INF/lib; \
    javac \
      -classpath '/tmp/classes/BOOT-INF/classes:/tmp/classes/BOOT-INF/lib/*' \
      -d /tmp/classes/BOOT-INF/classes \
      /tmp/src/com/apitable/interfaces/billing/model/SelfHostedSubscriptionFeature.java \
      /tmp/src/com/apitable/interfaces/billing/facade/DefaultEntitlementServiceFacadeImpl.java \
      /tmp/src/com/apitable/space/assembler/SubscribeAssembler.java \
      /tmp/src/com/apitable/workspace/controller/CommunityNodeRoleController.java; \
    jar uf /app/app.jar \
      -C /tmp/classes \
      BOOT-INF/classes/com/apitable/interfaces/billing/model/SelfHostedSubscriptionFeature.class \
      BOOT-INF/classes/com/apitable/interfaces/billing/facade/DefaultEntitlementServiceFacadeImpl.class \
      BOOT-INF/classes/com/apitable/space/assembler/SubscribeAssembler.class \
      BOOT-INF/classes/com/apitable/workspace/controller/CommunityNodeRoleController.class \
      BOOT-INF/classes/com/apitable/workspace/controller/CommunityNodeRoleController\$RequestContext.class; \
    rm -r /tmp/classes /tmp/src
