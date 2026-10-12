ARG BASE_IMAGE=docker.io/apitable/backend-server@sha256:8dbb0f2bee6c2d572b1e93f7de246bc07a723cd620d5bb15f6e8265561582258
FROM ${BASE_IMAGE} AS verified

COPY src/ /tmp/src/
COPY tests/ /tmp/tests-src/

# Compile against the exact upstream runtime and require the behavior tests before
# producing a release jar. No production database or Redis is used by these tests.
RUN set -eu; \
    mkdir -p /tmp/classes /tmp/patch/BOOT-INF/classes /tmp/tests; \
    cd /tmp/classes; \
    jar xf /app/app.jar BOOT-INF/classes BOOT-INF/lib; \
    javac -classpath '/tmp/classes/BOOT-INF/classes:/tmp/classes/BOOT-INF/lib/*' \
      -d /tmp/patch/BOOT-INF/classes /tmp/src/*.java; \
    javac -classpath '/tmp/patch/BOOT-INF/classes:/tmp/classes/BOOT-INF/classes:/tmp/classes/BOOT-INF/lib/*' \
      -d /tmp/tests /tmp/tests-src/*.java; \
    java -ea -classpath '/tmp/tests:/tmp/patch/BOOT-INF/classes:/tmp/classes/BOOT-INF/classes:/tmp/classes/BOOT-INF/lib/*' \
      com.apitable.organization.controller.CommunityMemberPasswordControllerTest; \
    jar uf /app/app.jar -C /tmp/patch BOOT-INF/classes

FROM ${BASE_IMAGE} AS runner

LABEL org.opencontainers.image.title="APITable community collaboration backend"
LABEL org.opencontainers.image.version="v1.13.0-beta.1-ce-collaboration.4"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.source="https://github.com/apitable/apitable/tree/v1.13.0-beta.1"

COPY --from=verified /app/app.jar /app/app.jar
