# APITable Community Collaboration Backend

This image is based on the official APITable Community Edition backend at
`v1.13.0-beta.1`. It provides unrestricted self-hosted collaboration features
and restores the node-role HTTP controller omitted from the upstream Community
Edition controller set.

## Community plan behavior

- Seats: unrestricted (`Long.MAX_VALUE`, marked unlimited)
- File nodes: unlimited
- Rows per sheet: unlimited
- Archived rows per sheet: unlimited
- Total rows: unlimited
- Attachment capacity: 30 GiB safety limit
- Invitations, join applications, and sharing: enabled
- Enterprise-only SSO, audit, organization API, and branding features: unchanged
  and disabled
- File-level collaborators can be listed, added, edited, and removed through
  the existing open-source node-role services

The subscription response normalizes the unrestricted seat ceiling to `-1`,
so the client displays it as unlimited instead of rendering the raw Java limit.

## Build

```sh
docker build \
  --tag workbench/apitable-backend:v1.13.0-beta.1-ce-collaboration.3 \
  deploy/apitable-community-backend
```

The upstream source is available at:

- <https://github.com/apitable/apitable/tree/v1.13.0-beta.1>
- Commit: `ebf2e0830822336e3583b4be2802965da8eae922`

The deployed corresponding source is available at:

- <https://requirements.aionbench.com/source/apitable-v1.13.0-beta.1-ce-collaboration.3-source.tar.gz>

The modified source is in `src/`. APITable and this modification are licensed
under AGPL-3.0-or-later.

The source archive for the running deployment is published at:

- <https://requirements.aionbench.com/source/apitable-v1.13.0-beta.1-ce-collaboration.3-source.tar.gz>
- <https://requirements.aionbench.com/source/apitable-v1.13.0-beta.1-ce-collaboration.3-source.tar.gz.sha256>
