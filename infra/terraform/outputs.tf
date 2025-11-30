output "d1_database_id" {
  description = "ID of the cv-admin-staging D1 database"
  value       = cloudflare_d1_database.admin_staging.id
}

output "d1_database_name" {
  description = "Name of the D1 database"
  value       = cloudflare_d1_database.admin_staging.name
}

output "custom_domain" {
  description = "Custom domain for the Admin API"
  value       = cloudflare_workers_domain.admin_api.hostname
}

output "zone_id" {
  description = "Cloudflare Zone ID"
  value       = data.cloudflare_zone.main.id
}
