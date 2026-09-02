# APITable Community Edition Web Server

This image is built from APITable `v1.13.0-beta.1` and adapts the Share >
Invite panel to the self-hosted node-role APIs supplied by the companion
Community backend image.

The self-hosted collaboration panel supports:

- Selecting existing members or teams and assigning file-level permissions
- Viewing and changing a file's collaborator permissions
- Copying the current file link for collaborators
- Opening the supported space invitation dialog for new members
- The separate Publish tab for public sharing
- Selecting teams that already have an invitation link and copying that link
  directly from the primary action
- Showing `产品工作台` / `Product Workbench` in the public form footer
- Showing the same product-workbench brand text in the public share footer,
  without the upstream APITable logo
- Replacing legacy `维格云` / `维格表` product names in public runtime assets,
  including share-link titles
- Clicking an attachment in either grid renderer opens the built-in online
  preview directly, without requiring a download first
- Rendering `.docx` attachments locally in the browser with the bundled
  Apache-2.0 `docx-preview` runtime

The commercial help entry and usage gate remain removed. The companion backend
implements the missing `/node/listRole`, `/node/collaborator/page`, and role
mutation endpoints with the open-source node-role services.

## Build

Copy this directory to `self-hosted-community-web/` inside the matching source
tree, then run:

```sh
docker build \
  --file self-hosted-community-web/Dockerfile \
  --tag workbench/apitable-web:v1.13.0-beta.1-ce-collaboration.14 \
  .
```

Upstream source:

- <https://github.com/apitable/apitable/tree/v1.13.0-beta.1>
- Commit: `ebf2e0830822336e3583b4be2802965da8eae922`

Deployed corresponding source:

- <https://requirements.aionbench.com/source/apitable-v1.13.0-beta.1-ce-collaboration.14-source.tar.gz>
- <https://requirements.aionbench.com/source/apitable-v1.13.0-beta.1-ce-collaboration.14-source.tar.gz.sha256>

APITable and this modification are licensed under AGPL-3.0-or-later.
