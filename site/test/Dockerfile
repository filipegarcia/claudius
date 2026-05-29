# Test rig for site/setup.sh on Linux. Ubuntu base with bash, zsh, and fish
# pre-installed so we can exercise rc-file detection for each shell.
#
# Used by site/test/test-docker.sh — mounts the working tree at /src and
# runs site/test/test-in-docker.sh as the unprivileged `test` user.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      zsh \
      fish \
      git \
      curl \
      ca-certificates \
      procps \
 && rm -rf /var/lib/apt/lists/* \
 && userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --shell /bin/bash test

USER test
WORKDIR /home/test

# test-in-docker.sh provisions its own stub `bun` at runtime, so the image
# itself doesn't need to pre-stage one. This keeps the in-rig script
# portable across this Docker rig and the GitHub Actions job.

ENTRYPOINT ["/bin/bash"]
