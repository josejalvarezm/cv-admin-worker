# CV Admin Worker Infrastructure
# Manages D1 database and custom domain for the Admin API

# Get account information
data "cloudflare_accounts" "main" {}

locals {
  account_id = data.cloudflare_accounts.main.accounts[0].id
}

# D1 Staging Database
# Stores commits, staged changes, and job orchestration data
resource "cloudflare_d1_database" "admin_staging" {
  account_id = local.account_id
  name       = var.database_name
}

# Data source to get Zone ID
data "cloudflare_zone" "main" {
  name = var.zone_name
}

# Custom Domain for Admin API Worker
# Routes api.admin.{YOUR_DOMAIN} to cv-admin-worker
resource "cloudflare_workers_domain" "admin_api" {
  account_id = local.account_id
  hostname   = var.custom_domain
  service    = var.worker_name
  zone_id    = data.cloudflare_zone.main.id
}

# Note: Worker script, Durable Objects, and bindings are managed via Wrangler CLI
# Terraform manages:
# - D1 database creation
# - Custom domain routing
# 
# Wrangler manages:
# - Worker deployment
# - Durable Object migrations
# - D1 database bindings
# - Secrets (WEBHOOK_SECRET, D1CV_API_URL, AI_AGENT_API_URL)
