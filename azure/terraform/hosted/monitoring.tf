resource "azurerm_log_analytics_workspace" "runtime" {
  count = local.saved_logs ? 1 : 0

  name                            = "${var.name_prefix}-runtime-logs"
  location                        = azurerm_resource_group.edition[0].location
  resource_group_name             = azurerm_resource_group.edition[0].name
  sku                             = "PerGB2018"
  retention_in_days               = 30
  daily_quota_gb                  = 0.05
  local_authentication_enabled    = false
  allow_resource_only_permissions = false
  tags                            = local.tags
}

resource "azurerm_monitor_diagnostic_setting" "runtime" {
  count = local.saved_logs ? 1 : 0

  name                       = "predictir-runtime-logs"
  target_resource_id         = azurerm_container_app_environment.edition[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.runtime[0].id

  enabled_log {
    category_group = "allLogs"
  }
}

resource "azurerm_monitor_diagnostic_setting" "vault_audit" {
  count = local.saved_logs && var.live_secrets != null ? 1 : 0

  name                       = "predictir-vault-audit"
  target_resource_id         = var.live_secrets.vault_resource_id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.runtime[0].id

  enabled_log {
    category = "AuditEvent"
  }
}

resource "azurerm_user_assigned_identity" "readiness_alert" {
  count = local.readiness_alert ? 1 : 0

  name                = "${var.name_prefix}-readiness-alert"
  location            = local.location
  resource_group_name = azurerm_resource_group.edition[0].name
  tags                = local.tags
}

resource "azurerm_role_assignment" "readiness_alert_logs" {
  count = local.readiness_alert ? 1 : 0

  scope                            = azurerm_log_analytics_workspace.runtime[0].id
  role_definition_name             = "Log Analytics Reader"
  principal_id                     = azurerm_user_assigned_identity.readiness_alert[0].principal_id
  skip_service_principal_aad_check = true
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "database_readiness" {
  count = local.readiness_alert ? 1 : 0

  name                    = "${var.name_prefix}-database-readiness"
  display_name            = "Predictir database readiness"
  description             = "Three or more failed backend database checks spanning at least one minute after the most recent success, with a failure in the last 12 minutes."
  location                = local.location
  resource_group_name     = azurerm_resource_group.edition[0].name
  scopes                  = [azurerm_log_analytics_workspace.runtime[0].id]
  evaluation_frequency    = "PT15M"
  window_duration         = "PT15M"
  severity                = 2
  auto_mitigation_enabled = true
  tags                    = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.readiness_alert[0].id]
  }

  criteria {
    query                   = replace(file("${path.module}/../../monitoring/database-readiness-alert.kql"), "PREDICTIR_BACKEND_APP", local.app_names.backend)
    operator                = "GreaterThan"
    threshold               = 0
    time_aggregation_method = "Count"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  dynamic "action" {
    for_each = var.database_readiness_action_group_id == null ? [] : [var.database_readiness_action_group_id]
    content {
      action_groups = [action.value]
    }
  }

  depends_on = [azurerm_role_assignment.readiness_alert_logs, azurerm_monitor_diagnostic_setting.runtime]
}

resource "azurerm_monitor_metric_alert" "backend_memory" {
  count = local.runtime_metric_alert ? 1 : 0

  name                = "${var.name_prefix}-backend-memory"
  description         = "Average backend memory usage above 80 percent of its Container Apps replica limit for 15 minutes."
  resource_group_name = azurerm_resource_group.edition[0].name
  scopes              = [azurerm_container_app.backend[0].id]
  frequency           = "PT5M"
  window_size         = "PT15M"
  severity            = 2
  auto_mitigate       = true
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/containerapps"
    metric_name      = "MemoryPercentage"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }
}

locals {
  operations_queries = [
    { title = "API latency and errors · last 24 hours", file = "request-latency.kql" },
    { title = "Database readiness · last 24 hours", file = "database-readiness.kql" },
    { title = "Stream session lifetime · last 24 hours", file = "stream-sessions.kql" },
  ]
}

resource "azurerm_application_insights_workbook" "operations" {
  count = local.saved_logs && local.apps ? 1 : 0

  name                = uuidv5("url", lower("${azurerm_log_analytics_workspace.runtime[0].id}/predictir-operations"))
  display_name        = "Predictir operations"
  description         = "Backend API latency, database readiness, and stream session lifetime from existing Container Apps logs."
  resource_group_name = azurerm_resource_group.edition[0].name
  location            = local.location
  source_id           = lower(azurerm_log_analytics_workspace.runtime[0].id)
  tags                = local.tags

  data_json = jsonencode({
    "$schema" = "https://github.com/microsoft/Application-Insights-Workbooks/blob/master/schema/workbook.json"
    version   = "Notebook/1.0"
    items = concat([{
      type = 1
      name = "scope"
      content = {
        json = "# Predictir operations\nAPI latency covers completed backend requests. Client cancellations appear in a separate count. Tail percentiles are hidden below 20 samples for p95 and 100 for p99. Stream rows measure how long a connection stayed open. An empty result means this workspace recorded no matching telemetry in the window."
      }
      }], [
      for query in local.operations_queries : {
        type = 3
        name = trimsuffix(query.file, ".kql")
        content = {
          version                 = "KqlItem/1.0"
          query                   = replace(file("${path.module}/../../monitoring/${query.file}"), "PREDICTIR_BACKEND_APP", local.app_names.backend)
          size                    = 0
          title                   = query.title
          queryType               = 0
          resourceType            = "microsoft.operationalinsights/workspaces"
          crossComponentResources = [azurerm_log_analytics_workspace.runtime[0].id]
          timeContext             = { durationMs = 86400000 }
          visualization           = "table"
        }
      }
    ])
    fallbackResourceIds = [azurerm_log_analytics_workspace.runtime[0].id]
  })
}
