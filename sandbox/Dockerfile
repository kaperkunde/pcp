# PCP's sandbox: runs run_code's shell and Python programs beside PCP.
#
#   docker compose -f docker-compose.yaml -f docker-compose.sandbox.yaml up -d
#
# The compose file runs it with no network at all, a read-only file system,
# every capability dropped but changing user and group, and memory, process
# and CPU limits. It reaches PCP only through the socket PCP listens on in a
# volume they share; see sandbox/runner.py and lib/core/code/sandbox.ts.
#
# The runner runs as root with PCP's group (1001), which is what reaches
# that socket; each program runs as `program` (2000), which does not.
# /run/pcp has the owner and mode PCP's image gives the same volume, so it
# is the same whichever container mounts it first.

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash jq python3 coreutils findutils gawk sed grep diffutils \
    bc ca-certificates file gzip bzip2 xz-utils unzip zip less \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt \
  && groupadd --system --gid 2000 program \
  && useradd --system --uid 2000 --gid program --no-create-home \
    --home-dir /work --shell /usr/sbin/nologin program \
  && mkdir -p /run/pcp \
  && chown 1001:1001 /run/pcp \
  && chmod 0770 /run/pcp

COPY runner.py launcher.py pcp.py /opt/pcp-sandbox/
COPY bin/pcp /opt/pcp-sandbox/bin/pcp

ENV PCP_SANDBOX_SOCKET=/run/pcp/sandbox.sock \
    PCP_SANDBOX_WORK=/work \
    PCP_SANDBOX_UID=2000 \
    PYTHONDONTWRITEBYTECODE=1

USER 0:1001

CMD ["python3", "/opt/pcp-sandbox/runner.py"]
