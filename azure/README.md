# Azure edition

The Azure deployment uses the shared app in [`../web/`](../web/). Keep app fixes there so both deployments receive them.

- [`terraform/`](terraform/README.md): Container Apps, private PostgreSQL, networking, identities and monitoring.
- [`ops-ui/`](ops-ui/): Local React maintenance workbench for scoped checks and reviewable recommendations.
- [`build-task.yaml`](build-task.yaml): Bounded registry builds and runtime checks when local Docker is unavailable.
- [Maintenance guide](../docs/azure-maintenance-workbench.md): Workbench setup and usage.

Release from a reviewed commit on `main`. Build immutable images, run the edition and private-access checks, inspect the Terraform plan, and deploy those digests. Preserve the private backend, database network rules and existing Terraform state.

With private share access enabled, `live_access_requests` can add the owner review queue. Set `owner_hash_uri` to the versioned Key Vault secret containing the SHA-256 verifier of a separate random owner token. The optional `push` block takes the public VAPID key, the versioned Key Vault URI for its private key, and an HTTPS or mailto subject. The owner can enable phone alerts from `/access/manage` after release.
