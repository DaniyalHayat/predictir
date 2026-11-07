# Azure edition

The Azure deployment uses the shared app in [`../web/`](../web/). Keep app fixes there so both deployments receive them.

- [`terraform/`](terraform/README.md): Container Apps, private PostgreSQL, networking, identities and monitoring.
- [`ops-ui/`](ops-ui/): Local React maintenance workbench for scoped checks and reviewable recommendations.
- [Maintenance guide](../docs/azure-maintenance-workbench.md): Workbench setup and usage.

Release from a reviewed commit on `main`. Build immutable images, run the edition and private-access checks, inspect the Terraform plan, and deploy those digests. Preserve the private backend, database network rules and existing Terraform state.
