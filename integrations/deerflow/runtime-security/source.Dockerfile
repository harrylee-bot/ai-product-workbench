# syntax=docker.m.daocloud.io/docker/dockerfile:1.7
# Keep the Dockerfile frontend on the runner's reachable registry mirror. The
# default docker.io endpoint intermittently fails during protected source builds.
# This immutable input contains only the current audited source snapshot.
# It has no executable entrypoint, OS packages, dependencies or runtime data.
FROM scratch AS source
LABEL org.opencontainers.image.title="Workbench 1.0.0 DeerFlow 2.1.0 source" \
      io.workbench.deerflow.source-archive-sha256="fdc0640200737fb2b3e1e4bf969d3b2f975ce378a3410a5ff851f03bfaa125c8" \
      io.workbench.deerflow.source-version="2.1.0" \
      io.workbench.deerflow.source-commit="345f08be00c8a9495079b732a39b46aa9af1584e"
ADD upstream-2.1.0/source.tar.gz /
