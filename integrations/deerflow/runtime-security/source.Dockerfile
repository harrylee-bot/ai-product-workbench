# syntax=docker.m.daocloud.io/docker/dockerfile:1.7
# Keep the Dockerfile frontend on the runner's reachable registry mirror. The
# default docker.io endpoint intermittently fails during owner-release builds.
# This immutable input contains only the current audited source snapshot.
# It has no executable entrypoint, OS packages, dependencies or runtime data.
FROM scratch AS source
LABEL org.opencontainers.image.title="Workbench 1.0.0 DeerFlow source" \
      io.workbench.deerflow.source-archive-sha256="b3f7a1c6831bbfbff7f6b45547b4c0c4149b44f322f24003dcd5d1f8012f43fb" \
      io.workbench.deerflow.source-image-id="sha256:78c39ad79eccee96b692fe5a03fa88095dc0aa339115c2857c5452bf89045655" \
      io.workbench.deerflow.source-commit="7a6c4a994a86583d2a3c056ee9d0f157d4f030c2"
ADD source.tar.gz /
